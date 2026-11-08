import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeStatic from 'ffprobe-static'

const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

/** Prefers the bundled modern ffmpeg (vendor/ffmpeg, shipped as extraResources); the npm builds are a 2018 fallback. */
function vendored(name: 'ffmpeg' | 'ffprobe'): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const dirs = [join(process.resourcesPath ?? '', 'ffmpeg'), join(app.getAppPath(), 'vendor', 'ffmpeg')]
  return dirs.map((d) => join(d, exe)).find((p) => existsSync(p))
}

export const FFMPEG: string = vendored('ffmpeg') ?? unpacked(ffmpegInstaller.path)
export const FFPROBE: string = vendored('ffprobe') ?? unpacked(ffprobeStatic.path)
/** Modern builds decode HEIC tile grids natively (~250 ms for 24 MP); the 2018 fallback cannot. */
export const FFMPEG_HEIC = FFMPEG !== unpacked(ffmpegInstaller.path)

export interface ProbeStream {
  codec_type: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  nb_frames?: string
  duration?: string
  color_transfer?: string
  color_primaries?: string
  pix_fmt?: string
  bit_rate?: string
  channels?: number
  sample_rate?: string
  tags?: Record<string, string>
  side_data_list?: { side_data_type?: string; rotation?: number; dv_profile?: number }[]
}

export interface Probe {
  format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> }
  streams?: ProbeStream[]
}

export function ffprobe(path: string): Promise<Probe> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({})
        try { resolve(JSON.parse(stdout)) } catch { resolve({}) }
      }
    )
  })
}

export function ffmpeg(args: string[], onProgress?: (seconds: number) => void, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const progress = onProgress ? ['-progress', 'pipe:1', '-nostats'] : []
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...progress, ...args], { windowsHide: true, cwd })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    if (onProgress) {
      p.stdout.on('data', (d: Buffer) => {
        const m = /out_time_us=(\d+)/.exec(d.toString())
        if (m) onProgress(Number(m[1]) / 1e6)
      })
    }
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))))
  })
}
