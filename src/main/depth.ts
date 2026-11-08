import { mkdirSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import sharp from 'sharp'
import { readHeifAux } from './heifAux'
import { cachePath, getRenderRow } from './render'
import { ffmpeg } from './tools'

export interface DepthInfo {
  /** media://depth/<id>: R = disparity (white = near), G = portrait matte (white = person), upright like the photo */
  width: number
  height: number
  /** Disparity (0–1) the subject sits at, where the blur is zero. */
  focus: number
  matte: boolean
  /** Other people/objects worth focusing, normalised rects, strongest first. */
  subjects?: { x: number; y: number; w: number; h: number; focus: number }[]
  v?: number
}

const ALGO = 6

const exists = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).size > 0
  } catch {
    return false
  }
}

export const depthPath = (id: number): string => cachePath('full', id, '-depth.png')
const infoPath = (id: number): string => cachePath('full', id, '-depth.json')

const inflight = new Map<number, Promise<DepthInfo | null>>()

/** Depth map and portrait matte from the original HEIC (iPhone Portrait and depth-capable photos). */
export function ensureDepth(id: number): Promise<DepthInfo | null> {
  const running = inflight.get(id)
  if (running) return running
  const p = build(id).finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

async function decodeAux(annexB: Buffer, out: string, rotation: number, mirror?: 'h' | 'v'): Promise<Buffer> {
  const src = `${out}.hevc`
  await writeFile(src, annexB)
  // irot counts anticlockwise quarter turns; ffmpeg's transpose=1 is clockwise.
  const vf = [['', 'transpose=2', 'hflip,vflip', 'transpose=1'][rotation & 3], mirror === 'h' ? 'hflip' : mirror === 'v' ? 'vflip' : ''].filter(Boolean).join(',')
  try {
    await ffmpeg(['-f', 'hevc', '-i', src, '-frames:v', '1', ...(vf ? ['-vf', vf] : []), '-pix_fmt', 'gray', '-update', '1', out])
    return await readFile(out)
  } finally {
    await rm(src, { force: true }).catch(() => undefined)
    await rm(out, { force: true }).catch(() => undefined)
  }
}

async function build(id: number): Promise<DepthInfo | null> {
  const png = depthPath(id)
  if (await exists(png)) {
    try {
      const info = JSON.parse(await readFile(infoPath(id), 'utf8')) as DepthInfo & { v?: number }
      if (info.v === ALGO && info.focus >= 0) return info
    } catch { /* rebuild */ }
  }
  const r = getRenderRow(id)
  if (!r || r.kind !== 'photo' || !['.heic', '.heif'].includes(extname(r.original_path).toLowerCase())) return null
  const aux = await readHeifAux(r.original_path).catch(() => null)
  const depth = aux?.aux.find((a) => a.type === 'depth')
  if (!aux || !depth) return null
  mkdirSync(dirname(png), { recursive: true })
  const matteAux = aux.aux.find((a) => a.type === 'matte')
  const depthImg = sharp(await decodeAux(depth.annexB, `${png}.d.png`, aux.rotation, aux.mirror))
  const matteBuf = matteAux ? await decodeAux(matteAux.annexB, `${png}.m.png`, aux.rotation, aux.mirror) : null
  const meta = matteBuf ? await sharp(matteBuf).metadata() : await depthImg.metadata()
  const width = meta.width ?? 768
  const height = meta.height ?? 576
  const d = await depthImg.resize(width, height, { kernel: 'cubic' }).extractChannel(0).raw().toBuffer()
  const m = dilate(matteBuf ? await sharp(matteBuf).resize(width, height).extractChannel(0).raw().toBuffer() : Buffer.alloc(width * height), width, height, 2)

  const found = findSubjects(d, m, width, height)
  const focus = found[0]?.focus ?? fallbackFocus(d, width, height)

  const rgb = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = d[i]
    rgb[i * 3 + 1] = m[i]
  }
  await sharp(rgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toFile(png)
  const info: DepthInfo = {
    width, height, focus: focus / 255, matte: !!matteBuf, v: ALGO,
    subjects: found.slice(0, 6).map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, focus: s.focus / 255 }))
  }
  await writeFile(infoPath(id), JSON.stringify(info))
  return info
}

interface Blob {
  x: number
  y: number
  w: number
  h: number
  n: number
  focus: number
  score: number
}

/** 4-connected components of a binary mask, scored so people beat sky, water and walls. */
function components(mask: Uint8Array, d: Buffer, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h)
  const qx = new Int32Array(w * h)
  const qy = new Int32Array(w * h)
  const out: Blob[] = []
  const minArea = Math.max(40, (w * h) / 2500)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * w + x
      if (!mask[s] || seen[s]) continue
      let qh = 0
      let qt = 0
      qx[qt] = x
      qy[qt] = y
      qt++
      seen[s] = 1
      let minx = x, maxx = x, miny = y, maxy = y, n = 0
      const hist = new Uint32Array(256)
      while (qh < qt) {
        const cx = qx[qh]
        const cy = qy[qh++]
        const i = cy * w + cx
        n++
        hist[d[i]]++
        if (cx < minx) minx = cx
        if (cx > maxx) maxx = cx
        if (cy < miny) miny = cy
        if (cy > maxy) maxy = cy
        const tryN = (nx: number, ny: number) => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
          const j = ny * w + nx
          if (!mask[j] || seen[j]) return
          seen[j] = 1
          qx[qt] = nx
          qy[qt] = ny
          qt++
        }
        tryN(cx + 1, cy)
        tryN(cx - 1, cy)
        tryN(cx, cy + 1)
        tryN(cx, cy - 1)
      }
      const bw = maxx - minx + 1
      const bh = maxy - miny + 1
      const compactness = n / (bw * bh)
      if (n < minArea || compactness < 0.14) continue
      let acc = 0
      let focus = 128
      const target = n * 0.5
      for (let v = 0; v < 256; v++) {
        acc += hist[v]
        if (acc >= target) {
          focus = v
          break
        }
      }
      const cx = (minx + maxx) / 2 / w
      const cy = (miny + maxy) / 2 / h
      const frac = n / (w * h)
      const nw = bw / w
      const nh = bh / h
      const aspect = bh / Math.max(1, bw)
      // People are compact and taller than they are wide. Water, cliffs and sky are huge flat planes.
      const sizeScore = frac < 0.4 ? Math.sqrt(Math.min(0.28, frac)) : Math.max(0.04, 0.55 - frac)
      const loc = Math.exp(-((cx - 0.5) ** 2) / 0.18 - ((cy - 0.55) ** 2) / 0.28)
      const person = compactness > 0.2 && aspect > 0.5 && aspect < 3.6 && nw < 0.85
      const aspectScore = person ? 1.45 : nw > 0.78 || (frac > 0.45 && compactness < 0.22) ? 0.08 : 0.45
      out.push({ x: minx / w, y: miny / h, w: nw, h: nh, n, focus, score: n * compactness * sizeScore * loc * aspectScore })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

function erode(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (src[i] && src[i - 1] && src[i + 1] && src[i - w] && src[i + w]) out[i] = 1
    }
  }
  return out
}

function dilate(src: Buffer, w: number, h: number, r: number): Buffer {
  if (r <= 0) return src
  const out = Buffer.alloc(src.length)
  src.copy(out)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[y * w + x] < 40) continue
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const i = yy * w + xx
          if (out[i] < src[y * w + x]) out[i] = src[y * w + x]
        }
      }
    }
  }
  return out
}

/**
 * Pick who should stay sharp. Prefers the portrait matte; if that is weak (a swimmer, a distant
 * group) it uses depth edges so a person still pops out of water or a wall.
 */
function findSubjects(d: Buffer, m: Buffer, w: number, h: number): Blob[] {
  const scale = Math.max(w, h) / 280
  const sw = Math.max(8, Math.round(w / scale))
  const sh = Math.max(8, Math.round(h / scale))
  const sd = Buffer.alloc(sw * sh)
  const sm = Buffer.alloc(sw * sh)
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.round((y + 0.5) * h / sh))
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.round((x + 0.5) * w / sw))
      const i = sy * w + sx
      sd[y * sw + x] = d[i]
      sm[y * sw + x] = m[i]
    }
  }

  const matte = new Uint8Array(sw * sh)
  let mc = 0
  for (let i = 0; i < sw * sh; i++) if (sm[i] > 36) { matte[i] = 1; mc++ }
  // If Apple's matte painted the water or the cliff, it covers most of the frame — ignore it.
  const matteFrac = mc / (sw * sh)
  let blobs = mc > 80 ? components(matte, sd, sw, sh) : []
  // Drop a full-frame sheet (water or a wall), but never a close-up person who fills the photo.
  blobs = blobs.filter((b) => !(b.w > 0.88 && b.h > 0.72 && b.n / (sw * sh) > 0.6))

  // High-pass disparity: closer than the *local* surroundings. A small radius so a swimmer
  // pops out of nearby water, while the water's own depth gradient stays quiet.
  const rad = Math.max(4, Math.round(Math.min(sw, sh) * 0.055))
  const ii = new Float64Array((sw + 1) * (sh + 1))
  for (let y = 0; y < sh; y++) {
    let run = 0
    for (let x = 0; x < sw; x++) {
      run += sd[y * sw + x]
      ii[(y + 1) * (sw + 1) + (x + 1)] = ii[y * (sw + 1) + (x + 1)] + run
    }
  }
  const mean = (x0: number, y0: number, x1: number, y1: number): number => {
    const a = Math.max(0, x0), b = Math.max(0, y0), c = Math.min(sw, x1), e = Math.min(sh, y1)
    const area = Math.max(1, (c - a) * (e - b))
    return (ii[e * (sw + 1) + c] - ii[b * (sw + 1) + c] - ii[e * (sw + 1) + a] + ii[b * (sw + 1) + a]) / area
  }
  const popVal = new Float32Array(sw * sh)
  let popN = 0
  let popSum = 0
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = sd[y * sw + x] - mean(x - rad, y - rad, x + rad + 1, y + rad + 1)
      popVal[y * sw + x] = v
      if (v > 6) { popN++; popSum += v }
    }
  }
  const popThr = popN > 40 ? Math.max(7, popSum / popN * 0.5) : 11
  const popRaw = new Uint8Array(sw * sh)
  for (let i = 0; i < sw * sh; i++) if (popVal[i] > popThr) popRaw[i] = 1
  // Prefer pixels that are both a person-matte and a depth pop when the matte is trustworthy.
  if (mc > 80 && matteFrac < 0.55) {
    for (let i = 0; i < sw * sh; i++) {
      if (matte[i] && popVal[i] > popThr * 0.4) popRaw[i] = 1
    }
  }
  const eroded = erode(popRaw, sw, sh)
  let keep = 0
  for (let i = 0; i < eroded.length; i++) if (eroded[i]) keep++
  const popped = components(keep > 30 ? eroded : popRaw, sd, sw, sh)

  // Merge: matte blobs first, then depth-pop blobs that aren't already covered.
  const covers = (a: Blob, b: Blob) => {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2
    return ax >= b.x && ax <= b.x + b.w && ay >= b.y && ay <= b.y + b.h
  }
  for (const p of popped) {
    if (blobs.some((b) => covers(p, b) || covers(b, p))) continue
    blobs.push(p)
  }
  blobs.sort((a, b) => b.score - a.score)

  // Two people at a similar depth: keep both, focus on the stronger; the shader matte holds the other.
  if (blobs.length >= 2 && Math.abs(blobs[0].focus - blobs[1].focus) < 18 && blobs[1].score > blobs[0].score * 0.45) {
    blobs[0] = { ...blobs[0], focus: Math.round((blobs[0].focus * blobs[0].n + blobs[1].focus * blobs[1].n) / (blobs[0].n + blobs[1].n)) }
  }
  return blobs
}

function fallbackFocus(d: Buffer, w: number, h: number): number {
  // Median of a tight torso-sized window. Closest-pixel / high-percentile picks the water
  // in front of a swimmer and leaves them blurred.
  const hist = new Uint32Array(256)
  let n = 0
  const y0 = Math.floor(h * 0.42), y1 = Math.floor(h * 0.72)
  const x0 = Math.floor(w * 0.36), x1 = Math.floor(w * 0.64)
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      hist[d[y * w + x]]++
      n++
    }
  }
  let acc = 0
  const target = n * 0.55
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= target) return v
  }
  return 128
}
