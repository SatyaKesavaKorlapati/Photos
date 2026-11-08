import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Minus, Plus, Heart, Info, RotateCcw, Share, SlidersHorizontal, Download, FolderInput, ImagePlus, Maximize2, FileDown } from 'lucide-react'
import { api, isMac } from '../api'
import { exportAssets, rotate, toggleFavorite } from '../actions'
import { openShare } from './Share'
import { applyFilter, getState, navigate, setState, updateSettings, useStore } from '../store'
import type { ShowFilter, Suggestion } from '../types'
import { countLabel, rangeLabel } from '../util'
import { openMenu } from './Menu'
import { SidebarIcon } from './Icons'
import { Slider } from './Controls'
import { disarmPeek } from './Sidebar'

/**
 * Window controls in a glass bubble. Hidden until the pointer is pushed right into the window's
 * top-left corner (a hot corner, so it never covers back buttons or titles); it stays while the
 * pointer is on it and the lights magnify toward the pointer like the Dock.
 */
export function TrafficLights() {
  const [mx, setMx] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const hideTimer = useRef(0)
  const fullscreen = useStore((s) => s.fullscreen)
  useEffect(() => {
    if (!open) return
    const onMove = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect()
      const inside = r && e.clientX <= r.right + 14 && e.clientY <= r.bottom + 14
      window.clearTimeout(hideTimer.current)
      if (!inside) hideTimer.current = window.setTimeout(() => setOpen(false), 260)
    }
    const onOut = (e: MouseEvent) => !e.relatedTarget && (hideTimer.current = window.setTimeout(() => setOpen(false), 600))
    window.addEventListener('pointermove', onMove)
    document.addEventListener('mouseout', onOut)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseout', onOut)
      window.clearTimeout(hideTimer.current)
    }
  }, [open])
  if (isMac) return null
  const btns = [
    { cls: 'close', title: 'Close', run: () => api.win.close(), icon: <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.2" /> },
    { cls: 'min', title: 'Minimise', run: () => api.win.minimize(), icon: <path d="M1 4h6" stroke="currentColor" strokeWidth="1.3" /> },
    {
      cls: 'max',
      title: fullscreen ? 'Exit Full Screen' : 'Full Screen (click) · Zoom (Alt+click)',
      run: (e: React.MouseEvent) => (e.altKey ? api.win.maximize() : api.win.fullscreen()),
      icon: fullscreen
        ? <path d="M3.2 1v2.2H1M4.8 7V4.8H7" stroke="currentColor" strokeWidth="1.2" fill="none" />
        : <path d="M2 2h3.2L2 5.2zM6 6H2.8L6 2.8z" fill="currentColor" />
    }
  ]
  return (
    <div className={`traffic-zone${open ? ' open' : ''}`}>
      <div className="traffic-corner" onPointerEnter={() => setOpen(true)} />
      <div
        ref={ref}
        className={`traffic glass${mx !== null ? ' hot' : ''}`}
        onMouseMove={(e) => setMx(e.clientX - (ref.current?.getBoundingClientRect().left ?? 0))}
        onMouseLeave={() => setMx(null)}
      >
        {btns.map((b, i) => {
          const center = 14 + i * 24 + 7
          const k = mx === null ? 0 : Math.max(0, 1 - Math.abs(mx - center) / 46)
          return (
            <button
              key={b.cls}
              className={b.cls}
              title={b.title}
              style={{ transform: `scale(${1 + k * 0.42})` }}
              onClick={(e) => b.run(e)}
            >
              <svg viewBox="0 0 8 8">{b.icon}</svg>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const TITLES: Record<string, string> = {
  library: 'Library', memories: 'Memories', favorites: 'Favourites', recent: 'Recently Saved', videos: 'Videos', selfie: 'Selfies',
  live: 'Live Photos', portrait: 'Portrait', panorama: 'Panoramas', timelapse: 'Time-lapse', slomo: 'Slo-mo', cinematic: 'Cinematic',
  loop: 'Loop', bounce: 'Bounce', longexposure: 'Long Exposure', burst: 'Bursts', screenshot: 'Screenshots', screenrec: 'Screen Recordings',
  animated: 'Animated', raw: 'RAW', hdr: 'HDR', imports: 'Imports', duplicates: 'Duplicates', hidden: 'Hidden', deleted: 'Recently Deleted',
  albums: 'Albums', edited: 'Edited'
}

export function sourceTitle(source: string): string {
  const s = getState()
  if (source.startsWith('album:')) return s.albums.find((a) => a.id === Number(source.slice(6)))?.name ?? 'Album'
  if (source.startsWith('folder:')) return s.folders.find((f) => f.dir === source.slice(7))?.name ?? 'Folder'
  if (source.startsWith('import:')) return 'Import'
  if (source.startsWith('search:')) return `“${source.slice(7)}”`
  return TITLES[source] ?? source
}

function SearchBox() {
  const query = useStore((s) => s.query)
  const [focus, setFocus] = useState(false)
  const [sugs, setSugs] = useState<Suggestion[]>([])
  const [hl, setHl] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(async () => {
      setSugs(query.trim() ? await api.suggest(query) : [])
      setHl(-1)
    }, 140)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = (source: string) => {
    navigate(source)
    setFocus(false)
    inputRef.current?.blur()
  }

  const grouped = useMemo(() => {
    const m = new Map<string, Suggestion[]>()
    sugs.forEach((s) => m.set(s.kind, [...(m.get(s.kind) ?? []), s]))
    return [...m.entries()]
  }, [sugs])

  return (
    <div style={{ position: 'relative' }} className="no-drag">
      <div className="search glass">
        <Search size={14} />
        <input
          ref={inputRef}
          placeholder="Search"
          value={query}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onChange={(e) => setState({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(sugs.length - 1, h + 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(-1, h - 1)) }
            if (e.key === 'Enter' && query.trim()) run(hl >= 0 ? sugs[hl].source : `search:${query.trim()}`)
            if (e.key === 'Escape') { setState({ query: '' }); inputRef.current?.blur() }
          }}
        />
        {query && (
          <button className="clear" onClick={() => { setState({ query: '' }); if (getState().source.startsWith('search:')) navigate('library') }}>
            <X size={10} strokeWidth={3} />
          </button>
        )}
      </div>
      {focus && sugs.length > 0 && (
        <div className="suggest glass-strong">
          {grouped.map(([kind, list]) => (
            <div key={kind}>
              <h6>{kind}</h6>
              {list.map((s) => (
                <button key={s.source + s.label} className={sugs.indexOf(s) === hl ? 'hl' : ''} onMouseDown={() => run(s.source)}>
                  <Search size={13} style={{ opacity: 0.6 }} />
                  <span>{s.label}</span>
                  <span className="n">{s.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const FILTER_LABEL: Record<ShowFilter, string> = { all: 'All Items', favorites: 'Favourites', edited: 'Edited', photos: 'Photos', videos: 'Videos' }

export function Toolbar({ visibleRange }: { visibleRange: [number, number] | null }) {
  const source = useStore((s) => s.source)
  const assets = useStore((s) => s.assets)
  const filter = useStore((s) => s.filter)
  const view = useStore((s) => s.view)
  const zoom = useStore((s) => s.zoom)
  const selection = useStore((s) => s.selection)
  const infoOpen = useStore((s) => s.infoOpen)
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const settings = useStore((s) => s.settings)
  const selectMode = useStore((s) => s.selectMode)
  const ids = [...selection]
  const isGrid = !['memories', 'albums', 'imports'].includes(source) && (source !== 'library' || view === 'all')
  const shown = applyFilter(assets, filter)
  const selAssets = assets.filter((a) => selection.has(a.id))
  const allFav = selAssets.length > 0 && selAssets.every((a) => a.fav)

  const title = sourceTitle(source)
  let subtitle: string | undefined = ['memories', 'albums', 'imports'].includes(source) ? undefined : shown.length ? countLabel(shown) : undefined
  if (source !== 'library' && view && visibleRange && shown.length) {
    subtitle = `${countLabel(shown)} · ${rangeLabel(visibleRange[0], visibleRange[1]).title}`
  }
  if (selection.size) subtitle = `${selection.size.toLocaleString()} of ${shown.length.toLocaleString()} selected`

  return (
    <header className={`toolbar drag${collapsed ? ' wide' : ''}`} onDoubleClick={(e) => e.target === e.currentTarget && api.win.maximize()}>
      <button
        type="button"
        className="tb-btn glass sb-toggle no-drag"
        title={collapsed ? `Show Sidebar (${isMac ? '⌥⌘S' : 'Ctrl+Alt+S'})` : `Hide Sidebar (${isMac ? '⌥⌘S' : 'Ctrl+Alt+S'})`}
        onClick={() => {
          const next = !collapsed
          if (next) disarmPeek()
          setState({ sidebarCollapsed: next, sidebarPeek: false })
        }}
      >
        <SidebarIcon />
      </button>
      <div
        className="title-block"
        title="Double-click to jump to the newest photos"
        onDoubleClick={() => window.dispatchEvent(new CustomEvent('grid:jump', { detail: 'end' }))}
      >
        <div className="title">{title}</div>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>

      {isGrid && (
        <div className="zoom glass">
          <button className="no-drag" onClick={() => setState({ zoom: Math.min(9, zoom + 1) })} title="Zoom Out"><Minus size={13} /></button>
          <Slider
            className="no-drag zoom-slider"
            title="Thumbnail size"
            min={1}
            max={9}
            value={10 - zoom}
            onChange={(v) => setState({ zoom: 10 - v })}
            onCommit={(v) => updateSettings({ zoom: 10 - v })}
          />
          <button className="no-drag" onClick={() => setState({ zoom: Math.max(1, zoom - 1) })} title="Zoom In"><Plus size={13} /></button>
        </div>
      )}

      {isGrid && (
        <div className="tb-group glass">
          <button
            className={`tb-btn${filter !== 'all' ? ' on' : ''}`}
            title="Filter"
            onClick={(e) =>
              openMenu(e.currentTarget.getBoundingClientRect(), [
                { header: true, label: 'Showing' },
                ...(['all', 'favorites', 'edited', 'photos', 'videos'] as ShowFilter[]).map((f) => ({
                  label: FILTER_LABEL[f],
                  checked: filter === f,
                  onClick: () => setState({ filter: f })
                })),
                { separator: true },
                { header: true, label: 'View' },
                { label: 'Square Thumbnails', checked: !!settings?.squareThumbs, onClick: () => updateSettings({ squareThumbs: true }) },
                { label: 'Aspect Ratio Thumbnails', checked: !settings?.squareThumbs, onClick: () => updateSettings({ squareThumbs: false }) },
                { separator: true },
                { label: 'Show Live Photo & Video Badges', checked: !!settings?.showLiveBadges, onClick: () => updateSettings({ showLiveBadges: !settings?.showLiveBadges }) }
              ])
            }
          >
            <SlidersHorizontal size={15} />
            {filter !== 'all' && <span>{FILTER_LABEL[filter]}</span>}
          </button>
          <button className={`tb-btn${allFav ? ' fav-on' : ''}`} title="Favourite" disabled={!ids.length} onClick={() => toggleFavorite(ids)}>
            <Heart size={15} fill={allFav ? 'currentColor' : 'none'} />
          </button>
          <button className="tb-btn" title="Rotate" disabled={!ids.length} onClick={() => rotate(ids)}>
            <RotateCcw size={15} />
          </button>
          <button className={`tb-btn${infoOpen ? ' on' : ''}`} title="Info" disabled={ids.length !== 1} onClick={() => setState({ infoOpen: !infoOpen })}>
            <Info size={15} />
          </button>
          <button className="tb-btn" title="Share" disabled={!ids.length} onClick={(e) => openShare(ids, e.currentTarget)}>
            <Share size={15} />
          </button>
          <button
            className="tb-btn"
            title={`Export (${isMac ? '⇧⌘E' : 'Ctrl+Shift+E'})`}
            disabled={!ids.length}
            onClick={(e) =>
              openMenu(e.currentTarget.getBoundingClientRect(), [
                { label: `Export ${ids.length > 1 ? `${ids.length} Items` : ''}…`.replace(' …', '…'), icon: <FileDown size={14} />, onClick: () => exportAssets(ids, 'current') },
                { label: 'Export Unmodified Original…', icon: <Download size={14} />, onClick: () => exportAssets(ids, 'original') }
              ], 'right')
            }
          >
            <FileDown size={15} />
          </button>
        </div>
      )}

      {isGrid && shown.length > 0 && (
        <button
          className={`tb-btn glass no-drag select-btn${selectMode ? ' active' : ''}`}
          title={`${selectMode ? 'Done selecting' : 'Select'} (${isMac ? '⇧⌘S' : 'Ctrl+Shift+S'})`}
          onClick={() => setState({ selectMode: !selectMode, selection: new Set() })}
        >
          {selectMode ? 'Cancel' : 'Select'}
        </button>
      )}

      <button
        className="tb-btn glass no-drag"
        style={{ height: 36, padding: '0 14px' }}
        title="Import"
        onClick={(e) =>
          openMenu(e.currentTarget.getBoundingClientRect(), [
            { label: 'Import Folder…', icon: <FolderInput size={14} />, shortcut: isMac ? '⇧⌘I' : 'Ctrl+Shift+I', onClick: () => startPick('folder') },
            { label: 'Import Photos & Videos…', icon: <ImagePlus size={14} />, onClick: () => startPick('files') },
            { separator: true },
            { label: 'Import Settings…', icon: <Maximize2 size={14} />, onClick: () => setState({ sheet: { kind: 'import' } }) }
          ], 'right')
        }
      >
        <Download size={15} />
        <span>Import</span>
      </button>
      <SearchBox />
    </header>
  )
}

export async function startPick(mode: 'folder' | 'files'): Promise<void> {
  const paths = await api.pickImport(mode)
  if (!paths.length) return
  setState({ sheet: { kind: 'import', ...(mode === 'folder' ? { folders: paths } : { files: paths }) } })
}
