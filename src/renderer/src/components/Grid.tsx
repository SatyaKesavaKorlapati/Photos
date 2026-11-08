import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Heart, Check, ChevronUp, ChevronDown } from 'lucide-react'
import { bounceUrl, liveUrl, previewUrl, thumbUrl } from '../api'
import { assetMenu, hide, openEditor, rotate, toggleFavorite, trash, purge } from '../actions'
import { getState, openViewer, setState, useStore } from '../store'
import type { GridAsset } from '../types'
import { formatDuration } from '../util'
import { LiveIcon } from './Icons'
import { openMenu } from './Menu'

const SIZES = [440, 330, 260, 210, 170, 136, 108, 82, 58]
const GAP = 2
/** Room for the floating toolbar; the grid scrolls underneath it. */
export const GRID_TOP = 62
const GRID_BOTTOM = 110

interface CellProps {
  a: GridAsset
  size: number
  selected: boolean
  selectMode: boolean
  fit: boolean
  badges: boolean
  autoplayLive: boolean
  onDown: (e: React.MouseEvent, a: GridAsset) => void
  onEnter: (a: GridAsset) => void
  onOpen: (e: React.MouseEvent, a: GridAsset) => void
  onContext: (e: React.MouseEvent, a: GridAsset) => void
  onDragStart: (e: React.DragEvent, a: GridAsset) => void
}

const withParam = (url: string, k: string, v: string | number): string => `${url}${url.includes('?') ? '&' : '?'}${k}=${v}`

const Cell = memo(function Cell({ a, size, selected, selectMode, fit, badges, autoplayLive, onDown, onEnter, onOpen, onContext, onDragStart }: CellProps) {
  const [loaded, setLoaded] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [retry, setRetry] = useState(0)
  const timer = useRef<number>(0)
  const canPlay = !!a.live && a.live !== 'longexposure' && a.live !== 'off' && autoplayLive && !selectMode
  const rot = a.rot ? { transform: `rotate(${-a.rot}deg)${a.rot % 180 && fit ? ` scale(${a.h && a.w ? Math.min(a.w, a.h) / Math.max(a.w, a.h) : 1})` : ''}` } : undefined
  const src = size * devicePixelRatio > 420 && !a.video ? previewUrl(a.id) : thumbUrl(a.id)
  return (
    <div
      className={`cell${selected ? ' selected' : ''}${fit ? ' fit' : ''}${selectMode ? ' selecting' : ''}`}
      style={{ width: size, height: size }}
      data-id={a.id}
      onMouseDown={(e) => onDown(e, a)}
      onDoubleClick={(e) => onOpen(e, a)}
      onContextMenu={(e) => onContext(e, a)}
      draggable={!selectMode}
      onDragStart={(e) => onDragStart(e, a)}
      onMouseEnter={() => {
        onEnter(a)
        if (canPlay) timer.current = window.setTimeout(() => setPlaying(true), 350)
      }}
      onMouseLeave={() => {
        window.clearTimeout(timer.current)
        setPlaying(false)
      }}
    >
      <img
        key={retry}
        src={retry ? withParam(src, 'r', retry) : src}
        className={loaded ? '' : 'loading'}
        style={rot}
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => retry < 3 && window.setTimeout(() => setRetry((r) => r + 1), 1500 * (retry + 1))}
      />
      {playing && (
        <video
          src={a.live === 'bounce' ? bounceUrl(a.id) : liveUrl(a.id)}
          muted
          autoPlay
          loop={a.live === 'loop' || a.live === 'bounce'}
          playsInline
          style={rot}
          onEnded={() => setPlaying(false)}
        />
      )}
      {badges && a.video && <div className="badge-tr">{formatDuration(a.dur)}</div>}
      {badges && a.live && size >= 80 && (
        <div className="badge-tl"><LiveIcon size={size > 150 ? 17 : 14} off={a.live === 'off'} /></div>
      )}
      {a.fav && size >= 60 && (
        <div className="badge-bl"><Heart size={size > 150 ? 15 : 12} fill="#fff" strokeWidth={0} /></div>
      )}
      {(selected || selectMode) && size >= 56 && (
        <div className={`check${selected ? ' on' : ''}`}>{selected && <Check size={13} strokeWidth={3.2} />}</div>
      )}
    </div>
  )
})

const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Animated scroll that covers any distance in under a second (native smooth scrolling crawls on long jumps). */
export function glide(el: HTMLElement, to: number, ms?: number): void {
  const from = el.scrollTop
  const dist = to - from
  if (Math.abs(dist) < 2) return
  const dur = ms ?? Math.min(900, 280 + Math.sqrt(Math.abs(dist)) * 6)
  const t0 = performance.now()
  const ease = (t: number) => 1 - Math.pow(1 - t, 4)
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur)
    el.scrollTop = from + dist * ease(t)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/**
 * iPhone-style scroll scrubber: appears while scrolling, can be grabbed and dragged through the whole
 * timeline with a date bubble, and double-clicking the track glides there.
 */
function Scrubber({ scroller, dateAt }: { scroller: HTMLDivElement | null; dateAt: (scrollTop: number) => string }) {
  const [, force] = useState(0)
  const [visible, setVisible] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [label, setLabel] = useState('')
  const hideTimer = useRef<number>(0)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!scroller) return
    const on = () => {
      force((x) => x + 1)
      setVisible(true)
      window.clearTimeout(hideTimer.current)
      hideTimer.current = window.setTimeout(() => setVisible(false), 1300)
    }
    scroller.addEventListener('scroll', on, { passive: true })
    return () => scroller.removeEventListener('scroll', on)
  }, [scroller])

  if (!scroller) return null
  const max = scroller.scrollHeight - scroller.clientHeight
  if (max < scroller.clientHeight * 1.5) return null
  const trackH = (trackRef.current?.clientHeight ?? scroller.clientHeight - GRID_TOP - 24) || 1
  const handleH = 44
  const p = max > 0 ? scroller.scrollTop / max : 0
  const top = p * (trackH - handleH)

  const toScroll = (clientY: number, grab: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    const q = Math.max(0, Math.min(1, (clientY - r.top - grab) / (r.height - handleH)))
    return q * max
  }

  return (
    <div
      className={`scrubber${visible || dragging ? ' on' : ''}${dragging ? ' dragging' : ''}`}
      onMouseEnter={() => {
        window.clearTimeout(hideTimer.current)
        setVisible(true)
      }}
      onMouseLeave={() => {
        if (!dragging) hideTimer.current = window.setTimeout(() => setVisible(false), 900)
      }}
    >
      <div
        ref={trackRef}
        className="scrub-track"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.scrub-handle')) return
          glide(scroller, toScroll(e.clientY, handleH / 2))
        }}
      >
        <div
          className="scrub-handle glass"
          style={{ top }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            const grab = e.clientY - r.top
            setDragging(true)
            setLabel(dateAt(scroller.scrollTop))
            const move = (ev: PointerEvent) => {
              scroller.scrollTop = toScroll(ev.clientY, grab)
              setLabel(dateAt(scroller.scrollTop))
            }
            const up = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              setDragging(false)
              hideTimer.current = window.setTimeout(() => setVisible(false), 1100)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            glide(scroller, scroller.scrollTop > max / 2 ? 0 : max)
          }}
          title="Drag to scrub · Double-click to jump to the other end"
        >
          <ChevronUp size={11} strokeWidth={3} />
          <ChevronDown size={11} strokeWidth={3} />
        </div>
        {dragging && (
          <div className="scrub-bubble glass-strong" key={label} style={{ top: top + handleH / 2 }}>
            {label}
          </div>
        )}
      </div>
    </div>
  )
}

/** Middle-click continuous scrolling, as in Windows apps: speed follows the pointer's distance from the anchor. */
function useAutoScroll(el: HTMLDivElement | null): { x: number; y: number } | null {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!el) return
    const down = (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      if (anchor) return setAnchor(null)
      const r = el.getBoundingClientRect()
      setAnchor({ x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('mousedown', down)
    return () => el.removeEventListener('mousedown', down)
  }, [el, anchor])
  useEffect(() => {
    if (!el || !anchor) return
    let dy = 0
    let raf = 0
    const r = el.getBoundingClientRect()
    const move = (e: MouseEvent) => {
      const d = e.clientY - r.top - anchor.y
      dy = Math.abs(d) < 12 ? 0 : Math.sign(d) * Math.pow((Math.abs(d) - 12) / 12, 1.6)
    }
    const stop = (e: Event) => {
      if (e instanceof MouseEvent && e.button === 1) return
      setAnchor(null)
    }
    const tick = () => {
      el.scrollTop += dy
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    window.addEventListener('mousemove', move)
    window.addEventListener('mousedown', stop, true)
    window.addEventListener('keydown', stop, true)
    window.addEventListener('wheel', stop, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mousedown', stop, true)
      window.removeEventListener('keydown', stop, true)
      window.removeEventListener('wheel', stop, true)
    }
  }, [el, anchor])
  return anchor
}

export function PhotoGrid({
  items, scrollToEnd, onVisibleRange, emptyText
}: {
  items: GridAsset[]
  scrollToEnd?: boolean
  onVisibleRange?: (r: [number, number] | null) => void
  emptyText?: React.ReactNode
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const zoom = useStore((s) => s.zoom)
  const selection = useStore((s) => s.selection)
  const selectMode = useStore((s) => s.selectMode)
  const settings = useStore((s) => s.settings)
  const source = useStore((s) => s.source)
  const scrollTarget = useStore((s) => s.scrollTarget)
  const viewerOpen = useStore((s) => !!s.viewer || !!s.editor)
  const sheetOpen = useStore((s) => !!s.sheet)
  const autoAnchor = useAutoScroll(scrollEl)

  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return
    setScrollEl(el)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(1, Math.round((width + GAP) / (SIZES[zoom - 1] + GAP)))
  const cell = width ? (width - GAP * (cols - 1)) / cols : 0
  const rows = Math.ceil(items.length / cols)

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cell + GAP,
    overscan: 3,
    paddingStart: GRID_TOP,
    paddingEnd: GRID_BOTTOM,
    scrollPaddingStart: GRID_TOP
  })

  // Keep the first visible photo in place when the zoom level or the list order changes,
  // and stay pinned to the newest photos when already scrolled to the bottom.
  const anchorRef = useRef<number | null>(null)
  const atBottomRef = useRef(!!scrollToEnd)
  const prevCols = useRef(cols)
  const prevItems = useRef(items)
  useLayoutEffect(() => {
    virt.measure()
    const colsChanged = prevCols.current !== cols
    const itemsChanged = prevItems.current !== items
    prevCols.current = cols
    prevItems.current = items
    if (!colsChanged && !itemsChanged) return
    if (atBottomRef.current && scrollToEnd && rows) {
      virt.scrollToOffset(virt.getTotalSize())
      return
    }
    if (anchorRef.current === null) return
    const idx = items.findIndex((a) => a.id === anchorRef.current)
    if (idx >= 0) virt.scrollToIndex(Math.floor(idx / cols), { align: 'start' })
  }, [cols, cell, items])

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const on = () => {
      atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
    }
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [])

  // Double-clicking the toolbar title glides to the newest photos (like tapping the tab on iPhone), or back to the top.
  useEffect(() => {
    const on = () => {
      const el = parentRef.current
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      glide(el, scrollToEnd ? (el.scrollTop > max - 20 ? 0 : max) : el.scrollTop < 20 ? max : 0)
    }
    window.addEventListener('grid:jump', on)
    return () => window.removeEventListener('grid:jump', on)
  }, [scrollToEnd])

  const didInitialScroll = useRef<string>('')
  useEffect(() => {
    if (!rows || !cell) return
    const key = `${source}`
    if (didInitialScroll.current === key) return
    didInitialScroll.current = key
    if (scrollTarget !== null) {
      const idx = items.findIndex((a) => a.id === scrollTarget)
      if (idx >= 0) {
        requestAnimationFrame(() => virt.scrollToIndex(Math.floor(idx / cols), { align: 'center' }))
        setState({ selection: new Set([scrollTarget]), anchor: scrollTarget, scrollTarget: null })
        return
      }
    }
    if (scrollToEnd) requestAnimationFrame(() => virt.scrollToOffset(virt.getTotalSize()))
  }, [rows, cell, source, scrollTarget])

  // When the viewer closes, make sure the photo it ended on is on screen.
  const prevViewer = useRef(viewerOpen)
  useEffect(() => {
    if (prevViewer.current && !viewerOpen) {
      const id = getState().anchor
      const idx = id !== null ? items.findIndex((a) => a.id === id) : -1
      const el = parentRef.current
      if (idx >= 0 && el) {
        const rowTop = GRID_TOP + Math.floor(idx / cols) * (cell + GAP)
        if (rowTop < el.scrollTop + GRID_TOP || rowTop + cell > el.scrollTop + el.clientHeight) virt.scrollToIndex(Math.floor(idx / cols), { align: 'center' })
      }
    }
    prevViewer.current = viewerOpen
  }, [viewerOpen])

  const vItems = virt.getVirtualItems()
  const anchorLayout = useRef({ cols, items })
  useEffect(() => {
    if (!vItems.length) {
      onVisibleRange?.(null)
      return
    }
    const top = (parentRef.current?.scrollTop ?? 0) + GRID_TOP
    const first = vItems.find((v) => v.end > top) ?? vItems[0]
    const startIdx = first.index * cols
    // Right after a relayout the scroll offset still belongs to the old layout, so it would name the wrong photo.
    const relayout = anchorLayout.current.cols !== cols || anchorLayout.current.items !== items
    anchorLayout.current = { cols, items }
    if (!relayout) anchorRef.current = items[startIdx]?.id ?? null
    const viewH = parentRef.current?.clientHeight ?? 0
    const bottom = (parentRef.current?.scrollTop ?? 0) + viewH - GRID_BOTTOM
    const lastRow = [...vItems].reverse().find((v) => v.start < bottom) ?? vItems[vItems.length - 1]
    const endIdx = Math.min(items.length - 1, lastRow.index * cols + cols - 1)
    if (items[startIdx] && items[endIdx]) onVisibleRange?.([items[startIdx].t, items[endIdx].t])
  }, [vItems[0]?.index, vItems[vItems.length - 1]?.index, items, cols])

  const indexOf = useMemo(() => {
    const m = new Map<number, number>()
    items.forEach((a, i) => m.set(a.id, i))
    return m
  }, [items])

  const dateAt = useCallback(
    (scrollTop: number) => {
      const row = Math.max(0, Math.floor((scrollTop + GRID_TOP) / (cell + GAP)))
      const a = items[Math.min(items.length - 1, row * cols)]
      if (!a) return ''
      return zoom <= 3 ? DAY.format(a.t) : MONTH.format(a.t)
    },
    [items, cols, cell, zoom]
  )

  // Swipe-to-select in Select mode: drag across photos to add (or remove) the whole range.
  const paint = useRef<{ from: number; add: boolean; base: Set<number> } | null>(null)
  useEffect(() => {
    const up = () => (paint.current = null)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const onDown = useCallback(
    (e: React.MouseEvent, a: GridAsset) => {
      if (e.button === 2) {
        if (!getState().selection.has(a.id)) setState({ selection: new Set([a.id]), anchor: a.id })
        return
      }
      if (e.button !== 0) return
      const s = getState()
      if (s.selectMode && !e.shiftKey) {
        e.preventDefault()
        const add = !s.selection.has(a.id)
        const next = new Set(s.selection)
        add ? next.add(a.id) : next.delete(a.id)
        paint.current = { from: indexOf.get(a.id) ?? 0, add, base: new Set(s.selection) }
        setState({ selection: next, anchor: a.id })
        return
      }
      if (e.shiftKey && s.anchor !== null) {
        const i0 = indexOf.get(s.anchor) ?? 0
        const i1 = indexOf.get(a.id) ?? 0
        const [lo, hi] = i0 < i1 ? [i0, i1] : [i1, i0]
        const next = new Set(e.ctrlKey || e.metaKey || s.selectMode ? s.selection : [])
        for (let i = lo; i <= hi; i++) next.add(items[i].id)
        setState({ selection: next })
      } else if (e.ctrlKey || e.metaKey) {
        const next = new Set(s.selection)
        next.has(a.id) ? next.delete(a.id) : next.add(a.id)
        setState({ selection: next, anchor: a.id })
      } else if (!s.selection.has(a.id) || s.selection.size === 1) {
        setState({ selection: new Set([a.id]), anchor: a.id })
      }
    },
    [items, indexOf]
  )

  const onEnter = useCallback(
    (a: GridAsset) => {
      const p = paint.current
      if (!p) return
      const j = indexOf.get(a.id) ?? 0
      const [lo, hi] = p.from < j ? [p.from, j] : [j, p.from]
      const next = new Set(p.base)
      for (let i = lo; i <= hi; i++) (p.add ? next.add(items[i].id) : next.delete(items[i].id))
      setState({ selection: next })
    },
    [items, indexOf]
  )

  const onOpen = useCallback(
    (e: React.MouseEvent, a: GridAsset) => {
      if (getState().selectMode) return
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      openViewer(items.map((x) => x.id), a.id, getState().source, rect)
    },
    [items]
  )

  const onContext = useCallback((e: React.MouseEvent, a: GridAsset) => {
    e.preventDefault()
    const sel = getState().selection
    const ids = sel.has(a.id) ? [...sel] : [a.id]
    openMenu(e, assetMenu(ids))
  }, [])

  const onDragStart = useCallback((e: React.DragEvent, a: GridAsset) => {
    const sel = getState().selection
    const ids = sel.has(a.id) ? [...sel] : [a.id]
    e.dataTransfer.setData('application/x-photos-ids', JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'copy'
    const img = (e.currentTarget as HTMLElement).querySelector('img')
    if (img) e.dataTransfer.setDragImage(img, 30, 30)
  }, [])

  // Ctrl/⌘ + wheel or trackpad pinch zooms the grid.
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    let acc = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      acc += e.deltaY
      if (Math.abs(acc) > 40) {
        const z = getState().zoom
        setState({ zoom: Math.max(1, Math.min(9, z + (acc > 0 ? 1 : -1))) })
        acc = 0
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Keyboard navigation, Apple Photos shortcuts.
  useEffect(() => {
    if (viewerOpen || sheetOpen) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
      if (getState().menu) return
      const s = getState()
      const ids = [...s.selection]
      const ctrl = e.ctrlKey || e.metaKey
      const cur = s.anchor !== null ? indexOf.get(s.anchor) ?? -1 : -1
      const move = (d: number) => {
        e.preventDefault()
        const next = Math.max(0, Math.min(items.length - 1, (cur < 0 ? (d > 0 ? -1 : items.length) : cur) + d))
        const id = items[next]?.id
        if (id === undefined) return
        if (e.shiftKey || s.selectMode) setState({ selection: new Set([...s.selection, id]), anchor: id })
        else setState({ selection: new Set([id]), anchor: id })
        virt.scrollToIndex(Math.floor(next / cols))
      }
      if (e.key === 'ArrowRight') return move(1)
      if (e.key === 'ArrowLeft') return move(-1)
      if (e.key === 'ArrowDown') return move(cols)
      if (e.key === 'ArrowUp') return move(-cols)
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        const el = parentRef.current
        if (el) glide(el, e.key === 'Home' ? 0 : el.scrollHeight)
        return
      }
      if ((e.key === 'Enter' || e.key === ' ') && s.anchor !== null && !s.selectMode) {
        e.preventDefault()
        const node = parentRef.current?.querySelector<HTMLElement>(`.cell[data-id="${s.anchor}"]`)
        openViewer(items.map((x) => x.id), s.anchor, s.source, node?.getBoundingClientRect())
        return
      }
      if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setState({ selection: new Set(items.map((a) => a.id)) })
        return
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        return setState({ selectMode: !s.selectMode, selection: new Set() })
      }
      if (e.key === 'Escape') return setState({ selection: new Set(), infoOpen: false, selectMode: false })
      if (!ids.length) return
      if (e.key === '.') return void toggleFavorite(ids)
      if (ctrl && e.key.toLowerCase() === 'e' && ids.length === 1) { e.preventDefault(); return openEditor(ids[0]) }
      if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); return void rotate(ids, e.altKey ? 90 : -90) }
      if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); return void hide(ids, s.source !== 'hidden') }
      if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); return setState({ infoOpen: !s.infoOpen }) }
      if (e.key === 'Delete' || (e.key === 'Backspace' && ctrl)) {
        e.preventDefault()
        return void (s.source === 'deleted' ? purge(ids) : trash(ids))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, indexOf, cols, viewerOpen, sheetOpen])

  const fit = settings ? !settings.squareThumbs : false
  const badges = settings?.showLiveBadges ?? true
  const autoplayLive = settings?.autoplayLive ?? true

  return (
    <>
      <div
        ref={parentRef}
        className={`scroller grid-scroller${autoAnchor ? ' autoscroll' : ''}`}
        onMouseDown={(e) => {
          if ((e.target === e.currentTarget || (e.target as HTMLElement).dataset.blank) && e.button === 0 && !getState().selectMode) {
            setState({ selection: new Set(), anchor: null })
          }
        }}
      >
        {!items.length && emptyText}
        <div style={{ height: virt.getTotalSize(), position: 'relative' }} data-blank="1">
          {cell > 0 &&
            vItems.map((row) => {
              const start = row.index * cols
              const slice = items.slice(start, start + cols)
              return (
                <div key={row.key} className="grid-row" style={{ top: row.start, height: cell }} data-blank="1">
                  {slice.map((a) => (
                    <Cell
                      key={a.id}
                      a={a}
                      size={cell}
                      selected={selection.has(a.id)}
                      selectMode={selectMode}
                      fit={fit}
                      badges={badges}
                      autoplayLive={autoplayLive}
                      onDown={onDown}
                      onEnter={onEnter}
                      onOpen={onOpen}
                      onContext={onContext}
                      onDragStart={onDragStart}
                    />
                  ))}
                </div>
              )
            })}
        </div>
      </div>
      {autoAnchor && <div className="autoscroll-anchor" style={{ left: autoAnchor.x, top: autoAnchor.y }} />}
      <Scrubber scroller={scrollEl} dateAt={dateAt} />
    </>
  )
}
