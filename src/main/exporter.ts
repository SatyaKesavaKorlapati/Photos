import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import sharp from 'sharp'
import { getDb } from './db'
import { hevcArgs } from './editRender'
import { displayPath, getRenderRow } from './render'
import { FFMPEG, ffmpeg, ffprobe } from './tools'

export type PhotoFormat = 'jpeg' | 'png' | 'tiff' | 'heic' | 'avif' | 'webp'
export type VideoFormat = 'original' | 'h264' | 'hevc' | 'mov' | 'webm' | 'gif'

export interface ExportOptions {
  unmodified: boolean
  photoFormat: PhotoFormat
  quality: number
  size: 'full' | 'large' | 'medium' | 'small' | 'custom'
  maxDim?: number
  colorProfile: 'p3' | 'srgb'
  includeMetadata: boolean
  videoFormat: VideoFormat
  videoQuality: 'original' | '2160' | '1080' | '720' | '480'
  includeLive: boolean
  fileName: 'file' | 'title' | 'sequential'
  prefix?: string
  subfolder: 'none' | 'day'
}

export interface ExportProgress { done: number; total: number; current?: string; files: number; bytes: number; skipped?: string[]; dir?: string }

const SIZE: Record<string, number> = { small: 640, medium: 1280, large: 2048 }
const NATIVE_EXT: Record<PhotoFormat, string[]> = {
  jpeg: ['.jpg', '.jpeg'], png: ['.png'], tiff: ['.tif', '.tiff'], heic: ['.heic', '.heif'], avif: ['.avif'], webp: ['.webp']
}
const OUT_EXT: Record<PhotoFormat, string> = { jpeg: '.jpg', png: '.png', tiff: '.tif', heic: '.heic', avif: '.avif', webp: '.webp' }

async function uniqueDest(dir: string, name: string): Promise<string> {
  let dest = join(dir, name)
  let n = 1
  while (existsSync(dest)) dest = join(dir, `${basename(name, extname(name))} (${n++})${extname(name)}`)
  return dest
}

function decodeHeif(src: string): Promise<{ data: Buffer; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-c:v', 'pam', '-pix_fmt', 'rgb24', '-f', 'image2pipe', '-'], { windowsHide: true })
    const chunks: Buffer[] = []
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.on('error', reject)
    p.on('close', (code) => {
      const out = Buffer.concat(chunks)
      const end = out.indexOf('ENDHDR\n')
      if (code !== 0 || end < 0) return reject(new Error('could not decode HEIC'))
      const head = out.subarray(0, end).toString('latin1')
      resolve({ data: out.subarray(end + 7), width: Number(/WIDTH (\d+)/.exec(head)?.[1]), height: Number(/HEIGHT (\d+)/.exec(head)?.[1]) })
    })
  })
}

/** Opens any library image as a colour-tagged sharp pipeline. HEIC pixels are Display P3. */
async function openForExport(src: string): Promise<ReturnType<typeof sharp>> {
  const ext = extname(src).toLowerCase()
  if (ext === '.heic' || ext === '.heif') {
    const d = await decodeHeif(src)
    const tagged = await sharp(d.data, { raw: { width: d.width, height: d.height, channels: 3 } }).withIccProfile('p3').png({ compressionLevel: 0 }).toBuffer()
    return sharp(tagged)
  }
  return sharp(src, { failOn: 'none', animated: false }).rotate()
}

const exifDate = (t: number): string => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const VIDEO_H: Record<string, number> = { '2160': 2160, '1080': 1080, '720': 720, '480': 480 }

function tonemap(): string {
  return 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'
}

async function exportVideo(src: string, dest: string, o: ExportOptions): Promise<void> {
  const probe = await ffprobe(src)
  const v = probe.streams?.find((s) => s.codec_type === 'video')
  const hasAudio = !!probe.streams?.some((s) => s.codec_type === 'audio')
  const hdr = v?.color_transfer === 'arib-std-b67' || v?.color_transfer === 'smpte2084'
  const target = VIDEO_H[o.videoQuality]
  const scale = target ? `scale=-2:'min(${target},ih)':flags=lanczos` : ''
  const audio = (codec: string[]) => (hasAudio ? codec : ['-an'])
  const vf = (...parts: string[]) => {
    const f = parts.filter(Boolean).join(',')
    return f ? ['-vf', f] : []
  }
  switch (o.videoFormat) {
    case 'h264':
      return ffmpeg(['-i', src, ...vf(scale, hdr ? tonemap() : ''), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
        ...audio(['-c:a', 'aac', '-b:a', '192k']), '-map_metadata', '0', '-movflags', '+faststart', dest])
    case 'hevc':
    case 'mov':
      return ffmpeg(['-i', src, ...vf(scale), ...(await hevcArgs(v)), ...audio(['-c:a', 'aac', '-b:a', '256k']), '-map_metadata', '0',
        '-movflags', '+faststart', dest])
    case 'webm':
      return ffmpeg(['-i', src, ...vf(scale, hdr ? tonemap() : ''), '-c:v', 'libvpx-vp9', '-crf', '31', '-b:v', '0', '-row-mt', '1', '-deadline', 'good',
        '-cpu-used', '3', ...audio(['-c:a', 'libopus', '-b:a', '160k']), dest])
    case 'gif': {
      const h = Math.min(target ?? 480, 480)
      const base = `fps=15,scale=-2:'min(${h},ih)':flags=lanczos${hdr ? ',' + tonemap() : ''}`
      return ffmpeg(['-i', src, '-filter_complex', `[0:v]${base},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, '-loop', '0', dest])
    }
    default:
      await copyFile(src, dest)
  }
}

const VIDEO_EXT: Record<VideoFormat, string> = { original: '', h264: '.mp4', hevc: '.mp4', mov: '.mov', webm: '.webm', gif: '.gif' }

export async function runExport(ids: number[], dir: string, o: ExportOptions, onProgress: (p: ExportProgress) => void): Promise<ExportProgress> {
  const prog: ExportProgress = { done: 0, total: ids.length, files: 0, bytes: 0, skipped: [], dir }
  await mkdir(dir, { recursive: true })
  let seq = 0
  for (const id of ids) {
    const row = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, any> | undefined
    const r = getRenderRow(id)
    if (!row || !r) continue
    prog.current = row.name
    onProgress({ ...prog })
    let outDir = dir
    if (o.subfolder === 'day') {
      const d = new Date(row.taken_at)
      outDir = join(dir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
      await mkdir(outDir, { recursive: true })
    }
    seq++
    const stem =
      o.fileName === 'title' && row.title ? String(row.title).replace(/[\\/:*?"<>|]/g, '_')
        : o.fileName === 'sequential' ? `${o.prefix || 'Photo'} ${String(seq).padStart(String(ids.length).length, '0')}`
          : basename(row.name, extname(row.name))
    const add = async (p: string) => {
      prog.files++
      prog.bytes += (await stat(p)).size
    }
    try {
      if (o.unmodified) {
        const list: string[] = [row.original_path, row.edited_path, row.live_path, row.live_edited_path, row.aae_path, ...JSON.parse(row.sidecars || '[]')].filter(Boolean)
        for (const src of list) {
          const dest = await uniqueDest(outDir, o.fileName === 'file' ? basename(src) : `${stem}${list.length > 1 && src !== row.original_path ? ` (${basename(src)})` : ''}${extname(src)}`)
          await copyFile(src, dest)
          await add(dest)
        }
      } else if (r.kind === 'video') {
        const src = displayPath(r)
        const ext = o.videoFormat === 'original' ? extname(src) : VIDEO_EXT[o.videoFormat]
        const dest = await uniqueDest(outDir, `${stem}${ext}`)
        await exportVideo(src, dest, o)
        await add(dest)
      } else {
        const src = displayPath(r)
        const srcExt = extname(src).toLowerCase()
        const edited = !!r.user_render
        let fmt = o.photoFormat
        const fullSize = o.size === 'full'
        const sameFormat = NATIVE_EXT[fmt].includes(srcExt)
        if (fmt === 'heic' && !(sameFormat && fullSize && !edited)) {
          prog.skipped!.push(`${row.name}: HEIC can only be exported unchanged; saved as JPEG`)
          fmt = 'jpeg'
        }
        if (sameFormat && fullSize && o.includeMetadata && !edited && (fmt === 'heic' || o.colorProfile === 'p3')) {
          const dest = await uniqueDest(outDir, `${stem}${extname(src)}`)
          await copyFile(src, dest)
          await add(dest)
        } else {
          let img = await openForExport(src)
          const max = o.size === 'custom' ? o.maxDim : SIZE[o.size]
          if (max) img = img.resize(max, max, { fit: 'inside', withoutEnlargement: true })
          img = o.colorProfile === 'srgb' ? img.toColourspace('srgb').withIccProfile('srgb') : img.withIccProfile('p3')
          if (o.includeMetadata) {
            const IFD0: Record<string, string> = { DateTime: exifDate(row.taken_at) }
            if (row.make) IFD0.Make = row.make
            if (row.model) IFD0.Model = row.model
            if (row.caption || row.title) IFD0.ImageDescription = String(row.caption || row.title)
            IFD0.Software = 'Photos'
            const IFD2: Record<string, string> = { DateTimeOriginal: exifDate(row.taken_at) }
            if (row.lens) IFD2.LensModel = row.lens
            img = img.withExif({ IFD0, IFD2 })
          }
          const q = Math.round(o.quality)
          if (fmt === 'jpeg') img = img.flatten({ background: '#000' }).jpeg({ quality: q, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0' })
          else if (fmt === 'png') img = img.png({ compressionLevel: 6 })
          else if (fmt === 'tiff') img = img.tiff({ compression: 'lzw' })
          else if (fmt === 'avif') img = img.avif({ quality: Math.max(30, q - 20), effort: 4 })
          else if (fmt === 'webp') img = img.webp({ quality: q })
          const dest = await uniqueDest(outDir, `${stem}${OUT_EXT[fmt]}`)
          await img.toFile(dest)
          await add(dest)
        }
        const live = r.user_live_render ?? r.live_edited_path ?? r.live_path
        if (o.includeLive && live) {
          const ext = o.videoFormat === 'original' ? extname(live) : VIDEO_EXT[o.videoFormat]
          const dest = await uniqueDest(outDir, `${stem}${ext}`)
          await exportVideo(live, dest, o)
          await add(dest)
        }
      }
    } catch (e) {
      prog.skipped!.push(`${row.name}: ${(e as Error).message.split('\n')[0]}`)
    }
    prog.done++
    onProgress({ ...prog })
  }
  prog.current = undefined
  return prog
}
