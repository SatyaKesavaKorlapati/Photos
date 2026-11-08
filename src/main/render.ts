import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { dirname, extname, join } from 'node:path'
import sharp from 'sharp'
import workerPath from './thumbWorker?modulePath'
import { getDb } from './db'
import { FFMPEG, FFMPEG_HEIC, ffmpeg, ffprobe } from './tools'
import { getSettings } from './settings'

export const THUMB_SIZE = 512
export const PREVIEW_SIZE = 1600

/** File types Chromium can show directly, so the original bytes are served untouched. */
const NATIVE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'])
const HEIF = new Set(['.heic', '.heif'])

let cacheRoot = ''

export function setCacheRoot(dir: string): void {
  cacheRoot = dir
  mkdirSync(dir, { recursive: true })
}

const bucket = (id: number): string => (id % 256).toString(16).padStart(2, '0')
export const cachePath = (kind: 'thumbs' | 'previews' | 'full' | 'live' | 'video', id: number, suffix = '.jpg'): string =>
  join(cacheRoot, kind, bucket(id), `${id}${suffix}`)

interface Job {
  jobId: number
  payload: Record<string, unknown>
  resolve: (v: { width: number; height: number }) => void
  reject: (e: Error) => void
}

class Pool {
  private workers: { w: Worker; busy: Job | null }[] = []
  private high: Job[] = []
  private low: Job[] = []
  private nextId = 1

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.spawn()
  }

  private spawn(): void {
    const w = new Worker(workerPath)
    const slot = { w, busy: null as Job | null }
    w.on('message', (msg: { jobId: number; ok: boolean; width: number; height: number; error?: string }) => {
      const job = slot.busy
      slot.busy = null
      if (job && job.jobId === msg.jobId) {
        if (msg.ok) job.resolve({ width: msg.width, height: msg.height })
        else job.reject(new Error(msg.error))
      }
      this.pump()
    })
    w.on('error', (e: unknown) => {
      slot.busy?.reject(e instanceof Error ? e : new Error(String(e)))
      slot.busy = null
      this.workers = this.workers.filter((s) => s !== slot)
      this.spawn()
      this.pump()
    })
    this.workers.push(slot)
  }

  run(payload: Record<string, unknown>, priority: 'high' | 'low'): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const job = { jobId: this.nextId++, payload, resolve, reject }
      if (priority === 'high') this.high.unshift(job)
      else this.low.push(job)
      this.pump()
    })
  }

  get idle(): boolean {
    return this.high.length === 0 && this.low.length === 0 && this.workers.every((s) => !s.busy)
  }

  get lowPending(): number {
    return this.low.length
  }

  private pump(): void {
    for (const slot of this.workers) {
      if (slot.busy) continue
      const job = this.high.shift() ?? this.low.shift()
      if (!job) return
      slot.busy = job
      slot.w.postMessage({ jobId: job.jobId, ffmpeg: FFMPEG_HEIC ? FFMPEG : undefined, ...job.payload })
    }
  }
}

// A full HEIC decode holds roughly 300 MB (24 MP RGBA plus the libheif heap).
const poolSize = Math.max(2, Math.min(8, cpus().length - 4, Math.floor(totalmem() / 2 ** 30 / 1.5)))
let pool: Pool | null = null
const getPool = (): Pool => (pool ??= new Pool(poolSize))

/** Limits concurrent ffmpeg processes. */
class Limiter {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>, front = false): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => (front ? this.queue.unshift(r) : this.queue.push(r)))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}
const ffLimit = new Limiter(3)

interface RenderRow {
  id: number
  kind: string
  original_path: string
  edited_path: string | null
  live_path: string | null
  live_edited_path: string | null
  user_render: string | null
  user_live_render: string | null
  width: number | null
  height: number | null
  duration: number | null
}

const rowStmt = () =>
  getDb().prepare(
    'SELECT id, kind, original_path, edited_path, live_path, live_edited_path, user_render, user_live_render, width, height, duration FROM assets WHERE id = ?'
  )

export function getRenderRow(id: number): RenderRow | undefined {
  return rowStmt().get(id) as RenderRow | undefined
}

/** The version shown in the library: an in-app edit, else the iPhone's edited render, else the original. */
export const displayPath = (r: RenderRow, original = false): string =>
  original ? r.original_path : r.user_render ?? r.edited_path ?? r.original_path

/** The version the editor starts from (in-app edits are re-applied to this, never stacked). */
export const editBasePath = (r: RenderRow): string => r.edited_path ?? r.original_path

/** Drops every cached derivative of an asset after its edit changes. */
export async function invalidateCache(id: number): Promise<void> {
  const files = [
    cachePath('thumbs', id), cachePath('previews', id), cachePath('full', id), cachePath('video', id, '.mp4'), cachePath('video', id, '-live.mp4'),
    cachePath('live', id, '-bounce.mp4'), cachePath('live', id, '-longexposure.jpg'), cachePath('video', id, '-strip-e.jpg'),
    cachePath('full', id, '-b.jpg')
  ]
  await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => undefined)))
  getDb().prepare('UPDATE assets SET thumb_done = 0 WHERE id = ?').run(id)
}

/** A row of frames for the video trimmer. */
export function ensureStrip(id: number, original = true): Promise<string> {
  const out = cachePath('video', id, original ? '-strip.jpg' : '-strip-e.jpg')
  return once(`strip:${id}:${original}`, async () => {
    if (await exists(out)) return out
    const r = getRenderRow(id)
    if (!r) throw new Error('missing asset')
    const src = original ? editBasePath(r) : displayPath(r)
    const dur = r.duration || Number((await ffprobe(src)).format?.duration) || 1
    mkdirSync(dirname(out), { recursive: true })
    const n = 14
    await ffLimit.run(() => ffmpeg(['-i', src, '-an', '-vf', `fps=${(n / dur).toFixed(5)},scale=-2:96,tile=${n}x1`, '-frames:v', '1', '-q:v', '4', out]), true)
    return out
  })
}

const inflight = new Map<string, Promise<string>>()

function once(key: string, fn: () => Promise<string>): Promise<string> {
  const existing = inflight.get(key)
  if (existing) return existing
  const p = fn().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

const exists = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).size > 0
  } catch {
    return false
  }
}

let onThumbDone: ((id: number) => void) | undefined
export function onThumbnailDone(fn: (id: number) => void): void {
  onThumbDone = fn
}

function markThumb(id: number, dims?: { width: number; height: number }, failed = false): void {
  const db = getDb()
  if (dims && dims.width && dims.height) {
    db.prepare('UPDATE assets SET thumb_done = ?, width = ?, height = ? WHERE id = ?').run(failed ? 2 : 1, dims.width, dims.height, id)
  } else {
    db.prepare('UPDATE assets SET thumb_done = ? WHERE id = ?').run(failed ? 2 : 1, id)
  }
  onThumbDone?.(id)
}

async function videoFrame(src: string, out: string, size: number, at = 0.4): Promise<void> {
  mkdirSync(dirname(out), { recursive: true })
  const vf = `scale=w=${size}:h=${size}:force_original_aspect_ratio=decrease`
  try {
    await ffmpeg(['-ss', String(at), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', out])
  } catch {
    await ffmpeg(['-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', out])
  }
  if (!existsSync(out)) await ffmpeg(['-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', out])
}

export function ensureThumb(id: number, priority: 'high' | 'low' = 'high'): Promise<string> {
  const out = cachePath('thumbs', id)
  return once(`thumb:${id}`, async () => {
    if (await exists(out)) {
      getDb().prepare('UPDATE assets SET thumb_done = 1 WHERE id = ? AND thumb_done = 0').run(id)
      return out
    }
    const r = getRenderRow(id)
    if (!r) throw new Error('missing asset')
    try {
      if (r.kind === 'video') {
        const preview = cachePath('previews', id)
        await ffLimit.run(() => videoFrame(displayPath(r), preview, PREVIEW_SIZE), priority === 'high')
        await sharp(preview).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside' }).jpeg({ quality: 82 }).toFile(out)
        markThumb(id)
      } else {
        const src = displayPath(r)
        const ext = extname(src).toLowerCase()
        const withPreview = !NATIVE.has(ext) && !HEIF.has(ext)
        const dims = await getPool().run(
          { src, thumb: out, thumbSize: THUMB_SIZE, preview: withPreview ? cachePath('previews', id) : undefined, previewSize: PREVIEW_SIZE },
          priority
        )
        markThumb(id, dims)
      }
    } catch (e) {
      markThumb(id, undefined, true)
      throw e
    }
    return out
  })
}

/** Best quickly-available display image. Native formats are served byte-for-byte. */
export async function ensurePreview(id: number, original = false): Promise<string> {
  const r = getRenderRow(id)
  if (!r) throw new Error('missing asset')
  const src = displayPath(r, original)
  if (r.kind === 'photo' && NATIVE.has(extname(src).toLowerCase())) return src
  if (original && r.kind === 'photo') {
    const outO = cachePath('previews', id, '-o.jpg')
    if (await exists(outO)) return outO
    return once(`preview-o:${id}`, async () => {
      await getPool().run({ src, preview: outO, thumbSize: THUMB_SIZE, previewSize: PREVIEW_SIZE }, 'high')
      return outO
    })
  }
  const out = cachePath('previews', id)
  if (await exists(out)) return out
  if (r.kind === 'video' || !HEIF.has(extname(src).toLowerCase())) {
    await ensureThumb(id, 'high')
    if (await exists(out)) return out
  }
  return once(`preview:${id}`, async () => {
    if (await exists(out)) return out
    await getPool().run({ src, preview: out, thumbSize: THUMB_SIZE, previewSize: PREVIEW_SIZE }, 'high')
    return out
  })
}

/** Full-resolution decode for formats the browser cannot open itself (HEIC, DNG, TIFF). */
export function ensureFull(id: number, original = false): Promise<string> {
  const out = cachePath('full', id, original ? '-o.jpg' : '.jpg')
  return once(`full:${id}:${original}`, async () => {
    const r = getRenderRow(id)
    if (!r) throw new Error('missing asset')
    const src = displayPath(r, original)
    if (NATIVE.has(extname(src).toLowerCase())) return src
    if (await exists(out)) return out
    await getPool().run({ src, full: out, thumbSize: THUMB_SIZE, previewSize: PREVIEW_SIZE }, 'high')
    return out
  })
}

/** Full-resolution still of the edit base, so re-editing never stacks on an earlier in-app render. */
export async function ensureBaseFull(id: number): Promise<string> {
  const r = getRenderRow(id)
  if (!r) throw new Error('missing asset')
  const src = editBasePath(r)
  if (NATIVE.has(extname(src).toLowerCase())) return src
  if (!r.user_render) return ensureFull(id)
  if (src === r.original_path) return ensureFull(id, true)
  const out = cachePath('full', id, '-b.jpg')
  return once(`base:${id}`, async () => {
    if (await exists(out)) return out
    await getPool().run({ src, full: out, thumbSize: THUMB_SIZE, previewSize: PREVIEW_SIZE }, 'high')
    return out
  })
}

export function livePath(id: number, original = false): string | undefined {
  const r = getRenderRow(id)
  if (!r) return undefined
  return original ? r.live_path ?? undefined : r.user_live_render ?? r.live_edited_path ?? r.live_path ?? undefined
}

/** Bounce: the clip played forward then backward, rendered once and cached. */
export function ensureBounce(id: number): Promise<string> {
  const out = cachePath('live', id, '-bounce.mp4')
  return once(`bounce:${id}`, async () => {
    if (await exists(out)) return out
    const src = livePath(id)
    if (!src) throw new Error('not a live photo')
    mkdirSync(dirname(out), { recursive: true })
    await ffLimit.run(() =>
      ffmpeg([
        '-i', src, '-an',
        '-filter_complex', '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]',
        '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out
      ]), true)
    return out
  })
}

/**
 * Long Exposure fallback when no rendered still exists. Like iOS, frames are first aligned to the
 * key moment (vidstab tripod mode) so static scenery stays sharp and only real motion smears.
 */
export function ensureLongExposure(id: number): Promise<string> {
  const out = cachePath('live', id, '-longexposure.jpg')
  return once(`longexp:${id}`, async () => {
    if (await exists(out)) return out
    const src = livePath(id, true)
    if (!src) throw new Error('not a live photo')
    const dir = dirname(out)
    mkdirSync(dir, { recursive: true })
    // tmix only emits once its window is full, so the window must not exceed the clip's frame count.
    const v = (await ffprobe(src)).streams?.find((s) => s.codec_type === 'video')
    const [num, den] = String(v?.avg_frame_rate ?? '30/1').split('/').map(Number)
    const count = Number(v?.nb_frames) || Math.floor((Number(v?.duration) || 3) * (num / (den || 1) || 30))
    const frames = Math.max(2, Math.min(120, count - 1))
    const blend = (pre: string): string[] => ['-i', src, '-an', '-vf', `${pre}tmix=frames=${frames}`, '-update', '1', '-q:v', '2', out]
    // vidstab's result path is a filter option, where Windows drive colons need escaping; a cwd-relative name avoids that.
    const trf = `${id}-longexposure.trf`
    try {
      await ffLimit.run(async () => {
        await ffmpeg(['-i', src, '-an', '-vf', `vidstabdetect=shakiness=8:accuracy=15:tripod=${Math.max(1, Math.round(count / 2))}:result=${trf}`, '-f', 'null', '-'], undefined, dir)
        await ffmpeg(blend(`vidstabtransform=input=${trf}:tripod=1:zoom=0:optzoom=0:crop=keep:interpol=bicubic,`), undefined, dir)
      }, true)
    } catch {
      await ffLimit.run(() => ffmpeg(blend('')), true)
    } finally {
      await rm(join(dir, trf), { force: true }).catch(() => undefined)
    }
    if (!(await exists(out))) throw new Error('long exposure render produced no frame')
    return out
  })
}

/** H.264 copy for codecs Chromium cannot play (ProRes, some HEVC profiles). Originals are never modified. */
export function ensureCompatVideo(id: number, which: 'video' | 'live' = 'video'): Promise<string> {
  const out = cachePath('video', id, which === 'live' ? '-live.mp4' : '.mp4')
  return once(`compat:${id}:${which}`, async () => {
    if (await exists(out)) return out
    const r = getRenderRow(id)
    if (!r) throw new Error('missing asset')
    const src = which === 'live' ? livePath(id)! : displayPath(r)
    mkdirSync(dirname(out), { recursive: true })
    await ffLimit.run(() =>
      ffmpeg(['-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]), true)
    return out
  })
}

let backgroundRunning = false
let bgTotal = 0
let bgDone = 0

export function backgroundProgress(): { total: number; done: number; running: boolean } {
  return { total: bgTotal, done: bgDone, running: backgroundRunning }
}

/** Fills the thumbnail cache for everything not yet rendered, newest first. */
export async function runBackgroundThumbs(onProgress: (p: { total: number; done: number; running: boolean }) => void): Promise<void> {
  if (backgroundRunning) return
  backgroundRunning = true
  let lastEmit = 0
  const tick = (): void => {
    bgDone++
    if (Date.now() - lastEmit > 400) {
      lastEmit = Date.now()
      onProgress({ total: bgTotal, done: bgDone, running: true })
    }
  }
  // Photos and videos drain independently so slow ffmpeg frames never hold up cheap HEIC thumbnails.
  const drain = async (kind: 'photo' | 'video', batch: number): Promise<void> => {
    for (;;) {
      if (!getSettings().backgroundThumbs) return
      const rows = getDb()
        .prepare('SELECT id FROM assets WHERE thumb_done = 0 AND meta_done = 1 AND kind = ? ORDER BY taken_at DESC LIMIT ?')
        .all(kind, batch) as { id: number }[]
      if (!rows.length) return
      await Promise.all(rows.map((r) => ensureThumb(r.id, 'low').catch(() => undefined).finally(tick)))
    }
  }
  try {
    const remaining = (getDb().prepare('SELECT COUNT(*) n FROM assets WHERE thumb_done = 0').get() as { n: number }).n
    bgTotal = bgDone + remaining
    await Promise.all([drain('photo', 64), drain('video', 6)])
  } finally {
    backgroundRunning = false
    onProgress({ total: bgTotal, done: bgDone, running: false })
  }
}
