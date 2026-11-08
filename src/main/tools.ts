import { execFile, spawn } from 'node:child_process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeStatic from 'ffprobe-static'

const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

export const FFMPEG: string = unpacked(ffmpegInstaller.path)
export const FFPROBE: string = unpacked(ffprobeStatic.path)

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

export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))))
  })
}
