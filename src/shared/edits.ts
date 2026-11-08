/** Non-destructive edit recipe shared by the editor (WebGL preview/render) and the main process (ffmpeg video render). */

export type AdjustKey =
  | 'exposure' | 'brilliance' | 'highlights' | 'shadows' | 'contrast' | 'brightness' | 'blackPoint'
  | 'saturation' | 'vibrance' | 'warmth' | 'tint'
  | 'sharpness' | 'definition' | 'noise' | 'vignette'

export interface CropRect { x: number; y: number; w: number; h: number }

export interface EditRecipe {
  adjust: Partial<Record<AdjustKey, number>>
  filter: FilterName | null
  filterAmount: number
  /** Normalised rectangle in the oriented frame (after quarter turns and flips). */
  crop: CropRect
  /** Straighten angle in degrees, clockwise, -45…45. */
  angle: number
  /** Clockwise quarter turns. */
  rot90: number
  flipH: boolean
  flipV: boolean
  /** Output size; null keeps the cropped pixel size. */
  size: { w: number; h: number } | null
  trim: { start: number; end: number } | null
  mute: boolean
  /**
   * Portrait depth effect re-rendered from the unblurred original and its depth map. `aperture` is the
   * ƒ-number (1.4 strongest … 16 almost none); `focus` is the disparity (0–1) kept sharp. Off renders the
   * original with no blur; absent keeps the iPhone's own render.
   */
  portrait?: { on: boolean; aperture: number; focus: number } | null
}

export const PORTRAIT_APERTURES = [1.4, 1.8, 2, 2.2, 2.8, 3.5, 4, 4.5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16]

/** Blur strength 0…1 for an ƒ-number, matching how the iPhone's Depth slider feels. */
export const portraitStrength = (f: number): number => Math.max(0, Math.min(1, Math.sqrt((16 / f - 1) / (16 / 1.4 - 1))))

export const ADJUST_GROUPS: { title: string; keys: { key: AdjustKey; label: string; min: number }[] }[] = [
  {
    title: 'Light',
    keys: [
      { key: 'exposure', label: 'Exposure', min: -1 },
      { key: 'brilliance', label: 'Brilliance', min: -1 },
      { key: 'highlights', label: 'Highlights', min: -1 },
      { key: 'shadows', label: 'Shadows', min: -1 },
      { key: 'contrast', label: 'Contrast', min: -1 },
      { key: 'brightness', label: 'Brightness', min: -1 },
      { key: 'blackPoint', label: 'Black Point', min: -1 }
    ]
  },
  {
    title: 'Color',
    keys: [
      { key: 'saturation', label: 'Saturation', min: -1 },
      { key: 'vibrance', label: 'Vibrance', min: -1 },
      { key: 'warmth', label: 'Warmth', min: -1 },
      { key: 'tint', label: 'Tint', min: -1 }
    ]
  },
  {
    title: 'Detail',
    keys: [
      { key: 'sharpness', label: 'Sharpness', min: 0 },
      { key: 'definition', label: 'Definition', min: 0 },
      { key: 'noise', label: 'Noise Reduction', min: 0 }
    ]
  },
  { title: 'Vignette', keys: [{ key: 'vignette', label: 'Vignette', min: 0 }] }
]

export type FilterName =
  | 'vivid' | 'vividWarm' | 'vividCool' | 'dramatic' | 'dramaticWarm' | 'dramaticCool' | 'mono' | 'silvertone' | 'noir'

/** Apple's nine filters expressed as adjustment offsets so the photo shader and the ffmpeg video path agree. */
export const FILTERS: { name: FilterName; label: string; adjust: Partial<Record<AdjustKey, number>> }[] = [
  { name: 'vivid', label: 'Vivid', adjust: { saturation: 0.28, vibrance: 0.2, contrast: 0.14 } },
  { name: 'vividWarm', label: 'Vivid Warm', adjust: { saturation: 0.24, vibrance: 0.18, contrast: 0.14, warmth: 0.32 } },
  { name: 'vividCool', label: 'Vivid Cool', adjust: { saturation: 0.24, vibrance: 0.18, contrast: 0.14, warmth: -0.32 } },
  { name: 'dramatic', label: 'Dramatic', adjust: { contrast: 0.32, saturation: -0.22, highlights: -0.3, shadows: -0.12, definition: 0.35 } },
  { name: 'dramaticWarm', label: 'Dramatic Warm', adjust: { contrast: 0.32, saturation: -0.12, highlights: -0.3, shadows: -0.12, definition: 0.35, warmth: 0.35 } },
  { name: 'dramaticCool', label: 'Dramatic Cool', adjust: { contrast: 0.32, saturation: -0.12, highlights: -0.3, shadows: -0.12, definition: 0.35, warmth: -0.38 } },
  { name: 'mono', label: 'Mono', adjust: { saturation: -1, contrast: 0.06 } },
  { name: 'silvertone', label: 'Silvertone', adjust: { saturation: -1, contrast: 0.2, brightness: 0.08, highlights: 0.1, warmth: -0.1 } },
  { name: 'noir', label: 'Noir', adjust: { saturation: -1, contrast: 0.55, blackPoint: 0.25, shadows: -0.2 } }
]

export const ASPECTS: { id: string; label: string; ratio: number | null | 'original' }[] = [
  { id: 'free', label: 'Freeform', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: 'square', label: 'Square', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '5:4', label: '5:4', ratio: 5 / 4 },
  { id: '7:5', label: '7:5', ratio: 7 / 5 }
]

export function emptyRecipe(): EditRecipe {
  return {
    adjust: {}, filter: null, filterAmount: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, rot90: 0,
    flipH: false, flipV: false, size: null, trim: null, mute: false
  }
}

/** Adjustments with the filter folded in. */
export function effectiveAdjust(r: EditRecipe): Record<AdjustKey, number> {
  const out = {} as Record<AdjustKey, number>
  for (const g of ADJUST_GROUPS) for (const k of g.keys) out[k.key] = r.adjust[k.key] ?? 0
  const f = FILTERS.find((x) => x.name === r.filter)
  if (f) for (const [k, v] of Object.entries(f.adjust)) out[k as AdjustKey] = Math.max(-1, Math.min(1, out[k as AdjustKey] + (v ?? 0) * r.filterAmount))
  return out
}

export function isIdentity(r: EditRecipe): boolean {
  const a = effectiveAdjust(r)
  const c = r.crop
  return (
    Object.values(a).every((v) => Math.abs(v) < 1e-4) &&
    Math.abs(c.x) < 1e-4 && Math.abs(c.y) < 1e-4 && Math.abs(c.w - 1) < 1e-4 && Math.abs(c.h - 1) < 1e-4 &&
    Math.abs(r.angle) < 1e-3 && r.rot90 % 4 === 0 && !r.flipH && !r.flipV && !r.size && !r.trim && !r.mute && !r.portrait
  )
}

/** Pixel size of the oriented frame (after quarter turns). */
export function orientedSize(w: number, h: number, rot90: number): { w: number; h: number } {
  return rot90 % 2 ? { w: h, h: w } : { w, h }
}

/** Zoom that keeps a straightened image covering its own frame, like Apple's auto-crop while straightening. */
export function straightenScale(w: number, h: number, angleDeg: number): number {
  const a = Math.abs((angleDeg * Math.PI) / 180)
  const c = Math.cos(a)
  const s = Math.sin(a)
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h)
}

export function outputSize(r: EditRecipe, srcW: number, srcH: number): { w: number; h: number } {
  if (r.size) return r.size
  const o = orientedSize(srcW, srcH, r.rot90)
  return { w: Math.max(1, Math.round(o.w * r.crop.w)), h: Math.max(1, Math.round(o.h * r.crop.h)) }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
const f3 = (n: number): string => n.toFixed(4)

/**
 * ffmpeg filter chain approximating the editor's shader, used for videos and Live Photo motion.
 * Geometry is exact; colour is a close match.
 */
export function ffmpegFilters(r: EditRecipe, srcW: number, srcH: number): string {
  const f: string[] = []
  if (r.flipH) f.push('hflip')
  if (r.flipV) f.push('vflip')
  const q = ((r.rot90 % 4) + 4) % 4
  if (q === 1) f.push('transpose=1')
  if (q === 2) f.push('hflip,vflip')
  if (q === 3) f.push('transpose=2')
  const o = orientedSize(srcW, srcH, q)
  if (Math.abs(r.angle) > 1e-3) {
    const s = straightenScale(o.w, o.h, r.angle)
    f.push(`scale=${even(o.w * s)}:${even(o.h * s)}`)
    f.push(`rotate=${f3((r.angle * Math.PI) / 180)}:ow=${even(o.w)}:oh=${even(o.h)}:c=black`)
  }
  const c = r.crop
  if (c.w < 0.9999 || c.h < 0.9999 || c.x > 1e-4 || c.y > 1e-4) {
    f.push(`crop=${even(o.w * c.w)}:${even(o.h * c.h)}:${Math.round(o.w * c.x)}:${Math.round(o.h * c.y)}`)
  }
  if (r.size) f.push(`scale=${even(r.size.w)}:${even(r.size.h)}:flags=lanczos`)

  const a = effectiveAdjust(r)
  if (a.exposure) {
    const k = f3(Math.pow(2, (a.exposure * 1.5) / 2.2))
    f.push(`colorchannelmixer=rr=${k}:gg=${k}:bb=${k}`)
  }
  const bp = Math.max(0, a.blackPoint) * 0.15
  const sh = a.shadows * 0.12 + a.brilliance * 0.08
  const hi = a.highlights * 0.12 - a.brilliance * 0.06
  if (bp || sh || hi || a.blackPoint < 0) {
    const lo = a.blackPoint < 0 ? -a.blackPoint * 0.08 : 0
    f.push(`curves=all='0/${f3(lo)} ${f3(0.06 + bp)}/0.06 0.25/${f3(Math.min(0.95, Math.max(0.02, 0.25 + sh)))} 0.75/${f3(Math.min(0.98, Math.max(0.3, 0.75 + hi)))} 1/1'`)
  }
  if (a.brightness || a.contrast || a.saturation) {
    f.push(`eq=brightness=${f3(a.brightness * 0.12)}:contrast=${f3(1 + a.contrast * 0.6)}:saturation=${f3(Math.max(0, 1 + a.saturation))}`)
  }
  if (a.vibrance) f.push(`vibrance=intensity=${f3(a.vibrance * 0.8)}`)
  if (a.warmth || a.tint) {
    const w = a.warmth * 0.12
    const t = a.tint * 0.1
    f.push(`colorbalance=rm=${f3(w + t * 0.5)}:gm=${f3(-t)}:bm=${f3(-w + t * 0.5)}`)
  }
  if (a.noise > 0) f.push(`hqdn3d=${f3(a.noise * 6)}`)
  if (a.sharpness > 0 || a.definition > 0) {
    if (a.sharpness > 0) f.push(`unsharp=5:5:${f3(a.sharpness * 1.4)}`)
    if (a.definition > 0) f.push(`unsharp=13:13:${f3(a.definition * 0.6)}`)
  }
  if (a.vignette > 0) f.push(`vignette=angle=${f3(0.25 + a.vignette * 0.75)}`)
  return f.join(',')
}
