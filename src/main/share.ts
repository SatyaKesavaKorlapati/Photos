import { app, ShareMenu, nativeImage, shell, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { getDb } from './db'
import { runExport, type ExportOptions } from './exporter'
import { getRenderRow } from './render'
import { getSettings, setSettings } from './settings'
import { ffprobe } from './tools'

/**
 * Sharing hands files to other apps without the Export flow: the system share sheet, Blip
 * recipients, WhatsApp, the clipboard, and user-added connections (apps and folders).
 */

export type ConnectionKind = 'system' | 'blip' | 'whatsapp' | 'clipboard' | 'app' | 'folder'

export interface ShareConnection {
  id: string
  kind: ConnectionKind
  name: string
  enabled: boolean
  /** app: executable; folder: destination directory */
  path?: string
  /** app: argument template; {files} expands to every file, {file} to the first */
  args?: string
}

export interface ShareDestination {
  id: string
  connection: string
  kind: ConnectionKind
  title: string
  subtitle?: string
  icon?: string
  /** Blip recipient name (a person or device), or undefined for the recipient picker */
  peer?: string
  person?: boolean
}

export const DEFAULT_CONNECTIONS: ShareConnection[] = [
  { id: 'system', kind: 'system', name: process.platform === 'darwin' ? 'Share Menu' : 'Windows Share', enabled: true },
  { id: 'blip', kind: 'blip', name: 'Blip', enabled: true },
  { id: 'whatsapp', kind: 'whatsapp', name: 'WhatsApp', enabled: true },
  { id: 'clipboard', kind: 'clipboard', name: 'Copy Files', enabled: true }
]

export function connections(): ShareConnection[] {
  const saved = getSettings().shareConnections ?? []
  const out = [...saved]
  for (const d of DEFAULT_CONNECTIONS) if (!out.some((c) => c.id === d.id)) out.push(d)
  return out
}

const blipRoot = (): string | undefined => {
  const base = join(process.env.LOCALAPPDATA ?? '', 'BlipShell')
  try {
    const dir = readdirSync(base).find((d) => d.startsWith('BlipStudioInc.BlipApp_'))
    return dir ? join(base, dir) : undefined
  } catch {
    return undefined
  }
}

interface BlipSettings { enabled?: boolean; devices?: { name: string; icon?: string }[]; people?: { name: string; icon?: string }[] }

function blipSettings(): BlipSettings | null {
  const root = blipRoot()
  if (!root) return null
  try {
    return JSON.parse(readFileSync(join(root, 'shell-settings.json'), 'utf8')) as BlipSettings
  } catch {
    return null
  }
}

const WHATSAPP_PACKAGE = '5319275A.WhatsAppDesktop_cv1g1gvanyjgm'
const whatsappInstalled = (): boolean => existsSync(join(process.env.LOCALAPPDATA ?? '', 'Packages', WHATSAPP_PACKAGE))

const iconCache = new Map<string, string>()
async function fileIcon(path: string): Promise<string | undefined> {
  if (iconCache.has(path)) return iconCache.get(path)
  try {
    let img = nativeImage.createFromPath(path)
    if (img.isEmpty()) img = await app.getFileIcon(path, { size: 'large' })
    const url = img.isEmpty() ? undefined : img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL()
    if (url) iconCache.set(path, url)
    return url
  } catch {
    return undefined
  }
}

/** Everything the share sheet can offer right now, in connection order. */
export async function destinations(): Promise<ShareDestination[]> {
  const out: ShareDestination[] = []
  for (const c of connections()) {
    if (!c.enabled) continue
    switch (c.kind) {
      case 'system':
        if (process.platform === 'win32' || process.platform === 'darwin') {
          out.push({ id: c.id, connection: c.id, kind: c.kind, title: process.platform === 'darwin' ? 'More…' : 'Windows', subtitle: 'Nearby Share, Mail, Phone Link and installed apps' })
        }
        break
      case 'blip': {
        const s = blipSettings()
        if (!s || s.enabled === false) break
        for (const p of [...(s.devices ?? []), ...(s.people ?? [])]) {
          out.push({
            id: `blip:${p.name}`, connection: c.id, kind: c.kind, title: p.name, subtitle: 'Blip', peer: p.name,
            person: (s.people ?? []).includes(p), icon: p.icon ? await fileIcon(p.icon) : undefined
          })
        }
        out.push({ id: 'blip:', connection: c.id, kind: c.kind, title: 'Blip', subtitle: 'Choose a recipient' })
        break
      }
      case 'whatsapp':
        out.push({ id: c.id, connection: c.id, kind: c.kind, title: 'WhatsApp', subtitle: whatsappInstalled() ? 'Opens WhatsApp — paste into a chat' : 'Opens WhatsApp Web — paste into a chat' })
        break
      case 'clipboard':
        out.push({ id: c.id, connection: c.id, kind: c.kind, title: 'Copy Files', subtitle: 'Paste into any app' })
        break
      case 'app':
        if (c.path && existsSync(c.path)) out.push({ id: c.id, connection: c.id, kind: c.kind, title: c.name, subtitle: 'App', icon: await fileIcon(c.path) })
        break
      case 'folder':
        if (c.path) out.push({ id: c.id, connection: c.id, kind: c.kind, title: c.name, subtitle: c.path })
        break
    }
  }
  return out
}

// ---------- preparing files ----------

const shareRoot = (): string => join(tmpdir(), 'PhotosShare')

async function sweepOld(): Promise<void> {
  try {
    for (const d of await readdir(shareRoot())) {
      const p = join(shareRoot(), d)
      if (Date.now() - (await stat(p)).mtimeMs > 6 * 3600e3) await rm(p, { recursive: true, force: true })
    }
  } catch { /* nothing to sweep */ }
}

/** Files to hand over: the current version as-is, or a widely compatible copy (JPEG / H.264). */
export async function prepareFiles(ids: number[], onProgress?: (p: number) => void): Promise<string[]> {
  const s = getSettings()
  await sweepOld()
  const dir = join(shareRoot(), String(Date.now()))
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  const convert: number[] = []
  for (const id of ids) {
    const r = getRenderRow(id)
    if (!r) continue
    const row = getDb().prepare('SELECT name FROM assets WHERE id = ?').get(id) as { name: string }
    const current = r.user_render ?? r.edited_path ?? r.original_path
    const live = r.user_live_render ?? r.live_edited_path ?? r.live_path
    if (s.shareFormat === 'original') {
      // In-app renders have internal names; give them the photo's name.
      if (r.user_render) {
        const dest = join(dir, `${basename(row.name, extname(row.name))}${extname(current)}`)
        await copyFile(current, dest)
        files.push(dest)
      } else files.push(current)
      if (s.shareIncludeLive && live && r.kind === 'photo') files.push(live)
      continue
    }
    const ext = extname(current).toLowerCase()
    if (r.kind === 'photo' && ['.jpg', '.jpeg', '.png'].includes(ext) && !r.user_render && s.shareMaxSize === 'full') {
      files.push(current)
    } else if (r.kind === 'video') {
      const v = (await ffprobe(current)).streams?.find((x) => x.codec_type === 'video')
      const sdr = v?.color_transfer !== 'arib-std-b67' && v?.color_transfer !== 'smpte2084'
      if (v?.codec_name === 'h264' && sdr && s.shareVideoQuality === 'original') files.push(current)
      else convert.push(id)
    } else convert.push(id)
    if (s.shareIncludeLive && live && r.kind === 'photo' && !convert.includes(id)) convert.push(id)
  }
  if (convert.length) {
    const opts: ExportOptions = {
      unmodified: false, photoFormat: 'jpeg', quality: 90, size: s.shareMaxSize === 'large' ? 'large' : 'full', colorProfile: 'srgb',
      includeMetadata: s.shareIncludeMetadata, videoFormat: 'h264', videoQuality: s.shareVideoQuality, includeLive: s.shareIncludeLive,
      fileName: 'file', subfolder: 'none'
    }
    await runExport(convert, dir, opts, (p) => onProgress?.(p.done / Math.max(1, p.total)))
    for (const f of await readdir(dir)) {
      const p = join(dir, f)
      if (!files.includes(p)) files.push(p)
    }
  }
  return files
}

// ---------- handing files over ----------

const SHARE_PS = String.raw`
$ErrorActionPreference = 'Stop'
$mode = $env:PHOTOS_SHARE_MODE
$paths = Get-Content -LiteralPath $env:PHOTOS_SHARE_LIST -Encoding UTF8 | Where-Object { $_ }
if ($mode -eq 'clip') { Set-Clipboard -LiteralPath $paths; 'ok'; exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PhotosShare {
  [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDataTransferManagerInterop {
    [PreserveSig] int GetForWindow(IntPtr appWindow, [In] ref Guid riid, out IntPtr dtm);
    [PreserveSig] int ShowShareUIForWindow(IntPtr appWindow);
  }
  [ComImport, Guid("a08ce4d0-fa25-44ab-b57c-c7b1c323e0b9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IExplorerCommand {
    [PreserveSig] int GetTitle(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int GetIcon(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] out string icon);
    [PreserveSig] int GetToolTip(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] out string tip);
    [PreserveSig] int GetCanonicalName(out Guid g);
    [PreserveSig] int GetState(IntPtr items, [MarshalAs(UnmanagedType.Bool)] bool slow, out uint state);
    [PreserveSig] int Invoke(IntPtr items, IntPtr bc);
    [PreserveSig] int GetFlags(out uint flags);
    [PreserveSig] int EnumSubCommands(out IEnumExplorerCommand e);
  }
  [ComImport, Guid("a88826f8-186f-4987-aade-ea0cef8fbfe8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumExplorerCommand {
    [PreserveSig] int Next(uint n, out IExplorerCommand cmd, out uint fetched);
  }
  [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int len, out IntPtr h);
  [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr h);
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, [In] ref Guid iid, out IntPtr factory);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bc, out IntPtr pidl, uint sfgao, out uint attrs);
  [DllImport("shell32.dll")] static extern int SHCreateShellItemArrayFromIDLists(uint n, IntPtr[] pidls, out IntPtr arr);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L, T, R, B; }

  static IDataTransferManagerInterop Factory() {
    const string name = "Windows.ApplicationModel.DataTransfer.DataTransferManager";
    IntPtr cls, fac;
    Marshal.ThrowExceptionForHR(WindowsCreateString(name, name.Length, out cls));
    try {
      Guid iid = typeof(IDataTransferManagerInterop).GUID;
      Marshal.ThrowExceptionForHR(RoGetActivationFactory(cls, ref iid, out fac));
      try { return (IDataTransferManagerInterop)Marshal.GetObjectForIUnknown(fac); } finally { Marshal.Release(fac); }
    } finally { WindowsDeleteString(cls); }
  }
  public static object Manager(IntPtr hwnd) {
    Guid riid = new Guid("a5caee9b-8708-49d1-8d36-67d25a8da00c");
    IntPtr p;
    Marshal.ThrowExceptionForHR(Factory().GetForWindow(hwnd, ref riid, out p));
    try { return Marshal.GetObjectForIUnknown(p); } finally { Marshal.Release(p); }
  }
  public static void ShowUI(IntPtr hwnd) { Marshal.ThrowExceptionForHR(Factory().ShowShareUIForWindow(hwnd)); }

  /** Runs a Blip Explorer verb: the recipient whose title matches, else the recipient picker (last item). */
  public static string Blip(string[] paths, string peer) {
    var pidls = new IntPtr[paths.Length];
    uint a;
    for (int i = 0; i < paths.Length; i++) Marshal.ThrowExceptionForHR(SHParseDisplayName(paths[i], IntPtr.Zero, out pidls[i], 0, out a));
    IntPtr items;
    Marshal.ThrowExceptionForHR(SHCreateShellItemArrayFromIDLists((uint)paths.Length, pidls, out items));
    var root = (IExplorerCommand)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("160a73d9-5263-41b8-b9c7-930db8da5d5c")));
    IEnumExplorerCommand e;
    Marshal.ThrowExceptionForHR(root.EnumSubCommands(out e));
    IExplorerCommand sub, pick = null, last = null; uint n; string t;
    while (e.Next(1, out sub, out n) == 0 && n == 1) {
      uint f; sub.GetFlags(out f);
      if ((f & 8) != 0) continue;
      sub.GetTitle(items, out t);
      last = sub;
      if (!string.IsNullOrEmpty(peer) && t == peer) pick = sub;
    }
    var cmd = pick ?? last;
    if (cmd == null) return "none";
    Marshal.ThrowExceptionForHR(cmd.Invoke(items, IntPtr.Zero));
    return pick != null ? "sent" : "picker";
  }
}
'@
if ($mode -eq 'blip') { [PhotosShare]::Blip([string[]]$paths, $env:PHOTOS_SHARE_PEER); Start-Sleep -Milliseconds 800; exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$null = [Windows.ApplicationModel.DataTransfer.DataTransferManager, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$items = New-Object 'System.Collections.Generic.List[Windows.Storage.IStorageItem]'
foreach ($p in $paths) { $items.Add((Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile]))) }
$owner = [IntPtr][long]$env:PHOTOS_SHARE_OWNER
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'; $form.ShowInTaskbar = $false; $form.StartPosition = 'Manual'; $form.TopMost = $true
$form.Size = New-Object System.Drawing.Size(4, 4); $form.Opacity = 0.01
$r = New-Object PhotosShare+RECT
if ($owner -ne [IntPtr]::Zero -and [PhotosShare]::GetWindowRect($owner, [ref]$r)) {
  $form.Location = New-Object System.Drawing.Point([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2))
}
$form.add_Shown({
  try {
    if ($owner -ne [IntPtr]::Zero) { [void][PhotosShare]::SetWindowLongPtr($form.Handle, -8, $owner) }
    [void][PhotosShare]::SetForegroundWindow($form.Handle)
    $dtm = [PhotosShare]::Manager($form.Handle)
    $dtm.add_DataRequested({
      param($s, $e)
      $pkg = $e.Request.Data
      $pkg.Properties.Title = $env:PHOTOS_SHARE_TITLE
      $pkg.SetStorageItems($items)
      try { $pkg.add_ShareCompleted({ param($a, $b) [Console]::Out.WriteLine('completed'); $form.Close() }) } catch {}
      try { $pkg.add_ShareCanceled({ param($a, $b) [Console]::Out.WriteLine('canceled'); $form.Close() }) } catch {}
      [Console]::Out.WriteLine('requested')
    })
    [PhotosShare]::ShowUI($form.Handle)
    [Console]::Out.WriteLine('shown')
  } catch { [Console]::Out.WriteLine('error ' + $_); $form.Close() }
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 600000
$timer.add_Tick({ $form.Close() })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`

function runShareScript(env: Record<string, string>, wait: (line: string) => boolean, timeout = 20000): Promise<string> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(SHARE_PS, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, env: { ...process.env, ...env }
    })
    let out = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve(out)
    }
    const t = setTimeout(finish, timeout)
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.split(/\r?\n/).some(wait)) finish()
    })
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', finish)
    p.on('error', finish)
  })
}

async function withList<T>(paths: string[], fn: (list: string) => Promise<T>): Promise<T> {
  const list = join(shareRoot(), `list-${Date.now()}.txt`)
  await mkdir(shareRoot(), { recursive: true })
  await writeFile(list, '\ufeff' + paths.join('\r\n'), 'utf8')
  try {
    return await fn(list)
  } finally {
    setTimeout(() => rm(list, { force: true }).catch(() => undefined), 30000)
  }
}

const hwndOf = (win: BrowserWindow | null): string => {
  const h = win?.getNativeWindowHandle()
  return h ? String(h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0))) : '0'
}

export interface ShareResult { ok: boolean; message?: string }

export async function shareFiles(files: string[], destId: string, win: BrowserWindow | null, title: string): Promise<ShareResult> {
  if (!files.length) return { ok: false, message: 'Nothing to share' }
  const all = await destinations()
  const d = all.find((x) => x.id === destId)
  if (!d) return { ok: false, message: 'That connection is not available' }
  const c = connections().find((x) => x.id === d.connection)
  switch (d.kind) {
    case 'system': {
      if (process.platform === 'darwin') {
        new ShareMenu({ filePaths: files }).popup({ window: win ?? undefined })
        return { ok: true }
      }
      const out = await withList(files, (list) =>
        runShareScript({ PHOTOS_SHARE_MODE: 'system', PHOTOS_SHARE_LIST: list, PHOTOS_SHARE_OWNER: hwndOf(win), PHOTOS_SHARE_TITLE: title }, (l) => /^(shown|error)/.test(l))
      )
      return /shown/.test(out) ? { ok: true } : { ok: false, message: out.match(/error (.*)/)?.[1] ?? 'The share sheet did not open' }
    }
    case 'blip': {
      const out = await withList(files, (list) => runShareScript({ PHOTOS_SHARE_MODE: 'blip', PHOTOS_SHARE_LIST: list, PHOTOS_SHARE_PEER: d.peer ?? '' }, (l) => /^(sent|picker|none)$/.test(l.trim())))
      if (/sent/.test(out)) return { ok: true, message: `Sending to ${d.peer} with Blip` }
      if (/picker/.test(out)) return { ok: true, message: 'Choose who to send to in Blip' }
      return { ok: false, message: 'Blip could not be reached. Is it running?' }
    }
    case 'whatsapp':
    case 'clipboard': {
      const out = await withList(files, (list) => runShareScript({ PHOTOS_SHARE_MODE: 'clip', PHOTOS_SHARE_LIST: list }, (l) => l.trim() === 'ok'))
      if (!/ok/.test(out)) return { ok: false, message: 'Could not copy the files' }
      if (d.kind === 'clipboard') return { ok: true, message: `${files.length} file${files.length === 1 ? '' : 's'} copied — paste anywhere` }
      if (whatsappInstalled()) await shell.openExternal('whatsapp://')
      else await shell.openExternal('https://web.whatsapp.com/')
      return { ok: true, message: 'Copied — open a chat in WhatsApp and press Ctrl+V' }
    }
    case 'app': {
      if (!c?.path) return { ok: false, message: 'App not found' }
      const tpl = (c.args?.trim() || '{files}').split(/\s+/)
      const args = tpl.flatMap((a) => (a === '{files}' ? files : a === '{file}' ? [files[0]] : [a]))
      spawn(c.path, args, { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, message: `Opened in ${c.name}` }
    }
    case 'folder': {
      if (!c?.path) return { ok: false, message: 'Folder not set' }
      await mkdir(c.path, { recursive: true })
      for (const f of files) {
        let dest = join(c.path, basename(f))
        for (let n = 1; existsSync(dest); n++) dest = join(c.path, `${basename(f, extname(f))} (${n})${extname(f)}`)
        await copyFile(f, dest)
      }
      return { ok: true, message: `Saved to ${c.name}` }
    }
  }
}

export function saveConnections(list: ShareConnection[]): ShareConnection[] {
  setSettings({ shareConnections: list })
  return connections()
}
