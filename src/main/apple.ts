import { readFileSync } from 'node:fs'
import { inflateRawSync, inflateSync } from 'node:zlib'

/** Apple MakerNote ("Apple iOS\0") tags we care about. See exiftool Apple tags. */
export interface AppleMakerNote {
  contentId?: string
  captureType?: number // 1 ProRAW, 2 Portrait, 10 Photo, 11 Manual Focus, 12 Scene
  cameraType?: number // 0 back wide, 1 back normal, 6 front
  hdrImageType?: number // 3 HDR image, 4 original image
  hdrHeadroom?: number
  hdrGain?: number
  livePhotoVideoIndex?: number
  burstUUID?: string
}

export function parseAppleMakerNote(blob: Uint8Array | undefined): AppleMakerNote {
  const out: AppleMakerNote = {}
  if (!blob || blob.length < 16) return out
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (buf.toString('latin1', 0, 9) !== 'Apple iOS') return out
  const be = buf.toString('latin1', 12, 14) === 'MM'
  const u16 = (o: number): number => (be ? buf.readUInt16BE(o) : buf.readUInt16LE(o))
  const u32 = (o: number): number => (be ? buf.readUInt32BE(o) : buf.readUInt32LE(o))
  const i32 = (o: number): number => (be ? buf.readInt32BE(o) : buf.readInt32LE(o))
  try {
    const count = u16(14)
    for (let i = 0; i < count; i++) {
      const e = 16 + i * 12
      if (e + 12 > buf.length) break
      const tag = u16(e)
      const type = u16(e + 2)
      const n = u32(e + 4)
      const valOff = e + 8
      const readString = (): string | undefined => {
        const start = n <= 4 ? valOff : u32(valOff)
        if (start + n > buf.length) return undefined
        return buf.toString('latin1', start, start + n).replace(/\0+$/, '').trim() || undefined
      }
      const readInt = (): number => (type === 3 ? u16(valOff) : i32(valOff))
      const readRational = (): number | undefined => {
        const o = u32(valOff)
        if (o + 8 > buf.length) return undefined
        const num = i32(o)
        const den = i32(o + 4)
        return den ? num / den : undefined
      }
      switch (tag) {
        case 0x0a: out.hdrImageType = readInt(); break
        case 0x0b: out.burstUUID = readString(); break
        case 0x11: if (type === 2) out.contentId = readString(); break
        case 0x14: out.captureType = readInt(); break
        case 0x17: out.livePhotoVideoIndex = readInt(); break
        case 0x21: out.hdrHeadroom = readRational(); break
        case 0x2e: out.cameraType = readInt(); break
        case 0x30: out.hdrGain = readRational(); break
      }
    }
  } catch {
    // malformed maker note: keep whatever was read
  }
  return out
}

export interface EditSummary {
  editor?: string
  timestamp?: string
  items: { id: string; label: string; detail?: string }[]
  portrait?: { aperture?: number; lighting?: string; strength?: number }
  liveStyle?: 'loop' | 'bounce' | 'longexposure'
  trim?: { start: number; end: number }
  crop?: { x: number; y: number; w: number; h: number }
  muted?: boolean
  liveOff?: boolean
}

const LIGHTING: Record<string, string> = {
  Natural: 'Natural Light',
  Studio: 'Studio Light',
  StudioV2: 'Studio Light',
  Contour: 'Contour Light',
  ContourV2: 'Contour Light',
  Stage: 'Stage Light',
  StageV2: 'Stage Light',
  StageMono: 'Stage Light Mono',
  StageMonoV2: 'Stage Light Mono',
  StageWhite: 'High-Key Light Mono',
  HighKey: 'High-Key Light Mono'
}

const FILTERS: Record<string, string> = {
  '3DVivid': 'Vivid', '3DVividWarm': 'Vivid Warm', '3DVividCool': 'Vivid Cool',
  '3DDramatic': 'Dramatic', '3DDramaticWarm': 'Dramatic Warm', '3DDramaticCool': 'Dramatic Cool',
  '3DMono': 'Mono', '3DSilverplate': 'Silvertone', '3DNoir': 'Noir'
}

const LABELS: Record<string, string> = {
  Crop: 'Crop',
  Trim: 'Trim',
  Inpaint: 'Clean Up',
  WhiteBalance: 'White Balance',
  SmartTone: 'Light',
  SmartColor: 'Color',
  SmartBlackAndWhite: 'Black & White',
  DGVignetteEffectOperation: 'Vignette',
  DGDefinition2Operation: 'Definition',
  RKNoiseReductionOperation: 'Noise Reduction',
  RKProSharpenOperation: 'Sharpness',
  HighResolutionFusion: 'Deep Fusion',
  AutoEnhance: 'Auto Enhance',
  RedEye: 'Red-Eye',
  Retouch: 'Retouch',
  Orientation: 'Rotate',
  Mute: 'Mute',
  LivePhotoKeyFrame: 'Key Photo',
  VideoPosterFrame: 'Cover Frame',
  SlowMotion: 'Slo-mo',
  PortraitVideo: 'Cinematic',
  Effect: 'Filter',
  SemanticStyle: 'Photographic Style'
}

function decodeAdjustmentData(xml: string): string | undefined {
  const m = xml.match(/<key>adjustmentData<\/key>\s*<data>([\s\S]*?)<\/data>/)
  if (!m) return undefined
  const raw = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
  for (const fn of [inflateRawSync, inflateSync]) {
    try { return fn(raw).toString('utf8') } catch { /* try next */ }
  }
  return raw.toString('latin1')
}

const cmTime = (t: { value: number; timescale: number } | undefined): number =>
  t && t.timescale ? t.value / t.timescale : 0

/** Reads an iOS .AAE sidecar and turns the edit recipe into a human summary. */
export function parseAAE(path: string): EditSummary | undefined {
  let xml: string
  try { xml = readFileSync(path, 'utf8') } catch { return undefined }
  const summary: EditSummary = { items: [] }
  summary.editor = xml.match(/<key>adjustmentEditorBundleID<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  summary.timestamp = xml.match(/<key>adjustmentTimestamp<\/key>\s*<date>([^<]+)<\/date>/)?.[1]
  const format = xml.match(/<key>adjustmentFormatIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  const data = decodeAdjustmentData(xml)
  if (!data) return summary

  if (format === 'ScreenshotServices' || data.includes('SSSScreenshot')) {
    summary.items.push({ id: 'Markup', label: 'Markup' })
    return summary
  }
  if (data.startsWith('bplist')) {
    if (data.includes('slowMotion')) summary.items.push({ id: 'SlowMotion', label: 'Slo-mo' })
    else summary.items.push({ id: 'Edit', label: 'Edited' })
    return summary
  }

  let json: { adjustments?: { identifier: string; enabled?: boolean; settings?: Record<string, any> }[] }
  try { json = JSON.parse(data) } catch { return summary }
  for (const a of json.adjustments ?? []) {
    if (a.enabled === false) continue
    const s = a.settings ?? {}
    switch (a.identifier) {
      case 'DepthEffect':
        summary.portrait = { ...summary.portrait, aperture: typeof s.aperture === 'number' ? s.aperture : undefined }
        summary.items.push({ id: 'DepthEffect', label: 'Portrait', detail: s.aperture ? `Depth ƒ${(+s.aperture).toFixed(1)}` : undefined })
        break
      case 'PortraitEffect': {
        const lighting = LIGHTING[s.portraitEffectFilterName] ?? s.portraitEffectFilterName
        summary.portrait = { ...summary.portrait, lighting, strength: s.strength }
        summary.items.push({ id: 'PortraitEffect', label: 'Portrait Lighting', detail: lighting })
        break
      }
      case 'AutoLoop': {
        const flavor: string = s.recipe?.AutoLoop?.Params?.loopFlavor ?? s.flavor ?? 'AutoLoop'
        summary.liveStyle = /mirror|bounce/i.test(flavor) ? 'bounce' : /long/i.test(flavor) ? 'longexposure' : 'loop'
        summary.items.push({ id: 'AutoLoop', label: summary.liveStyle === 'bounce' ? 'Bounce' : summary.liveStyle === 'longexposure' ? 'Long Exposure' : 'Loop' })
        break
      }
      case 'LongExposure':
        summary.liveStyle = 'longexposure'
        summary.items.push({ id: 'LongExposure', label: 'Long Exposure' })
        break
      case 'Trim':
        summary.trim = { start: cmTime(s.startTime), end: cmTime(s.endTime) }
        summary.items.push({ id: 'Trim', label: 'Trim', detail: `${summary.trim.start.toFixed(1)}s – ${summary.trim.end.toFixed(1)}s` })
        break
      case 'Crop':
        summary.crop = { x: s.xOrigin, y: s.yOrigin, w: s.width, h: s.height }
        summary.items.push({ id: 'Crop', label: 'Crop', detail: s.straightenAngle ? `Straighten ${(+s.straightenAngle).toFixed(1)}°` : undefined })
        break
      case 'Inpaint':
        summary.items.push({ id: 'Inpaint', label: 'Clean Up', detail: `${(s.operations ?? []).length} object${(s.operations ?? []).length === 1 ? '' : 's'} removed` })
        break
      case 'InpaintMasks':
        break
      case 'Effect':
        summary.items.push({ id: 'Effect', label: 'Filter', detail: FILTERS[s.effectName] ?? s.effectName })
        break
      case 'Mute':
        summary.muted = true
        summary.items.push({ id: 'Mute', label: 'Mute' })
        break
      case 'LivePhotoKeyFrame':
        summary.items.push({ id: 'LivePhotoKeyFrame', label: 'Key Photo' })
        break
      case 'Live':
      case 'LivePhoto':
        if (s.enabled === false) summary.liveOff = true
        break
      default:
        summary.items.push({ id: a.identifier, label: LABELS[a.identifier] ?? a.identifier.replace(/([a-z])([A-Z])/g, '$1 $2') })
    }
  }
  return summary
}
