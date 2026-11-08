import exifr from 'exifr'
import sharp from 'sharp'
import { basename, extname } from 'node:path'
import { parseAAE, parseAppleMakerNote, type EditSummary } from './apple'
import { ffprobe, type Probe } from './tools'

export interface AssetRowForMeta {
  id: number
  kind: 'photo' | 'video'
  dir: string
  original_path: string
  edited_path: string | null
  live_path: string | null
  live_edited_path: string | null
  aae_path: string | null
  mtime: number
}

export interface VideoTech {
  codec?: string
  profile?: string
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  hdr?: string
  audio?: string
  rotation?: number
}

export interface Tech {
  format: string
  fileFormat: string
  megapixels?: number
  hdr?: boolean
  hdrHeadroom?: number
  camera?: string
  lensShort?: string
  video?: VideoTech
  live?: VideoTech & { duration?: number }
  contentIdMatch?: boolean
  captureType?: number
  cameraType?: number
  burst?: string
  location?: string
}

export interface MetaResult {
  width?: number
  height?: number
  duration?: number
  taken_at: number
  tz?: string
  make?: string
  model?: string
  lens?: string
  software?: string
  iso?: number
  fnumber?: number
  exposure?: number
  focal?: number
  focal35?: number
  ev?: number
  flash?: number
  lat?: number
  lon?: number
  alt?: number
  subtypes: string[]
  live_style?: string
  content_id?: string
  edits?: EditSummary
  quality: string[]
  tech: Tech
  /** Paired MOV turned out to be a normal video, not a Live Photo movie. */
  splitLive?: boolean
}

const FORMAT_LABEL: Record<string, string> = {
  '.heic': 'HEIF', '.heif': 'HEIF', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.dng': 'RAW', '.webp': 'WebP',
  '.gif': 'GIF', '.avif': 'AVIF', '.tif': 'TIFF', '.tiff': 'TIFF', '.bmp': 'BMP', '.mov': 'MOV', '.mp4': 'MP4', '.m4v': 'M4V'
}

/** "2026:10:31 14:15:06" with an optional "+05:30" offset. */
function parseExifDate(v: unknown, offset?: unknown): { t: number; tz?: string } | undefined {
  if (v instanceof Date && !isNaN(+v)) return { t: +v }
  if (typeof v !== 'string') return undefined
  const m = v.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/)
  if (!m) return undefined
  const [, y, mo, d, h, mi, s, , inlineTz] = m
  if (+y < 1971) return undefined
  const tz = (typeof offset === 'string' && /^[+-]\d{2}:?\d{2}$/.test(offset) ? offset : inlineTz) || undefined
  if (tz) {
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz === 'Z' ? 'Z' : tz.length === 5 ? tz.slice(0, 3) + ':' + tz.slice(3) : tz}`
    const t = Date.parse(iso)
    if (!isNaN(t)) return { t, tz }
  }
  return { t: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime() }
}

function gpsToDecimal(v: unknown, ref: unknown): number | undefined {
  let n: number | undefined
  if (Array.isArray(v) && v.length >= 1) n = (+v[0] || 0) + (+v[1] || 0) / 60 + (+v[2] || 0) / 3600
  else if (typeof v === 'number') n = v
  if (n === undefined || isNaN(n)) return undefined
  return ref === 'S' || ref === 'W' ? -n : n
}

function iso6709(s: string | undefined): { lat: number; lon: number; alt?: number } | undefined {
  const m = s?.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/)
  return m ? { lat: +m[1], lon: +m[2], alt: m[3] ? +m[3] : undefined } : undefined
}

function fpsOf(r?: string): number | undefined {
  if (!r) return undefined
  const [a, b] = r.split('/').map(Number)
  const f = b ? a / b : a
  return f && isFinite(f) ? Math.round(f * 100) / 100 : undefined
}

const CODEC: Record<string, string> = { hevc: 'HEVC', h264: 'H.264', prores: 'ProRes', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mjpeg: 'Motion JPEG' }

function videoTech(p: Probe): VideoTech | undefined {
  const v = p.streams?.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg')
  if (!v) return undefined
  const a = p.streams?.find((s) => s.codec_type === 'audio')
  const rot = v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? (v.tags?.rotate ? +v.tags.rotate : 0)
  const swap = Math.abs(rot) % 180 === 90
  const dovi = v.side_data_list?.some((d) => /dovi/i.test(d.side_data_type ?? ''))
  const hdr = dovi ? 'Dolby Vision' : v.color_transfer === 'arib-std-b67' ? 'HDR (HLG)' : v.color_transfer === 'smpte2084' ? 'HDR10' : undefined
  return {
    codec: CODEC[v.codec_name ?? ''] ?? v.codec_name?.toUpperCase(),
    profile: v.profile,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: fpsOf(v.avg_frame_rate) ?? fpsOf(v.r_frame_rate),
    bitrate: v.bit_rate ? +v.bit_rate : p.format?.bit_rate ? +p.format.bit_rate : undefined,
    hdr,
    audio: a ? `${(a.codec_name ?? '').toUpperCase()}${a.channels ? ` · ${a.channels === 1 ? 'Mono' : a.channels === 2 ? 'Stereo' : a.channels + ' ch'}` : ''}${a.sample_rate ? ` · ${(+a.sample_rate / 1000).toFixed(1)} kHz` : ''}` : undefined,
    rotation: rot
  }
}

function resolutionLabel(w = 0, h = 0): string | undefined {
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  if (long >= 3800 || short >= 2100) return '4K'
  if (short >= 1400) return '1440p'
  if (short >= 1000) return '1080p'
  if (short >= 700) return '720p'
  if (short > 0) return `${short}p`
  return undefined
}

function lensShort(lens?: string, focal35?: number): string | undefined {
  if (!lens) return undefined
  const kind = /front/i.test(lens) ? 'Front Camera' : /telephoto/i.test(lens) ? 'Telephoto Camera' : /ultra ?wide/i.test(lens) ? 'Ultra Wide Camera' : /back/i.test(lens) ? 'Main Camera' : undefined
  if (!kind) return lens
  return focal35 ? `${kind} — ${Math.round(focal35)} mm` : kind
}

/** Year-month folder names like 202610_a give a sanity range for file times. */
function folderMonth(dir: string): { y: number; m: number } | undefined {
  const m = basename(dir).match(/^(20\d{2})(0[1-9]|1[0-2])(?:_|$)/)
  return m ? { y: +m[1], m: +m[2] } : undefined
}

function fallbackDate(dir: string, mtime: number): number {
  const fm = folderMonth(dir)
  if (!fm) return mtime
  const d = new Date(mtime)
  if (d.getFullYear() === fm.y && d.getMonth() + 1 === fm.m) return mtime
  return new Date(fm.y, fm.m - 1, 15, 12, 0, 0).getTime()
}

async function stillMeta(path: string) {
  let parsed: Record<string, any> | undefined
  try {
    parsed = await exifr.parse(path, {
      tiff: true, exif: true, gps: true, xmp: true, makerNote: true, ihdr: true,
      icc: false, iptc: false, jfif: false, interop: false,
      mergeOutput: false, reviveValues: false, translateValues: false, translateKeys: true
    })
  } catch { parsed = undefined }
  return parsed ?? {}
}

export async function extractMeta(row: AssetRowForMeta): Promise<MetaResult> {
  const subtypes = new Set<string>()
  const quality: string[] = []
  const edits = row.aae_path ? parseAAE(row.aae_path) : undefined
  const displayPath = row.edited_path ?? row.original_path
  const ext = extname(row.original_path).toLowerCase()
  const tech: Tech = { format: FORMAT_LABEL[ext] ?? ext.slice(1).toUpperCase(), fileFormat: ext.slice(1).toUpperCase() }
  const res: MetaResult = { taken_at: 0, subtypes: [], quality, tech, edits }

  if (edits && (edits.items.length || row.edited_path)) subtypes.add('edited')
  else if (row.edited_path) subtypes.add('edited')

  if (row.kind === 'photo') {
    const m = await stillMeta(row.original_path)
    const ifd0 = m.ifd0 ?? {}
    const exif = m.exif ?? {}
    const gps = m.gps ?? {}
    const xmp = m.xmp ?? {}
    const ihdr = m.ihdr ?? {}
    const mn = parseAppleMakerNote(m.makerNote)

    res.make = ifd0.Make?.trim?.() || undefined
    res.model = ifd0.Model?.trim?.() || undefined
    res.software = ifd0.Software || undefined
    res.lens = exif.LensModel || undefined
    res.iso = exif.ISO ?? exif.ISOSpeedRatings ?? exif.PhotographicSensitivity
    if (Array.isArray(res.iso)) res.iso = res.iso[0]
    res.fnumber = exif.FNumber
    res.exposure = exif.ExposureTime
    res.focal = exif.FocalLength
    res.focal35 = exif.FocalLengthIn35mmFormat
    res.ev = exif.ExposureCompensation ?? exif.ExposureBiasValue
    res.flash = exif.Flash
    res.lat = gpsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef)
    res.lon = gpsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef)
    res.alt = typeof gps.GPSAltitude === 'number' ? (gps.GPSAltitudeRef === 1 ? -gps.GPSAltitude : gps.GPSAltitude) : undefined
    res.content_id = mn.contentId

    const date =
      parseExifDate(exif.DateTimeOriginal, exif.OffsetTimeOriginal) ??
      parseExifDate(exif.CreateDate ?? exif.DateTimeDigitized, exif.OffsetTimeDigitized) ??
      parseExifDate(xmp.DateCreated ?? xmp.CreateDate) ??
      parseExifDate(ifd0.ModifyDate ?? ifd0.DateTime, exif.OffsetTime)
    res.taken_at = date?.t ?? fallbackDate(row.dir, row.mtime)
    res.tz = date?.tz

    // Dimensions of what is displayed (the edit may be cropped).
    let w: number | undefined
    let h: number | undefined
    const dispExt = extname(displayPath).toLowerCase()
    if (dispExt !== '.heic' && dispExt !== '.heif') {
      try {
        const sm = await sharp(displayPath, { failOn: 'none' }).metadata()
        w = sm.width
        h = sm.height
        if (sm.orientation && sm.orientation >= 5) [w, h] = [h, w]
        if ((sm.pages ?? 1) > 1 && (dispExt === '.gif' || dispExt === '.webp')) subtypes.add('animated')
      } catch { /* fall back to EXIF dims */ }
    }
    if (!w || !h) {
      w = exif.ExifImageWidth ?? ihdr.ImageWidth ?? ifd0.ImageWidth
      h = exif.ExifImageHeight ?? ihdr.ImageHeight ?? ifd0.ImageHeight
      if (w && h && (ifd0.Orientation ?? 1) >= 5) [w, h] = [h, w]
      if (edits?.crop?.w && edits.crop.h && row.edited_path) {
        w = edits.crop.w
        h = edits.crop.h
      }
    }
    res.width = w
    res.height = h

    const isApple = /apple/i.test(res.make ?? '')
    if (ext === '.dng') {
      tech.format = mn.captureType === 1 || isApple ? 'ProRAW' : 'RAW'
      subtypes.add('raw')
    }
    if (mn.captureType === 2 || edits?.portrait) subtypes.add('portrait')
    if (mn.cameraType === 6 || /front/i.test(res.lens ?? '')) subtypes.add('selfie')
    const comment = String(xmp.UserComment ?? exif.UserComment ?? '')
    if (/screenshot/i.test(comment) || (!res.make && (ext === '.png' || edits?.items.some((i) => i.id === 'Markup')))) subtypes.add('screenshot')
    if (res.make && w && h && Math.max(w, h) / Math.min(w, h) >= 2.2 && !subtypes.has('screenshot')) subtypes.add('panorama')
    if ((mn.hdrHeadroom && mn.hdrHeadroom > 1.01) || (mn.hdrGain && mn.hdrGain > 0) || mn.hdrImageType === 3) {
      subtypes.add('hdr')
      tech.hdr = true
      tech.hdrHeadroom = mn.hdrHeadroom
    }
    if (mn.burstUUID) {
      subtypes.add('burst')
      tech.burst = mn.burstUUID
    }
    tech.captureType = mn.captureType
    tech.cameraType = mn.cameraType
    if (ext === '.gif') subtypes.add('animated')

    if (row.live_path) {
      const lp = await ffprobe(row.live_edited_path ?? row.live_path)
      const dur = lp.format?.duration ? +lp.format.duration : undefined
      const lvt = videoTech(lp)
      const movId = lp.format?.tags?.['com.apple.quicktime.content.identifier']
      tech.contentIdMatch = !!(movId && res.content_id && movId === res.content_id)
      if (!tech.contentIdMatch && dur !== undefined && dur > 6) {
        res.splitLive = true
      } else {
        subtypes.add('live')
        tech.live = { ...lvt, duration: dur }
        res.live_style = edits?.liveOff ? 'off' : edits?.liveStyle ?? 'live'
        if (edits?.liveStyle) subtypes.add(edits.liveStyle)
      }
    }

    tech.megapixels = w && h ? Math.round((w * h) / 1e6) : undefined
    tech.camera = res.model
    tech.lensShort = lensShort(res.lens, res.focal35)
    quality.push(tech.format)
    if (tech.megapixels) quality.push(`${tech.megapixels} MP`)
    if (tech.hdr) quality.push('HDR')
    if (subtypes.has('live')) quality.push(res.live_style === 'loop' ? 'Loop' : res.live_style === 'bounce' ? 'Bounce' : res.live_style === 'longexposure' ? 'Long Exposure' : 'Live')
    if (subtypes.has('portrait')) quality.push('Portrait')
  } else {
    const p = await ffprobe(row.edited_path ?? row.original_path)
    const op = row.edited_path ? await ffprobe(row.original_path) : p
    const tags = { ...(op.format?.tags ?? {}), ...(op.streams?.find((s) => s.codec_type === 'video')?.tags ?? {}) }
    const vt = videoTech(p)
    res.duration = p.format?.duration ? +p.format.duration : undefined
    res.width = vt?.width
    res.height = vt?.height
    res.make = tags['com.apple.quicktime.make'] || undefined
    res.model = tags['com.apple.quicktime.model'] || undefined
    res.software = tags['com.apple.quicktime.software'] || undefined
    res.lens = tags['com.apple.quicktime.camera.lens_model'] || undefined
    res.focal35 = tags['com.apple.quicktime.camera.focal_length.35mm_equivalent'] ? +tags['com.apple.quicktime.camera.focal_length.35mm_equivalent'] : undefined
    res.content_id = tags['com.apple.quicktime.content.identifier'] || undefined
    const loc = iso6709(tags['com.apple.quicktime.location.ISO6709'] ?? tags.location)
    if (loc) {
      res.lat = loc.lat
      res.lon = loc.lon
      res.alt = loc.alt
    }
    const date =
      parseExifDate(tags['com.apple.quicktime.creationdate']) ??
      (tags.creation_time && !isNaN(Date.parse(tags.creation_time)) && Date.parse(tags.creation_time) > 86400000 ? { t: Date.parse(tags.creation_time) } : undefined)
    res.taken_at = date?.t ?? fallbackDate(row.dir, row.mtime)
    res.tz = date?.tz

    tech.video = vt
    tech.camera = res.model
    tech.lensShort = lensShort(res.lens, res.focal35)
    const allTagKeys = Object.keys(tags).join(' ')
    if ((vt?.fps ?? 0) >= 100 || edits?.items.some((i) => i.id === 'SlowMotion')) subtypes.add('slomo')
    if (edits?.items.some((i) => i.id === 'PortraitVideo') || /cinematic/i.test(allTagKeys)) subtypes.add('cinematic')
    if (/spatial/i.test(allTagKeys)) subtypes.add('spatial')
    if (/timelapse|time-lapse/i.test(allTagKeys)) subtypes.add('timelapse')
    if (/front/i.test(res.lens ?? '')) subtypes.add('selfie')
    if (vt?.hdr) subtypes.add('hdr')
    const ratio = vt?.width && vt.height ? Math.min(vt.width, vt.height) / Math.max(vt.width, vt.height) : 0
    if (!res.model && !loc && ratio > 0.43 && ratio < 0.48) subtypes.add('screenrec')

    const r = resolutionLabel(vt?.width, vt?.height)
    if (r) quality.push(r)
    if (vt?.fps) quality.push(`${Math.round(vt.fps)} fps`)
    if (vt?.codec) quality.push(vt.codec)
    if (vt?.hdr) quality.push(vt.hdr.startsWith('Dolby') ? 'Dolby Vision' : 'HDR')
    if (subtypes.has('cinematic')) quality.push('Cinematic')
    if (subtypes.has('slomo')) quality.push('Slo-mo')
    if (subtypes.has('spatial')) quality.push('Spatial')
  }

  if (res.lat !== undefined && res.lon !== undefined) tech.location = `${res.lat.toFixed(5)}, ${res.lon.toFixed(5)}`
  res.subtypes = [...subtypes]
  return res
}
