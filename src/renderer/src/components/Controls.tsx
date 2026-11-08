import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} />
}

/**
 * iOS 26 segmented control. The selection is a liquid-glass lens: it lifts, stretches in the
 * direction of travel and settles with an overshoot, and it can be dragged across the options.
 */
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
  const [moving, setMoving] = useState<'' | 'l' | 'r'>('')
  const [drag, setDrag] = useState<{ left: number; width: number } | null>(null)
  const prev = useRef<number | null>(null)
  const movingTimer = useRef<number>(0)
  const suppressClick = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>(`button[data-v="${value}"]`)
    if (!el) return
    const next = { left: el.offsetLeft, width: el.offsetWidth }
    if (prev.current !== null && prev.current !== next.left) {
      setMoving(next.left > prev.current ? 'r' : 'l')
      window.clearTimeout(movingTimer.current)
      movingTimer.current = window.setTimeout(() => setMoving(''), 560)
    }
    prev.current = next.left
    setThumb(next)
  }, [value, options.length])

  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-v]') ?? [])]
  const nearest = (cx: number) => {
    let best: HTMLButtonElement | null = null
    let d = Infinity
    for (const b of buttons()) {
      const c = b.offsetLeft + b.offsetWidth / 2
      if (Math.abs(c - cx) < d) {
        d = Math.abs(c - cx)
        best = b
      }
    }
    return best
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !ref.current) return
    const host = ref.current
    const rect = host.getBoundingClientRect()
    const startX = e.clientX
    const onThumb = Math.abs(e.clientX - rect.left - (thumb.left + thumb.width / 2)) < thumb.width / 2
    let dragging = false
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 4) return
      if (!dragging && !onThumb) return
      dragging = true
      const cx = Math.max(0, Math.min(host.clientWidth, ev.clientX - rect.left))
      const n = nearest(cx)
      const width = n ? n.offsetWidth : thumb.width
      setDrag({ left: Math.max(4, Math.min(host.clientWidth - width - 4, cx - width / 2)), width })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!dragging) return
      suppressClick.current = true
      window.setTimeout(() => (suppressClick.current = false), 0)
      const n = nearest(Math.max(0, Math.min(host.clientWidth, ev.clientX - rect.left)))
      setDrag(null)
      const v = n?.dataset.v as T | undefined
      if (v && v !== value) onChange(v)
      else setMoving(ev.clientX > startX ? 'l' : 'r')
      window.setTimeout(() => setMoving(''), 560)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const t = drag ?? thumb
  return (
    <div ref={ref} className={`segmented ${small ? 'small' : ''} ${className}`} onPointerDown={onPointerDown}>
      <div
        className={`thumb${drag ? ' lifted' : ''}${moving ? ` moving ${moving}` : ''}`}
        style={{ left: t.left, width: t.width, opacity: t.width ? 1 : 0 }}
      >
        <span className="lens" />
      </div>
      {options.map((o) => (
        <button
          key={o.value}
          data-v={o.value}
          className={o.value === value ? 'on' : ''}
          onClick={() => !suppressClick.current && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Apple-style slider with a centre detent for bipolar values; double-click resets. */
export function AdjustSlider({
  label, value, min, onChange, onCommit, disabled
}: {
  label: string
  value: number
  min: number
  onChange: (v: number) => void
  onCommit?: () => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const pct = (value - min) / (1 - min)
  const zero = (0 - min) / (1 - min)
  const set = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    let v = min + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (1 - min)
    if (Math.abs(v) < 0.025) v = 0
    onChange(Math.round(v * 100) / 100)
  }
  return (
    <div className={`adj${disabled ? ' disabled' : ''}${value !== 0 ? ' changed' : ''}`} onDoubleClick={() => { onChange(0); onCommit?.() }}>
      <div className="adj-head">
        <span>{label}</span>
        <span className="v">{value === 0 ? '0' : (value > 0 ? '+' : '') + Math.round(value * 100)}</span>
      </div>
      <div
        ref={ref}
        className="adj-track"
        onPointerDown={(e) => {
          if (disabled) return
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          set(e.clientX)
          const move = (ev: PointerEvent) => set(ev.clientX)
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            onCommit?.()
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      >
        <div className="fill" style={{ left: `${Math.min(zero, pct) * 100}%`, width: `${Math.abs(pct - zero) * 100}%` }} />
        {min < 0 && <div className="mid" />}
        <div className="knob" style={{ left: `${pct * 100}%` }} />
      </div>
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
