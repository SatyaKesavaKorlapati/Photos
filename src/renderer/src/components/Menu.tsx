import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { setState, useStore, type MenuItem } from '../store'

export function openMenu(e: { clientX: number; clientY: number } | DOMRect, items: MenuItem[], align: 'left' | 'right' = 'left'): void {
  if ('clientX' in e) setState({ menu: { x: e.clientX, y: e.clientY, items, align } })
  else setState({ menu: { x: align === 'right' ? e.right : e.left, y: e.bottom + 6, above: e.top - 6, items, align } })
}

export function closeMenu(): void {
  setState({ menu: null })
}

function MenuList({ items, x, y, above, align, onClose, sub }: { items: MenuItem[]; x: number; y: number; above?: number; align?: 'left' | 'right'; onClose: () => void; sub?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, origin: 'top left' })
  const [openSub, setOpenSub] = useState<{ index: number; rect: DOMRect } | null>(null)
  const timer = useRef<number>(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Layout size, not getBoundingClientRect: the pop-in scale transform would under-report it.
    const r = { width: el.offsetWidth, height: el.offsetHeight }
    let left = align === 'right' ? x - r.width : x
    let top = y
    let oy0 = y
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8
    if (top + r.height > window.innerHeight - 8) {
      const bottom = above ?? y - 12
      top = Math.max(8, Math.min(bottom - r.height, window.innerHeight - r.height - 8))
      oy0 = bottom
    }
    left = Math.max(8, left)
    // The menu grows out of the point that opened it, like iOS 26.
    const ox = Math.max(0, Math.min(r.width, x - left))
    const oy = Math.max(0, Math.min(r.height, oy0 - top))
    setPos({ left, top, origin: `${ox}px ${oy}px` })
  }, [x, y, above, align, items])

  const hasChecks = items.some((i) => i.checked !== undefined)
  const hasIcons = items.some((i) => i.icon && !i.quick)

  return (
    <>
      <div
        ref={ref}
        className={`menu${sub ? ' sub' : ''}`}
        style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (it.quick) {
            return (
              <div key={i} className="quick-row">
                {it.quick.map((q, j) => (
                  <button
                    key={j}
                    className={`qa${q.danger ? ' danger' : ''}`}
                    disabled={q.disabled}
                    onClick={() => {
                      onClose()
                      q.onClick?.()
                    }}
                  >
                    {q.icon}
                    <span>{q.label}</span>
                  </button>
                ))}
              </div>
            )
          }
          if (it.separator) return <div key={i} className="sep" />
          if (it.header) return <div key={i} className="mh">{it.label}</div>
          return (
            <button
              key={i}
              className={`mi${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${openSub?.index === i ? ' open' : ''}`}
              onMouseEnter={(e) => {
                window.clearTimeout(timer.current)
                const rect = e.currentTarget.getBoundingClientRect()
                timer.current = window.setTimeout(() => setOpenSub(it.submenu ? { index: i, rect } : null), it.submenu ? 80 : 120)
              }}
              onClick={(e) => {
                if (it.disabled) return
                if (it.submenu) {
                  setOpenSub({ index: i, rect: e.currentTarget.getBoundingClientRect() })
                  return
                }
                onClose()
                it.onClick?.()
              }}
            >
              {hasChecks && <span className="chk">{it.checked ? <Check size={13} strokeWidth={2.6} /> : null}</span>}
              {hasIcons && <span className="mico">{it.icon}</span>}
              <span className="ml">{it.label}</span>
              {it.shortcut && <span className="sc">{it.shortcut}</span>}
              {it.submenu && <ChevronRight size={13} style={{ marginLeft: 12, opacity: 0.7 }} />}
            </button>
          )
        })}
      </div>
      {openSub && items[openSub.index]?.submenu && (
        <MenuList items={items[openSub.index].submenu!} x={openSub.rect.right + 2} y={openSub.rect.top - 5} onClose={onClose} sub />
      )}
    </>
  )
}

export function MenuLayer() {
  const menu = useStore((s) => s.menu)
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])
  if (!menu) return null
  return (
    <div className="menu-layer" onMouseDown={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu() }}>
      <MenuList items={menu.items} x={menu.x} y={menu.y} above={menu.above} align={menu.align} onClose={closeMenu} />
    </div>
  )
}
