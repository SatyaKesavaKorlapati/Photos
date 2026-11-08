import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} />
}

export function Segmented<T extends string>({
  value, options, onChange, small, className = ''
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  small?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState({ left: 0, width: 0 })
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>(`button[data-v="${value}"]`)
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth })
  }, [value, options.length])
  return (
    <div ref={ref} className={`segmented ${small ? 'small' : ''} ${className}`}>
      <div className="thumb" style={{ left: thumb.left, width: thumb.width, opacity: thumb.width ? 1 : 0 }} />
      {options.map((o) => (
        <button key={o.value} data-v={o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24">
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1="12" y1="3" x2="12" y2="7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity={0.2 + (i / 8) * 0.8} transform={`rotate(${i * 45} 12 12)`} />
      ))}
    </svg>
  )
}
