import { useEffect, useMemo, useState } from 'react'
import { EyeOff, Heart, Plus, Share, Trash2, Undo2 } from 'lucide-react'
import { api, previewUrl } from './api'
import {
  albumSubmenu, draggedIds, exportAssets, hide, openEditor, promptNewAlbum, purge, restore, rotate, toggleFavorite, trash
} from './actions'
import {
  applyFilter, getState, loadAssets, navigate, refreshAll, refreshMeta, setState, updateSettings, useStore
} from './store'
import type { LibraryView } from './types'
import { plural, rangeLabel } from './util'
import { CardsView } from './components/Cards'
import { Segmented } from './components/Controls'
import { PhotoGrid } from './components/Grid'
import { InfoPanel } from './components/InfoPanel'
import { Memories, Slideshow } from './components/Memories'
import { MenuLayer, openMenu } from './components/Menu'
import { AlbumsPage, EmptyLibrary, HiddenLock, ImportsPage } from './components/Pages'
import { SheetLayer } from './components/Sheets'
import { disarmPeek, Sidebar, SidebarPeek } from './components/Sidebar'
import { startPick, Toolbar, TrafficLights } from './components/TitleBar'
import { Viewer } from './components/Viewer'
import { Editor } from './editor/Editor'
import { ShareLayer, openShare } from './components/Share'
import { GlassFilters } from './components/GlassFilters'

function FloatHeader({ range }: { range: [number, number] | null }) {
  if (!range) return null
  const r = rangeLabel(range[0], range[1])
  return (
    <div className="float-head">
      <div className="t">{r.title}</div>
      {r.subtitle && <div className="s">{r.subtitle}</div>}
    </div>
  )
}

function LibraryViewSwitch() {
  const view = useStore((s) => s.view)
  const selectMode = useStore((s) => s.selectMode)
  if (selectMode) return null
  return (
    <div className="seg-float">
      <Segmented<LibraryView>
        className="glass"
        value={view}
        onChange={(v) => {
          setState({ view: v, scrollTarget: null })
          updateSettings({ libraryView: v })
        }}
        options={[
          { value: 'years', label: 'Years' },
          { value: 'months', label: 'Months' },
          { value: 'days', label: 'Days' },
          { value: 'all', label: 'All Photos' }
        ]}
      />
    </div>
  )
}

/** iOS Select mode bar: count in the middle, actions either side. */
function SelectBar() {
  const selectMode = useStore((s) => s.selectMode)
  const selection = useStore((s) => s.selection)
  const assets = useStore((s) => s.assets)
  const source = useStore((s) => s.source)
  if (!selectMode) return null
  const ids = [...selection]
  const n = ids.length
  const list = assets.filter((a) => selection.has(a.id))
  const v = list.filter((a) => a.video).length
  const label = n === 0 ? 'Select Items' : `${plural(n, v === n ? 'Video' : v ? 'Item' : 'Photo')} Selected`
  const allFav = n > 0 && list.every((a) => a.fav)
  const deleted = source === 'deleted'
  return (
    <div className="select-bar glass" onMouseDown={(e) => e.stopPropagation()}>
      {deleted ? (
        <button className="sb-act" disabled={!n} title="Recover" onClick={() => restore(ids).then(() => setState({ selection: new Set() }))}><Undo2 size={18} /></button>
      ) : (
        <>
          <button className="sb-act" disabled={!n} title="Share" onClick={(e) => openShare(ids, e.currentTarget)}><Share size={18} /></button>
          <button className="sb-act" disabled={!n} title="Add to Album" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), albumSubmenu(ids))}><Plus size={19} /></button>
        </>
      )}
      <div className="sb-label">
        <b>{label}</b>
        <button className="link" onClick={() => setState({ selection: n === assets.length ? new Set() : new Set(applyFilter(assets, getState().filter).map((a) => a.id)) })}>
          {n === assets.length && n ? 'Deselect All' : 'Select All'}
        </button>
      </div>
      {!deleted && (
        <>
          <button className={`sb-act${allFav ? ' fav-on' : ''}`} disabled={!n} title="Favourite" onClick={() => toggleFavorite(ids)}>
            <Heart size={18} fill={allFav ? 'currentColor' : 'none'} />
          </button>
          <button className="sb-act" disabled={!n} title={source === 'hidden' ? 'Unhide' : 'Hide'} onClick={() => hide(ids, source !== 'hidden')}><EyeOff size={18} /></button>
        </>
      )}
      <button className="sb-act danger" disabled={!n} title="Delete" onClick={() => void (deleted ? purge(ids) : trash(ids))}><Trash2 size={18} /></button>
    </div>
  )
}

function Content({ onRange, range }: { onRange: (r: [number, number] | null) => void; range: [number, number] | null }) {
  const source = useStore((s) => s.source)
  const view = useStore((s) => s.view)
  const assets = useStore((s) => s.assets)
  const assetsSource = useStore((s) => s.assetsSource)
  const filter = useStore((s) => s.filter)
  const loading = useStore((s) => s.loading)
  const counts = useStore((s) => s.counts)
  const hiddenUnlocked = useStore((s) => s.hiddenUnlocked)
  const locked = useStore((s) => !!s.settings?.hiddenLocked)
  const items = useMemo(() => applyFilter(assets, filter), [assets, filter])

  if (source === 'memories') return <Memories />
  if (source === 'albums') return <AlbumsPage />
  if (source === 'imports') return <ImportsPage />
  if (source === 'hidden' && locked && !hiddenUnlocked) return <HiddenLock />
  if (!loading && counts.library === 0 && source === 'library' && !counts.deleted) return <EmptyLibrary />
  if (assetsSource !== source) return null

  if (source === 'library') {
    return (
      <>
        {view === 'all' ? (
          <>
            <PhotoGrid key="lib-all" items={items} scrollToEnd onVisibleRange={onRange} />
            <FloatHeader range={range} />
          </>
        ) : (
          <CardsView key={view} items={items} view={view} />
        )}
        <LibraryViewSwitch />
      </>
    )
  }

  const empty = (
    <div className="empty">
      <div>
        <h2>{source === 'deleted' ? 'No Recently Deleted Items' : source.startsWith('search:') ? 'No Results' : 'No Photos or Videos'}</h2>
        <p>
          {source === 'deleted'
            ? 'Deleted items appear here. Removing them from the library never deletes the files on disk.'
            : source.startsWith('search:')
              ? 'Try a month, a year, a camera, “selfies”, “portrait”, “live”, “4k” or part of a file name.'
              : 'Drag photos onto an album in the sidebar, or use Add to › in the right-click menu.'}
        </p>
      </div>
    </div>
  )
  return <PhotoGrid key={source} items={items} scrollToEnd={!source.startsWith('search:') && source !== 'duplicates'} emptyText={empty} onVisibleRange={onRange} />
}

function writeGlass(root: HTMLElement, gi: number, dark: boolean, suffix: '' | '-panel') {
  const fill = (frost: number, clear: number) => (frost * (1 - gi) + clear * gi).toFixed(3)
  const panel = suffix === '-panel'
  const blur = (panel ? 52 * (1 - gi) + 8 * gi : 24 * (1 - gi) + 2.4 * gi).toFixed(1)
  const sat = Math.round(panel ? 120 + 40 * gi : 130 + 110 * gi)
  const br = (panel
    ? dark ? 0.92 + 0.1 * gi : 0.98 + 0.06 * gi
    : dark ? 1.06 + 0.14 * gi : 1.12 + 0.1 * gi).toFixed(3)
  root.style.setProperty(`--gi${suffix}`, String(gi))
  root.style.setProperty(`--g-blur${suffix}`, `${blur}px`)
  root.style.setProperty(`--g-sat${suffix}`, `${sat}%`)
  root.style.setProperty(`--g-br${suffix}`, br)
  root.style.setProperty(`--blur${suffix}`, `blur(${blur}px) saturate(${sat}%) brightness(${br}) contrast(1.06)`)
  if (dark) {
    root.style.setProperty(`--glass${suffix}`, `rgba(255, 255, 255, ${fill(panel ? 0.16 : 0.1, panel ? 0.03 : 0.02)})`)
    root.style.setProperty(`--glass-2${suffix}`, `rgba(255, 255, 255, ${fill(panel ? 0.2 : 0.14, panel ? 0.04 : 0.03)})`)
    root.style.setProperty(`--glass-3${suffix}`, `rgba(12, 12, 14, ${fill(panel ? 0.92 : 0.42, panel ? 0.1 : 0.06)})`)
    root.style.setProperty(`--glass-border${suffix}`, `rgba(255, 255, 255, ${fill(0.18, 0.32)})`)
    root.style.setProperty(`--glass-edge${suffix}`, `rgba(255, 255, 255, ${fill(0.28, 0.55)})`)
    root.style.setProperty(`--pill${suffix}`, `rgba(255, 255, 255, ${fill(0.16, 0.05)})`)
    root.style.setProperty(`--pill-active${suffix}`, `rgba(255, 255, 255, ${fill(0.3, 0.1)})`)
  } else {
    root.style.setProperty(`--glass${suffix}`, `rgba(255, 255, 255, ${fill(panel ? 0.72 : 0.48, panel ? 0.08 : 0.03)})`)
    root.style.setProperty(`--glass-2${suffix}`, `rgba(255, 255, 255, ${fill(panel ? 0.78 : 0.56, panel ? 0.1 : 0.05)})`)
    root.style.setProperty(`--glass-3${suffix}`, `rgba(244, 244, 246, ${fill(panel ? 0.94 : 0.78, panel ? 0.16 : 0.08)})`)
    root.style.setProperty(`--glass-border${suffix}`, `rgba(255, 255, 255, ${fill(0.45, 0.55)})`)
    root.style.setProperty(`--glass-edge${suffix}`, `rgba(255, 255, 255, ${fill(0.7, 0.9)})`)
    root.style.setProperty(`--pill${suffix}`, `rgba(255, 255, 255, ${fill(0.4, 0.08)})`)
    root.style.setProperty(`--pill-active${suffix}`, `rgba(255, 255, 255, ${fill(0.72, 0.14)})`)
  }
}

function applyTheme(appearance: string, reduce: boolean, motion: boolean, chrome = 1, panels = 0.68) {
  const dark = appearance === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : appearance === 'dark'
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.reduce = String(reduce)
  root.dataset.motion = motion ? 'reduced' : 'full'
  const gi = reduce ? 0 : Math.max(0, Math.min(1, chrome))
  const gp = reduce ? 0 : Math.max(0, Math.min(1, panels))
  writeGlass(root, gi, dark, '')
  writeGlass(root, gp, dark, '-panel')
}

export default function App() {
  const settings = useStore((s) => s.settings)
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const viewer = useStore((s) => s.viewer)
  const editor = useStore((s) => s.editor)
  const infoOpen = useStore((s) => s.infoOpen)
  const selection = useStore((s) => s.selection)
  const toast = useStore((s) => s.toast)
  const assets = useStore((s) => s.assets)
  const source = useStore((s) => s.source)
  const fullscreen = useStore((s) => s.fullscreen)
  const [range, setRange] = useState<[number, number] | null>(null)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    api.getSettings().then((s) => {
      setState({ settings: s, zoom: s.zoom, view: s.libraryView, sidebarCollapsed: s.sidebarCollapsed, source: s.lastSource || 'library' })
      refreshAll()
    })
    api.win.isFullscreen().then((f) => setState({ fullscreen: f }))
    let t: number | undefined
    const offs = [
      api.on('library:changed', () => {
        window.clearTimeout(t)
        t = window.setTimeout(() => {
          if (!getState().viewer && !getState().editor) loadAssets()
          refreshMeta()
          setState((s) => ({ version: s.version + 1 }))
        }, 250)
      }),
      api.on('import:progress', (p) => setState({ importProgress: p })),
      api.on('thumbs:progress', (p) => setState({ thumbProgress: p })),
      api.on('window:state', (p) => {
        if (p.maximized !== undefined) setState({ maximized: p.maximized })
        if (p.fullscreen !== undefined) setState({ fullscreen: p.fullscreen })
      }),
      api.on('menu:command', (c) => runCommand(c)),
      api.on('open:files', (files: string[]) => setState({ sheet: { kind: 'import', files } }))
    ]
    // Leaving the app re-locks the Hidden album, like iOS.
    const onBlur = () => {
      const s = getState()
      if (s.hiddenUnlocked && s.source !== 'hidden') setState({ hiddenUnlocked: false })
    }
    window.addEventListener('blur', onBlur)
    return () => {
      offs.forEach((o) => o())
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    if (!settings) return
    applyTheme(settings.appearance, settings.reduceTransparency, settings.reduceMotion, settings.glassIntensity ?? 1, settings.glassPanels ?? 0.68)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyTheme(settings.appearance, settings.reduceTransparency, settings.reduceMotion, settings.glassIntensity ?? 1, settings.glassPanels ?? 0.68)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [settings?.appearance, settings?.reduceTransparency, settings?.reduceMotion, settings?.glassIntensity, settings?.glassPanels])

  useEffect(() => {
    if (settings && settings.sidebarCollapsed !== collapsed) updateSettings({ sidebarCollapsed: collapsed })
  }, [collapsed, settings?.sidebarCollapsed])

  // The blurred backdrop follows the newest photo in view, like visionOS.
  useEffect(() => {
    if (source === 'memories') return
    const pick = [...assets].reverse().find((a) => !a.video && !a.sub.includes('screenshot'))
    if (pick) document.documentElement.style.setProperty('--ambient-image', `url("${previewUrl(pick.id)}")`)
  }, [assets, source])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
      if (getState().editor) return
      if (ctrl && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        runCommand(['view-years', 'view-months', 'view-days', 'view-all'][+e.key - 1])
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); runCommand('import-folder') }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); runCommand(e.altKey ? 'new-folder' : 'new-album') }
      if (ctrl && e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); runCommand('toggle-sidebar') }
      if (ctrl && e.key === ',') { e.preventDefault(); setState({ sheet: { kind: 'settings' } }) }
      if (ctrl && e.key === '/') { e.preventDefault(); setState({ sheet: { kind: 'shortcuts' } }) }
      if (e.key === 'F11') { e.preventDefault(); api.win.fullscreen() }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        runCommand(e.altKey ? 'export-original' : 'export')
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const ids = [...getState().selection]
        if (ids.length) openShare(ids)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const singleSel = selection.size === 1 ? [...selection][0] : null

  return (
    <>
      <GlassFilters scale={settings?.reduceTransparency ? 0 : 5 + 27 * (settings?.glassIntensity ?? 1)} />
      <div className="ambient" style={{ backgroundImage: 'var(--ambient-image)' }} />
      <div
        className={`app${collapsed ? ' compact' : ''}${fullscreen ? ' fullscreen' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            if (!draggedIds()) setDropping(true)
          }
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget === null) setDropping(false)
        }}
        onDrop={(e) => {
          setDropping(false)
          if (draggedIds()) return e.preventDefault()
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
          const files = paths.filter((p) => /\.[a-z0-9]{2,5}$/i.test(p))
          const folders = paths.filter((p) => !/\.[a-z0-9]{2,5}$/i.test(p))
          setState({ sheet: { kind: 'import', folders: folders.length ? folders : undefined, files: files.length ? files : undefined } })
        }}
      >
        {!collapsed && <Sidebar />}
        <main className="main">
          <section className="content" onMouseDown={() => getState().menu && setState({ menu: null })}>
            <Content onRange={setRange} range={range} />
            <Toolbar visibleRange={range} />
            <SelectBar />
            {!viewer && infoOpen && singleSel !== null && <InfoPanel id={singleSel} />}
          </section>
        </main>
        {collapsed && <SidebarPeek />}
      </div>
      {!viewer && !editor && <TrafficLights />}
      {viewer && <Viewer />}
      {editor && <Editor key={editor.id} />}
      <ShareLayer />
      <MenuLayer />
      <SheetLayer />
      <Slideshow />
      {toast && (
        <div key={toast.id} className="toast glass-strong">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              onClick={() => {
                toast.action!.run()
                setState({ toast: null })
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {dropping && <div className="drop-overlay">Drop to Import</div>}
    </>
  )
}

function runCommand(c: string): void {
  const s = getState()
  const ids = [...s.selection]
  switch (c) {
    case 'view-years':
    case 'view-months':
    case 'view-days':
    case 'view-all': {
      const v = c.slice(5) as LibraryView
      if (s.source !== 'library') navigate('library', { view: v })
      else setState({ view: v })
      updateSettings({ libraryView: v })
      break
    }
    case 'import-folder': startPick('folder'); break
    case 'import-files': startPick('files'); break
    case 'new-album': promptNewAlbum(ids); break
    case 'new-folder': promptNewAlbum([], true); break
    case 'toggle-sidebar': {
      const next = !s.sidebarCollapsed
      if (next) disarmPeek()
      setState({ sidebarCollapsed: next, sidebarPeek: false })
      break
    }
    case 'select-mode': setState({ selectMode: !s.selectMode, selection: new Set() }); break
    case 'zoom-in': setState({ zoom: Math.max(1, s.zoom - 1) }); break
    case 'zoom-out': setState({ zoom: Math.min(9, s.zoom + 1) }); break
    case 'info': setState({ infoOpen: !s.infoOpen }); break
    case 'export': if (ids.length) exportAssets(ids, 'current'); break
    case 'export-original': if (ids.length) exportAssets(ids, 'original'); break
    case 'edit': {
      const id = s.viewer ? s.viewer.ids[s.viewer.index] : ids.length === 1 ? ids[0] : null
      if (id !== null) openEditor(id)
      break
    }
    case 'favorite': if (ids.length) toggleFavorite(ids); break
    case 'rotate': if (ids.length) rotate(ids); break
    case 'hide': if (ids.length) hide(ids, s.source !== 'hidden'); break
    case 'delete': if (ids.length) void trash(ids); break
  }
}
