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
}

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
      return JSON.parse(await readFile(infoPath(id), 'utf8')) as DepthInfo
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
  const m = matteBuf ? await sharp(matteBuf).resize(width, height).extractChannel(0).raw().toBuffer() : Buffer.alloc(width * height)

  // Focus: the typical disparity of the matted subject, else the nearest large region near the centre.
  const hist = new Array(256).fill(0)
  let n = 0
  for (let i = 0; i < d.length; i += 2) if (m[i] > 180) { hist[d[i]]++; n++ }
  const matted = n >= 200
  if (!matted) {
    hist.fill(0)
    n = 0
    for (let y = Math.floor(height * 0.25); y < height * 0.8; y += 2) {
      for (let x = Math.floor(width * 0.25); x < width * 0.75; x += 2) { hist[d[y * width + x]]++; n++ }
    }
  }
  // median for a matte, 75th percentile (nearer things) for the centre fallback
  const target = n * (matted ? 0.5 : 0.75)
  let acc = 0
  let focus = 128
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= target) { focus = v; break }
  }

  const rgb = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = d[i]
    rgb[i * 3 + 1] = m[i]
  }
  await sharp(rgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toFile(png)
  const info: DepthInfo = { width, height, focus: focus / 255, matte: !!matteBuf }
  await writeFile(infoPath(id), JSON.stringify(info))
  return info
}
