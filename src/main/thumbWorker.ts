import { parentPort } from 'node:worker_threads'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import sharp from 'sharp'
import decodeHeic from 'heic-decode'
import libheif from 'libheif-js/wasm-bundle'
import exifr from 'exifr'

type Sharp = ReturnType<typeof sharp>

export interface ImageJob {
  jobId: number
  src: string
  thumb?: string
  thumbSize: number
  preview?: string
  previewSize: number
  full?: string
}

const HEIF_COLORSPACE_RGB = 1
const HEIF_CHROMA_INTERLEAVED_RGBA = 11
const HEIF_CHANNEL_INTERLEAVED = 10

/**
 * Decodes the small HEVC thumbnail item iPhones embed in every HEIC (240×320 or 312×416),
 * which is ~700× faster than decoding the 24 MP tile grid. Returns null if there is none.
 */
async function heicEmbeddedThumb(buf: Buffer): Promise<{ data: Buffer; width: number; height: number; fullW: number; fullH: number } | null> {
  const L = libheif
  await L.ready
  const dec = new L.HeifDecoder()
  const imgs = dec.decode(buf)
  if (!imgs.length) return null
  const mem = L._malloc(64)
  let thumb = 0
  let image = 0
  try {
    const handle = imgs[0].handle.$$.ptr as number
    const fullW = imgs[0].get_width()
    const fullH = imgs[0].get_height()
    if (L._heif_image_handle_get_number_of_thumbnails(handle) < 1) return null
    L._heif_image_handle_get_list_of_thumbnail_IDs(handle, mem, 1)
    L._heif_image_handle_get_thumbnail(mem + 8, handle, L.HEAPU32[mem >> 2], mem + 4)
    if (L.HEAP32[(mem + 8) >> 2] !== 0) return null
    thumb = L.HEAPU32[(mem + 4) >> 2]
    L._heif_decode_image(mem + 24, thumb, mem + 20, HEIF_COLORSPACE_RGB, HEIF_CHROMA_INTERLEAVED_RGBA, 0)
    if (L.HEAP32[(mem + 24) >> 2] !== 0) return null
    image = L.HEAPU32[(mem + 20) >> 2]
    const width = L._heif_image_get_width(image, HEIF_CHANNEL_INTERLEAVED)
    const height = L._heif_image_get_height(image, HEIF_CHANNEL_INTERLEAVED)
    const plane = L._heif_image_get_plane_readonly(image, HEIF_CHANNEL_INTERLEAVED, mem + 40)
    const stride = L.HEAP32[(mem + 40) >> 2]
    if (!plane || width < 200) return null
    const data = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) data.set(L.HEAPU8.subarray(plane + y * stride, plane + y * stride + width * 4), y * width * 4)
    return { data, width, height, fullW, fullH }
  } finally {
    if (image) L._heif_image_release(image)
    if (thumb) L._heif_image_handle_release(thumb)
    L._free(mem)
    for (const i of imgs) i.free()
    L.heif_context_free(dec.decoder)
  }
}

async function heicIcc(buf: Buffer): Promise<Buffer | undefined> {
  try {
    const prof = await exifr.parse(buf, { icc: true, tiff: false, exif: false, gps: false, mergeOutput: true })
    if (!prof || /p3/i.test(String(prof.ProfileDescription ?? ''))) return await getP3Icc()
  } catch {
    return await getP3Icc()
  }
  return undefined
}

sharp.concurrency(1)
sharp.cache(false)

let p3Icc: Buffer | undefined

async function getP3Icc(): Promise<Buffer | undefined> {
  if (p3Icc) return p3Icc
  try {
    const probe = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#808080' } })
      .withIccProfile('p3')
      .jpeg()
      .toBuffer()
    p3Icc = (await sharp(probe).metadata()).icc
  } catch {
    p3Icc = undefined
  }
  return p3Icc
}

/** Inserts an APP2 ICC_PROFILE segment right after SOI so viewers color-manage the JPEG. */
function attachIcc(jpeg: Buffer, icc: Buffer): Buffer<ArrayBufferLike> {
  const header = Buffer.from('ICC_PROFILE\0', 'latin1')
  const len = 2 + header.length + 2 + icc.length
  const seg = Buffer.alloc(2 + len)
  seg[0] = 0xff
  seg[1] = 0xe2
  seg.writeUInt16BE(len, 2)
  header.copy(seg, 4)
  seg[4 + header.length] = 1
  seg[5 + header.length] = 1
  icc.copy(seg, 6 + header.length)
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)])
}

async function openImage(src: string): Promise<{ img: Sharp; width: number; height: number; icc?: Buffer }> {
  const ext = extname(src).toLowerCase()
  if (ext === '.heic' || ext === '.heif') {
    const buf = await readFile(src)
    const decoded = await decodeHeic({ buffer: buf })
    const icc = await heicIcc(buf)
    const img = sharp(Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), {
      raw: { width: decoded.width, height: decoded.height, channels: 4 }
    })
    return { img, width: decoded.width, height: decoded.height, icc }
  }
  if (ext === '.dng') {
    try {
      const img = sharp(src, { failOn: 'none' }).rotate()
      const m = await sharp(src, { failOn: 'none' }).metadata()
      if ((m.width ?? 0) >= 1000) {
        const swap = (m.orientation ?? 1) >= 5
        return { img, width: (swap ? m.height : m.width) ?? 0, height: (swap ? m.width : m.height) ?? 0 }
      }
    } catch { /* fall through to embedded preview */ }
    const preview = await exifr.thumbnail(src)
    if (!preview) throw new Error('no decodable image in DNG')
    const buf = Buffer.from(preview)
    const m = await sharp(buf).metadata()
    return { img: sharp(buf).rotate(), width: m.width ?? 0, height: m.height ?? 0 }
  }
  const m = await sharp(src, { failOn: 'none', animated: false }).metadata()
  const swap = (m.orientation ?? 1) >= 5
  return {
    img: sharp(src, { failOn: 'none', animated: false }).rotate(),
    width: (swap ? m.height : m.width) ?? 0,
    height: (swap ? m.width : m.height) ?? 0
  }
}

async function writeJpeg(img: Sharp, out: string, size: number | undefined, quality: number, icc?: Buffer): Promise<void> {
  await mkdir(dirname(out), { recursive: true })
  let pipe = img.clone()
  if (size) pipe = pipe.resize(size, size, { fit: 'inside', withoutEnlargement: true })
  let buf: Buffer = await pipe.flatten({ background: '#000000' }).jpeg({ quality, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' }).toBuffer()
  if (icc) buf = attachIcc(buf, icc)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(out, buf)
}

parentPort?.on('message', async (job: ImageJob) => {
  try {
    const ext = extname(job.src).toLowerCase()
    if (job.thumb && !job.preview && !job.full && (ext === '.heic' || ext === '.heif')) {
      const buf = await readFile(job.src)
      const t = await heicEmbeddedThumb(buf).catch(() => null)
      if (t) {
        const img = sharp(t.data, { raw: { width: t.width, height: t.height, channels: 4 } })
        await writeJpeg(img, job.thumb, job.thumbSize, 85, await heicIcc(buf))
        const portrait = t.height > t.width
        const [w, h] = portrait === t.fullH > t.fullW ? [t.fullW, t.fullH] : [t.fullH, t.fullW]
        parentPort?.postMessage({ jobId: job.jobId, ok: true, width: w, height: h })
        return
      }
    }
    const { img, width, height, icc } = await openImage(job.src)
    if (job.thumb) await writeJpeg(img, job.thumb, job.thumbSize, 82, icc)
    if (job.preview) await writeJpeg(img, job.preview, job.previewSize, 88, icc)
    if (job.full) await writeJpeg(img, job.full, undefined, 93, icc)
    parentPort?.postMessage({ jobId: job.jobId, ok: true, width, height })
  } catch (e) {
    parentPort?.postMessage({ jobId: job.jobId, ok: false, error: (e as Error).message })
  }
})
