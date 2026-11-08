import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

/** Apple's Live Photo glyph: a solid dot, a ring, and a dotted outer ring. */
export function LiveIcon({ size = 16, off, ...p }: P & { off?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      <circle cx="12" cy="12" r="5.6" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="9.4" stroke="currentColor" strokeWidth="1.7" strokeDasharray="0.1 2.95" strokeLinecap="round" />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  )
}

export function LoopIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M17 2.5l3 3-3 3" />
      <path d="M4 11.5v-1a5 5 0 0 1 5-5h11" />
      <path d="M7 21.5l-3-3 3-3" />
      <path d="M20 12.5v1a5 5 0 0 1-5 5H4" />
    </svg>
  )
}

export function BounceIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 12h18" />
      <path d="M7 8l-4 4 4 4" />
      <path d="M17 8l4 4-4 4" />
    </svg>
  )
}

export function LongExposureIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17" fill="currentColor" opacity="0.5" stroke="none" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  )
}

/** Portrait depth glyph (ƒ in a rounded cube). */
export function PortraitIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" {...p}>
      <path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" />
      <path d="M14.2 8.2c-1.6-.5-2.6.2-2.8 1.7l-.9 6.2c-.2 1.4-1.1 2-2.5 1.6M9.6 11.2h4.2" strokeLinecap="round" />
    </svg>
  )
}

export function PanoramaIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" {...p}>
      <path d="M2.5 6.5c6.3 1.6 12.7 1.6 19 0v11c-6.3-1.6-12.7-1.6-19 0z" />
    </svg>
  )
}

export function SlomoIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}>
      {Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2
        const r1 = i % 4 === 0 ? 5.5 : 7
        return <line key={i} x1={12 + Math.cos(a) * r1} y1={12 + Math.sin(a) * r1} x2={12 + Math.cos(a) * 9} y2={12 + Math.sin(a) * 9} />
      })}
    </svg>
  )
}

export function CinematicIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="M15.5 10.5l6-3.5v10l-6-3.5" />
      <text x="9" y="15.2" fontSize="7.5" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="Inter Variable, sans-serif">ƒ</text>
    </svg>
  )
}

export function BurstIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" {...p}>
      <rect x="7" y="7" width="13" height="13" rx="2" />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

export function RawIcon({ size = 16, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="3" />
      <text x="12" y="14.8" fontSize="7" fontWeight="800" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="Inter Variable, sans-serif">RAW</text>
    </svg>
  )
}

export function SidebarIcon({ size = 18, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <rect x="2.75" y="4.25" width="18.5" height="15.5" rx="3.5" />
      <path d="M9.25 4.5v15" />
      <path d="M5.25 8h1.75M5.25 11h1.75M5.25 14h1.75" strokeLinecap="round" />
    </svg>
  )
}

/** The Photos flower, used in the empty state and sidebar. */
export function PhotosFlower({ size = 64 }: { size?: number }) {
  const colors = ['#f6a53a', '#f8d33c', '#a6d84a', '#4dbb8c', '#4ea8f2', '#8f72f0', '#ea5c8c', '#f06d4f']
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      {colors.map((c, i) => (
        <g key={i} transform={`rotate(${i * 45} 50 50)`}>
          <rect x="38" y="8" width="24" height="42" rx="12" fill={c} opacity="0.9" style={{ mixBlendMode: 'multiply' }} />
        </g>
      ))}
    </svg>
  )
}
