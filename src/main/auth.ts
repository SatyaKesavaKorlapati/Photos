import { systemPreferences, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'

export type AuthResult = 'ok' | 'cancelled' | 'unavailable'

/**
 * WinRT UserConsentVerifier through Windows PowerShell 5.1 (pwsh 7 lacks the WinRT projection).
 * RequestVerificationForWindowAsync parents the prompt to our window; the plain call from a
 * background process opens it behind the app.
 */
function helloScript(message: string, checkOnly: boolean, hwnd = 0n): string {
  const msg = message.replace(/'/g, "''")
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ("$avail" -ne 'Available') { Write-Output "unavailable:$avail"; exit 0 }
${checkOnly ? "Write-Output 'available'; exit 0" : ''}
$resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
$op = $null
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HelloInterop {
  [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  interface IUserConsentVerifierInterop {
    [PreserveSig] int RequestVerificationForWindowAsync(IntPtr appWindow, IntPtr message, [In] ref Guid riid, out IntPtr asyncOperation);
  }
  [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int len, out IntPtr h);
  [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr h);
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, [In] ref Guid iid, out IntPtr factory);
  public static object Request(long hwnd, string message, Guid riid) {
    const string name = "Windows.Security.Credentials.UI.UserConsentVerifier";
    IntPtr cls, msg, fac, op;
    Marshal.ThrowExceptionForHR(WindowsCreateString(name, name.Length, out cls));
    Marshal.ThrowExceptionForHR(WindowsCreateString(message, message.Length, out msg));
    try {
      Guid iid = typeof(IUserConsentVerifierInterop).GUID;
      Marshal.ThrowExceptionForHR(RoGetActivationFactory(cls, ref iid, out fac));
      try {
        var f = (IUserConsentVerifierInterop)Marshal.GetObjectForIUnknown(fac);
        Marshal.ThrowExceptionForHR(f.RequestVerificationForWindowAsync(new IntPtr(hwnd), msg, ref riid, out op));
      } finally { Marshal.Release(fac); }
      try { return Marshal.GetObjectForIUnknown(op); } finally { Marshal.Release(op); }
    } finally { WindowsDeleteString(msg); WindowsDeleteString(cls); }
  }
}
'@
  $riid = [Windows.Foundation.IAsyncOperation[Windows.Security.Credentials.UI.UserConsentVerificationResult]].GUID
  if (${hwnd}L -ne 0) { $op = [HelloInterop]::Request(${hwnd}L, '${msg}', $riid) }
} catch { $op = $null }
if ($null -eq $op) { $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${msg}') }
$r = Await $op $resultType
Write-Output "result:$r"
`
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 120000 },
      (_err, stdout) => resolve(String(stdout ?? '').trim())
    )
  })
}

let cachedAvailability: Promise<boolean> | null = null
export function systemAuthAvailable(): Promise<boolean> {
  if (process.platform === 'darwin') return Promise.resolve(systemPreferences.canPromptTouchID())
  if (process.platform !== 'win32') return Promise.resolve(false)
  return (cachedAvailability ??= runPowerShell(helloScript('', true)).then((o) => o.includes('available') && !o.includes('unavailable')))
}

export async function systemAuth(win: BrowserWindow | null, reason: string): Promise<AuthResult> {
  if (process.platform === 'darwin') {
    if (!systemPreferences.canPromptTouchID()) return 'unavailable'
    try {
      await systemPreferences.promptTouchID(reason)
      return 'ok'
    } catch {
      return 'cancelled'
    }
  }
  if (process.platform !== 'win32') return 'unavailable'
  const handle = win?.getNativeWindowHandle()
  const hwnd = handle ? (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))) : 0n
  const wasTop = win?.isAlwaysOnTop()
  win?.setAlwaysOnTop(false)
  const out = await runPowerShell(helloScript(reason, false, hwnd))
  if (wasTop) win?.setAlwaysOnTop(true)
  win?.focus()
  if (out.includes('unavailable')) return 'unavailable'
  return /result:Verified/.test(out) ? 'ok' : 'cancelled'
}
