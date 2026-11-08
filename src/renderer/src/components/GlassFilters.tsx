import { useEffect, useMemo } from 'react'

/** Convex-lens displacement map: the rim bends whatever sits behind a glass control. */
function lensDataUrl(): string {
  const s = 96
  const c = document.createElement('canvas')
  c.width = s
  c.height = s
  const g = c.getContext('2d')!
  const img = g.createImageData(s, s)
  const d = img.data
  const cx = (s - 1) / 2
  const cy = (s - 1) / 2
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const nx = (x - cx) / cx
      const ny = (y - cy) / cy
      const r = Math.min(1, Math.hypot(nx, ny))
      const fall = r * r * (3 - 2 * r)
      const i = (y * s + x) * 4
      d[i] = Math.max(0, Math.min(255, 128 + nx * 110 * fall))
      d[i + 1] = Math.max(0, Math.min(255, 128 + ny * 110 * fall))
      d[i + 2] = 128
      d[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

/** SVG backdrop filters that warp and prism the content behind `.glass` elements. */
export function GlassFilters({ scale }: { scale: number }) {
  const href = useMemo(() => (typeof document === 'undefined' ? '' : lensDataUrl()), [])
  useEffect(() => {
    const el = document.getElementById('lg-disp')
    if (el) el.setAttribute('scale', String(scale))
    const chroma = document.getElementById('lg-chroma')
    if (chroma) chroma.setAttribute('dx', String(Math.max(0.2, scale * 0.045)))
  }, [scale])
  if (!href) return null
  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute', pointerEvents: 'none' }}>
      <filter id="lg-refract" x="-16%" y="-16%" width="132%" height="132%" colorInterpolationFilters="sRGB">
        <feImage href={href} result="map" preserveAspectRatio="none" />
        <feDisplacementMap id="lg-disp" in="SourceGraphic" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="G" result="warp" />
        <feOffset in="warp" dx="0.8" dy="0" result="r" />
        <feOffset id="lg-chroma" in="warp" dx="-0.6" dy="0.3" result="b" />
        <feColorMatrix in="r" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="rc" />
        <feColorMatrix in="warp" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="gc" />
        <feColorMatrix in="b" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="bc" />
        <feBlend in="rc" in2="gc" mode="screen" result="rg" />
        <feBlend in="rg" in2="bc" mode="screen" />
      </filter>
    </svg>
  )
}
