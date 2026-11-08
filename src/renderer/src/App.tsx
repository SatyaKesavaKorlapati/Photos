import { useEffect, useMemo, useState } from 'react'
import { api, previewUrl } from './api'
import { exportAssets, hide, promptNewAlbum, rotate, toggleFavorite, trash } from './actions'
import {
  applyFilter, getState, loadAssets, navigate, refreshAll, refreshMeta, setState, updateSettings, useStore
} from './store'
import type { LibraryView } from './types'
import { rangeLabel } from './util'
import { CardsView } from './components/Cards'
import { Segmented } from './components/Controls'
import { PhotoGrid } from './components/Grid'
import { InfoPanel } from './components/InfoPanel'
import { Memories, Slideshow } from './components/Memories'
import { MenuLayer } from './components/Menu'
import { AlbumsPage, EmptyLibrary, HiddenLock, ImportsPage, useHiddenUnlock } from './components/Pages'
import { SheetLayer } from './components/Sheets'
import { Rail, Sidebar } from './components/Sidebar'
import { startPick, Toolbar } from './components/TitleBar'
import { Viewer } from './components/Viewer'

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

function Content({ onRange, range }: { onRange: (r: [number, number] | null) => void; range: [number, number] | null }) {
  const source = useStore((s) => s.source)
  const view = useStore((s) => s.view)
  const assets = useStore((s) => s.assets)
  const assetsSource = useStore((s) => s.assetsSource)
  const filter = useStore((s) => s.filter)
  const loading = useStore((s) => s.loading)
  const counts = useStore((s) => s.counts)
  const [hiddenOpen, unlockHidden] = useHiddenUnlock()
  const items = useMemo(() => applyFilter(assets, filter), [assets, filter])

  if (source === 'memories') return <Memories />
  if (source === 'albums') return <AlbumsPage />
  if (source === 'imports') return <ImportsPage />
  if (source === 'hidden' && !hiddenOpen) return <HiddenLock onUnlock={unlockHidden} />
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

function applyTheme(appearance: string, reduce: boolean) {
  const dark = appearance === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : appearance === 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.reduce = String(reduce)
}

export default function App() {
  const settings = useStore((s) => s.settings)
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const viewer = useStore((s) => s.viewer)
  const infoOpen = useStore((s) => s.infoOpen)
  const selection = useStore((s) => s.selection)
  const toast = useStore((s) => s.toast)
  const assets = useStore((s) => s.assets)
  const source = useStore((s) => s.source)
  const [range, setRange] = useState<[number, number] | null>(null)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    api.getSettings().then((s) => {
      setState({ settings: s, zoom: s.zoom, view: s.libraryView, sidebarCollapsed: s.sidebarCollapsed })
      refreshAll()
    })
    let t: number | undefined
    const offs = [
      api.on('library:changed', () => {
        window.clearTimeout(t)
        t = window.setTimeout(() => {
          if (!getState().viewer) loadAssets()
          refreshMeta()
          setState((s) => ({ version: s.version + 1 }))
        }, 250)
      }),
      api.on('import:progress', (p) => setState({ importProgress: p })),
      api.on('thumbs:progress', (p) => setState({ thumbProgress: p })),
      api.on('window:state', (p) => p.maximized !== undefined && setState({ maximized: p.maximized })),
      api.on('menu:command', (c) => runCommand(c))
    ]
    return () => offs.forEach((o) => o())
  }, [])

  useEffect(() => {
    if (!settings) return
    applyTheme(settings.appearance, settings.reduceTransparency)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyTheme(settings.appearance, settings.reduceTransparency)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [settings?.appearance, settings?.reduceTransparency])

  useEffect(() => {
    if (settings && settings.sidebarCollapsed !== collapsed) updateSettings({ sidebarCollapsed: collapsed })
  }, [collapsed])

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
      if (ctrl && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        runCommand(['view-years', 'view-months', 'view-days', 'view-all'][+e.key - 1])
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); runCommand('import-folder') }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); runCommand(e.altKey ? 'new-folder' : 'new-album') }
      if (ctrl && e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); runCommand('toggle-sidebar') }
      if (ctrl && e.key === ',') { e.preventDefault(); setState({ sheet: { kind: 'settings' } }) }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        runCommand('export-original')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const singleSel = selection.size === 1 ? [...selection][0] : null

  return (
    <>
      <div className="ambient" style={{ backgroundImage: 'var(--ambient-image)' }} />
      <div
        className="app"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDropping(true)
          }
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget === null) setDropping(false)
        }}
        onDrop={(e) => {
          setDropping(false)
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
          const files = paths.filter((p) => /\.[a-z0-9]{2,5}$/i.test(p))
          const folders = paths.filter((p) => !/\.[a-z0-9]{2,5}$/i.test(p))
          setState({ sheet: { kind: 'import', folders: folders.length ? folders : undefined, files: files.length ? files : undefined } })
        }}
      >
        {!collapsed && <Sidebar />}
        <main className={`main${collapsed ? ' rail-mode' : ''}`}>
          {collapsed && <Rail />}
          <Toolbar visibleRange={range} />
          <section className="content glass" onMouseDown={() => getState().menu && setState({ menu: null })}>
            <Content onRange={setRange} range={range} />
            {viewer && <Viewer />}
            {!viewer && infoOpen && singleSel !== null && <InfoPanel id={singleSel} />}
          </section>
        </main>
      </div>
      <MenuLayer />
      <SheetLayer />
      <Slideshow />
      {toast && <div key={toast.id} className="toast glass-strong">{toast.text}</div>}
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
    case 'toggle-sidebar': setState({ sidebarCollapsed: !s.sidebarCollapsed }); break
    case 'zoom-in': setState({ zoom: Math.max(1, s.zoom - 1) }); break
    case 'zoom-out': setState({ zoom: Math.min(9, s.zoom + 1) }); break
    case 'info': setState({ infoOpen: !s.infoOpen }); break
    case 'export-original': if (ids.length) exportAssets(ids, 'original'); break
    case 'favorite': if (ids.length) toggleFavorite(ids); break
    case 'rotate': if (ids.length) rotate(ids); break
    case 'hide': if (ids.length) hide(ids, s.source !== 'hidden'); break
    case 'delete': if (ids.length) trash(ids); break
  }
}
