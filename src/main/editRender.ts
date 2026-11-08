import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { getDb } from './db'
import { editBasePath, getRenderRow, invalidateCache } from './render'
import { spawn } from 'node:child_process'
import { FFMPEG, ffmpeg, ffprobe, type ProbeStream } from './tools'
import { ffmpegFilters, isIdentity, type EditRecipe } from '../shared/edits'

let rendersDir = ''
export function setRendersDir(dir: string): void {
  rendersDir = dir
  mkdirSync(dir, { recursive: true })
}

const isHdr = (v?: ProbeStream): boolean => v?.color_transfer === 'arib-std-b67' || v?.color_transfer === 'smpte2084'

let hevcEncoder: Promise<string> | null = null
/** First working HEVC encoder: hardware when present, x265 otherwise. */
export function pickHevcEncoder(): Promise<string> {
  return (hevcEncoder ??= (async () => {
    for (const enc of ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'libx265']) {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', enc, '-f', 'null', '-'], { windowsHide: true })
        p.on('error', () => resolve(false))
        p.on('close', (c) => resolve(c === 0))
      })
      if (ok) return enc
    }
    return 'libx264'
  })())
}

export async function hevcArgs(v: ProbeStream | undefined, quality: 'high' | 'medium' = 'high'): Promise<string[]> {
  const enc = await pickHevcEncoder()
  const hdr = isHdr(v)
  const color = hdr || v?.color_primaries
    ? ['-color_primaries', v?.color_primaries ?? 'bt709', '-color_trc', v?.color_transfer ?? 'bt709', '-colorspace', v?.color_primaries === 'bt2020' ? 'bt2020nc' : 'bt709']
    : []
  const q = quality === 'high' ? 20 : 26
  const per: Record<string, string[]> = {
    hevc_nvenc: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(q), '-pix_fmt', hdr ? 'p010le' : 'yuv420p'],
    hevc_qsv: ['-c:v', 'hevc_qsv', '-global_quality', String(q), '-pix_fmt', hdr ? 'p010le' : 'nv12'],
    hevc_amf: ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2), '-pix_fmt', hdr ? 'p010le' : 'nv12'],
    libx265: ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(q), '-pix_fmt', hdr ? 'yuv420p10le' : 'yuv420p'],
    libx264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']
  }
  return [...per[enc], ...(enc === 'libx264' ? [] : ['-tag:v', 'hvc1']), ...color]
}

interface Stored { recipe: EditRecipe; out: { w: number; h: number }; at: number }

export function getEdit(id: number): Stored | null {
  const r = getDb().prepare('SELECT user_edits FROM assets WHERE id = ?').get(id) as { user_edits: string | null } | undefined
  return r?.user_edits ? (JSON.parse(r.user_edits) as Stored) : null
}

async function dropRenders(id: number): Promise<void> {
  const r = getDb().prepare('SELECT user_render, user_live_render FROM assets WHERE id = ?').get(id) as
    | { user_render: string | null; user_live_render: string | null }
    | undefined
  for (const p of [r?.user_render, r?.user_live_render]) if (p) await rm(p, { force: true }).catch(() => undefined)
}

async function renderMovie(src: string, out: string, recipe: EditRecipe, opts: { trim: boolean; onProgress?: (p: number) => void }): Promise<void> {
  const probe = await ffprobe(src)
  const v = probe.streams?.find((s) => s.codec_type === 'video')
  const hasAudio = !!probe.streams?.some((s) => s.codec_type === 'audio')
  const rotTag = Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)
  let w = v?.width ?? 1920
  let h = v?.height ?? 1080
  if (Math.abs(rotTag) % 180 === 90) [w, h] = [h, w]
  const dur = Number(probe.format?.duration ?? v?.duration ?? 0)
  const start = opts.trim && recipe.trim ? recipe.trim.start : 0
  const end = opts.trim && recipe.trim ? recipe.trim.end : dur
  const vf = ffmpegFilters({ ...recipe, size: opts.trim ? recipe.size : null }, w, h)
  const args = [
    ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
    ...(end < dur - 0.01 ? ['-to', end.toFixed(3)] : []),
    '-i', src,
    ...(vf ? ['-vf', vf] : []),
    ...(await hevcArgs(v)),
    ...(recipe.mute || !hasAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '256k']),
    '-map_metadata', '0', '-movflags', '+faststart', out
  ]
  await ffmpeg(args, opts.onProgress ? (t) => opts.onProgress!(Math.min(1, t / Math.max(0.1, end - start))) : undefined)
}

/**
 * Stores an in-app edit. Photos arrive as the editor's full-resolution PNG (Display P3);
 * videos and Live Photo motion are rendered here with ffmpeg. Originals are never written.
 */
export async function saveEdit(
  id: number, recipe: EditRecipe, raw: Uint8Array | null, out: { w: number; h: number }, onProgress: (p: number) => void
): Promise<void> {
  const r = getRenderRow(id)
  if (!r) throw new Error('missing asset')
  if (isIdentity(recipe)) return revertEdit(id)
  const at = Date.now()
  let still: string | null = null
  let motion: string | null = null
  if (r.kind === 'photo') {
    if (!raw || raw.length !== out.w * out.h * 4) throw new Error('missing render')
    still = join(rendersDir, `${id}-${at}.jpg`)
    // The editor renders in Display P3, so the pixels are tagged rather than converted.
    await sharp(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), { raw: { width: out.w, height: out.h, channels: 4 } })
      .removeAlpha()
      .withIccProfile('p3')
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toFile(still)
    const live = r.live_edited_path ?? r.live_path
    if (live) {
      motion = join(rendersDir, `${id}-${at}-live.mp4`)
      await renderMovie(live, motion, recipe, { trim: false, onProgress: (p) => onProgress(0.5 + p / 2) }).catch(() => {
        motion = null
      })
    }
  } else {
    still = join(rendersDir, `${id}-${at}.mp4`)
    await renderMovie(editBasePath(r), still, recipe, { trim: true, onProgress })
  }
  await dropRenders(id)
  getDb()
    .prepare('UPDATE assets SET user_edits = ?, user_render = ?, user_live_render = ?, user_edit_at = ?, rotation = 0 WHERE id = ?')
    .run(JSON.stringify({ recipe, out, at } satisfies Stored), still, motion, at, id)
  await invalidateCache(id)
}

export async function revertEdit(id: number): Promise<void> {
  await dropRenders(id)
  getDb().prepare('UPDATE assets SET user_edits = NULL, user_render = NULL, user_live_render = NULL, user_edit_at = NULL WHERE id = ?').run(id)
  await invalidateCache(id)
}
