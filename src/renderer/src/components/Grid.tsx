import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Heart, Check } from 'lucide-react'
import { bounceUrl, liveUrl, previewUrl, thumbUrl } from '../api'
import { assetMenu, hide, rotate, toggleFavorite, trash, purge } from '../actions'
import { getState, openViewer, setState, useStore } from '../store'
import type { GridAsset } from '../types'
import { formatDuration } from '../util'
import { LiveIcon } from './Icons'
import { openMenu } from './Menu'

const SIZES = [440, 330, 260, 210, 170, 136, 108, 82, 58]
const GAP = 2

interface CellProps {
  a: GridAsset
  size: number
  selected: boolean
  fit: boolean
  badges: boolean
  autoplayLive: boolean
  onDown: (e: React.MouseEvent, a: GridAsset) => void
  onOpen: (a: GridAsset) => void
  onContext: (e: React.MouseEvent, a: GridAsset) => void
  onDragStart: (e: React.DragEvent, a: GridAsset) => void
}

const Cell = memo(function Cell({ a, size, selected, fit, badges, autoplayLive, onDown, onOpen, onContext, onDragStart }: CellProps) {
  const [loaded, setLoaded] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [retry, setRetry] = useState(0)
  const timer = useRef<number>(0)
  const canPlay = !!a.live && a.live !== 'longexposure' && a.live !== 'off' && autoplayLive
  const rot = a.rot ? { transform: `rotate(${-a.rot}deg)${a.rot % 180 && fit ? ` scale(${a.h && a.w ? Math.min(a.w, a.h) / Math.max(a.w, a.h) : 1})` : ''}` } : undefined
  return (
    <div
      className={`cell${selected ? ' selected' : ''}${fit ? ' fit' : ''}`}
      style={{ width: size, height: size }}
      onMouseDown={(e) => onDown(e, a)}
      onDoubleClick={() => onOpen(a)}
      onContextMenu={(e) => onContext(e, a)}
      draggable
      onDragStart={(e) => onDragStart(e, a)}
      onMouseEnter={() => {
        if (canPlay) timer.current = window.setTimeout(() => setPlaying(true), 350)
      }}
      onMouseLeave={() => {
        window.clearTimeout(timer.current)
        setPlaying(false)
      }}
    >
      <img
        key={retry}
        src={(size * devicePixelRatio > 420 && !a.video ? previewUrl(a.id) : thumbUrl(a.id)) + (retry ? `?r=${retry}` : '')}
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
      {badges && a.video && (
        <div className="badge-tr">{formatDuration(a.dur)}</div>
      )}
      {badges && a.live && size >= 80 && (
        <div className="badge-tl"><LiveIcon size={size > 150 ? 17 : 14} off={a.live === 'off'} /></div>
      )}
      {a.fav && size >= 60 && (
        <div className="badge-bl"><Heart size={size > 150 ? 15 : 12} fill="#fff" strokeWidth={0} /></div>
      )}
      {selected && size >= 80 && (
        <div className="check"><Check size={13} strokeWidth={3.2} /></div>
      )}
    </div>
  )
})

export function PhotoGrid({
  items, scrollToEnd, onVisibleRange, emptyText
}: {
  items: GridAsset[]
  scrollToEnd?: boolean
  onVisibleRange?: (r: [number, number] | null) => void
  emptyText?: React.ReactNode
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const zoom = useStore((s) => s.zoom)
  const selection = useStore((s) => s.selection)
  const settings = useStore((s) => s.settings)
  const source = useStore((s) => s.source)
  const scrollTarget = useStore((s) => s.scrollTarget)
  const viewerOpen = useStore((s) => !!s.viewer)
  const sheetOpen = useStore((s) => !!s.sheet)

  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return
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
    paddingEnd: 110
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

  const vItems = virt.getVirtualItems()
  useEffect(() => {
    if (!vItems.length) {
      onVisibleRange?.(null)
      return
    }
    const first = vItems.find((v) => v.end > (parentRef.current?.scrollTop ?? 0)) ?? vItems[0]
    const startIdx = first.index * cols
    anchorRef.current = items[startIdx]?.id ?? null
    const viewH = parentRef.current?.clientHeight ?? 0
    const bottom = (parentRef.current?.scrollTop ?? 0) + viewH - 110
    const lastRow = [...vItems].reverse().find((v) => v.start < bottom) ?? vItems[vItems.length - 1]
    const endIdx = Math.min(items.length - 1, lastRow.index * cols + cols - 1)
    if (items[startIdx] && items[endIdx]) onVisibleRange?.([items[startIdx].t, items[endIdx].t])
  }, [vItems[0]?.index, vItems[vItems.length - 1]?.index, items, cols])

  const indexOf = useMemo(() => {
    const m = new Map<number, number>()
    items.forEach((a, i) => m.set(a.id, i))
    return m
  }, [items])

  const onDown = useCallback(
    (e: React.MouseEvent, a: GridAsset) => {
      if (e.button === 2) {
        if (!getState().selection.has(a.id)) setState({ selection: new Set([a.id]), anchor: a.id })
        return
      }
      if (e.button !== 0) return
      const s = getState()
      if (e.shiftKey && s.anchor !== null) {
        const i0 = indexOf.get(s.anchor) ?? 0
        const i1 = indexOf.get(a.id) ?? 0
        const [lo, hi] = i0 < i1 ? [i0, i1] : [i1, i0]
        const next = new Set(e.ctrlKey || e.metaKey ? s.selection : [])
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

  const onOpen = useCallback((a: GridAsset) => openViewer(items.map((x) => x.id), a.id, getState().source), [items])

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
        if (e.shiftKey) setState({ selection: new Set([...s.selection, id]), anchor: id })
        else setState({ selection: new Set([id]), anchor: id })
        virt.scrollToIndex(Math.floor(next / cols))
      }
      if (e.key === 'ArrowRight') return move(1)
      if (e.key === 'ArrowLeft') return move(-1)
      if (e.key === 'ArrowDown') return move(cols)
      if (e.key === 'ArrowUp') return move(-cols)
      if ((e.key === 'Enter' || e.key === ' ') && s.anchor !== null) {
        e.preventDefault()
        openViewer(items.map((x) => x.id), s.anchor, s.source)
        return
      }
      if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setState({ selection: new Set(items.map((a) => a.id)) })
        return
      }
      if (e.key === 'Escape') return setState({ selection: new Set(), infoOpen: false })
      if (!ids.length) return
      if (e.key === '.') return void toggleFavorite(ids)
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
    <div
      ref={parentRef}
      className="scroller"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.blank) setState({ selection: new Set(), anchor: null })
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
                    fit={fit}
                    badges={badges}
                    autoplayLive={autoplayLive}
                    onDown={onDown}
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
  )
}
