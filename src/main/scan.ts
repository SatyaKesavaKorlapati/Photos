import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

export const STILL_EXT = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.dng', '.webp', '.gif', '.avif', '.tif', '.tiff', '.bmp'])
export const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.3gp', '.avi', '.mkv', '.webm'])
export const SIDECAR_EXT = new Set(['.aae', '.dat', '.xmp'])

export interface ScannedFile {
  path: string
  size: number
  mtime: number
}

export interface AssetGroup {
  key: string
  dir: string
  name: string
  kind: 'photo' | 'video'
  original: ScannedFile
  edited?: ScannedFile
  live?: ScannedFile
  liveEdited?: ScannedFile
  aae?: ScannedFile
  sidecars: ScannedFile[]
}

/**
 * iOS exports name companions after the original: IMG_1234.HEIC is the original,
 * IMG_E1234.HEIC the rendered edit, IMG_O1234.AAE the original adjustments and
 * IMG_1234.MOV the Live Photo movie. Windows sometimes swaps IMG_ for four random
 * letters (TVVD0254 / TVVDE0254), so both prefixes are accepted.
 */
const STEM = /^(IMG_|[A-Z]{4})([EOA]?)(\d{4,5})$/i

export async function walk(root: string, out: ScannedFile[] = [], onDir?: (dir: string) => void): Promise<ScannedFile[]> {
  onDir?.(root)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'Thumbs.db' || e.name === 'desktop.ini') continue
    const p = join(root, e.name)
    if (e.isDirectory()) await walk(p, out, onDir)
    else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase()
      if (!STILL_EXT.has(ext) && !VIDEO_EXT.has(ext) && !SIDECAR_EXT.has(ext)) continue
      try {
        const s = await stat(p)
        out.push({ path: p, size: s.size, mtime: s.mtimeMs })
      } catch { /* vanished */ }
    }
  }
  return out
}

/** When individual files are selected, pull in their companions from the same folder. */
export async function withCompanions(files: string[]): Promise<ScannedFile[]> {
  const dirs = new Map<string, Set<string>>()
  for (const f of files) {
    const stem = basename(f, extname(f))
    const m = stem.match(STEM)
    const key = m ? (m[1] + m[3]).toUpperCase() : stem.toUpperCase()
    const set = dirs.get(dirname(f)) ?? new Set<string>()
    set.add(key)
    dirs.set(dirname(f), set)
  }
  const out: ScannedFile[] = []
  for (const [dir, keys] of dirs) {
    let names: string[] = []
    try { names = await readdir(dir) } catch { continue }
    for (const n of names) {
      const ext = extname(n).toLowerCase()
      if (!STILL_EXT.has(ext) && !VIDEO_EXT.has(ext) && !SIDECAR_EXT.has(ext)) continue
      const stem = basename(n, extname(n))
      const m = stem.match(STEM)
      const key = m ? (m[1] + m[3]).toUpperCase() : stem.toUpperCase()
      if (!keys.has(key)) continue
      const p = join(dir, n)
      try {
        const s = await stat(p)
        if (s.isFile()) out.push({ path: p, size: s.size, mtime: s.mtimeMs })
      } catch { /* skip */ }
    }
  }
  return out
}

const STILL_PRIORITY = ['.heic', '.heif', '.jpg', '.jpeg', '.dng', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.bmp']

function pickStill(files: ScannedFile[]): ScannedFile | undefined {
  return [...files].sort(
    (a, b) => STILL_PRIORITY.indexOf(extname(a.path).toLowerCase()) - STILL_PRIORITY.indexOf(extname(b.path).toLowerCase())
  )[0]
}

export function groupFiles(files: ScannedFile[]): { groups: AssetGroup[]; orphans: ScannedFile[] } {
  type Bucket = { dir: string; stills: ScannedFile[]; eStills: ScannedFile[]; videos: ScannedFile[]; eVideos: ScannedFile[]; aae: ScannedFile[]; oAae: ScannedFile[]; other: ScannedFile[] }
  const buckets = new Map<string, Bucket>()
  for (const f of files) {
    const dir = dirname(f.path)
    const ext = extname(f.path).toLowerCase()
    const stem = basename(f.path, extname(f.path))
    const m = stem.match(STEM)
    const variant = m ? m[2].toUpperCase() : ''
    const key = `${dir.toLowerCase()}|${m ? (m[1] + m[3]).toUpperCase() : stem.toUpperCase()}`
    let b = buckets.get(key)
    if (!b) {
      b = { dir, stills: [], eStills: [], videos: [], eVideos: [], aae: [], oAae: [], other: [] }
      buckets.set(key, b)
    }
    if (STILL_EXT.has(ext)) (variant === 'E' ? b.eStills : variant ? b.other : b.stills).push(f)
    else if (VIDEO_EXT.has(ext)) (variant === 'E' ? b.eVideos : variant ? b.other : b.videos).push(f)
    else if (ext === '.aae') (variant === 'O' ? b.oAae : variant ? b.other : b.aae).push(f)
    else b.other.push(f)
  }

  const groups: AssetGroup[] = []
  const orphans: ScannedFile[] = []
  for (const [key, b] of buckets) {
    const still = pickStill(b.stills)
    const eStill = pickStill(b.eStills)
    const extraStills = [...b.stills, ...b.eStills].filter((f) => f !== still && f !== eStill)
    const aae = b.aae[0] ?? b.oAae[0]
    const sidecars = [...b.aae, ...b.oAae, ...b.other, ...extraStills].filter((f) => f !== aae)

    if (still || eStill) {
      const original = (still ?? eStill)!
      groups.push({
        key,
        dir: b.dir,
        name: basename(original.path),
        kind: 'photo',
        original,
        edited: still ? eStill : undefined,
        live: b.videos[0],
        liveEdited: b.eVideos[0],
        aae,
        sidecars: [...sidecars, ...b.videos.slice(1), ...b.eVideos.slice(1)]
      })
    } else if (b.videos.length || b.eVideos.length) {
      const original = b.videos[0] ?? b.eVideos[0]
      groups.push({
        key,
        dir: b.dir,
        name: basename(original.path),
        kind: 'video',
        original,
        edited: b.videos[0] ? b.eVideos[0] : undefined,
        aae,
        sidecars: [...sidecars, ...b.videos.slice(1), ...b.eVideos.slice(1)]
      })
    } else {
      orphans.push(...b.aae, ...b.oAae, ...b.other)
    }
  }
  return { groups, orphans }
}
