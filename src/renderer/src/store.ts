import { useSyncExternalStore, type ReactNode } from 'react'
import { api, setEditVersions } from './api'
import type { Album, FolderEntry, GridAsset, ImportEntry, ImportProgress, LibraryView, Settings, ShowFilter, ThumbProgress } from './types'

export interface ViewerState {
  ids: number[]
  index: number
  source: string
}

export interface MenuItem {
  label?: string
  icon?: React.ReactNode
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  header?: boolean
  submenu?: MenuItem[]
  /** Renders as the row of large icon buttons at the top of iOS context menus. */
  quick?: MenuItem[]
  onClick?: () => void
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
  align?: 'left' | 'right'
  /** Bottom edge to use when the menu has to open upwards (the top of the button that opened it). */
  above?: number
}

export type Sheet =
  | { kind: 'import'; folders?: string[]; files?: string[] }
  | { kind: 'settings' }
  | { kind: 'prompt'; title: string; placeholder: string; confirm: string; initial?: string; onSubmit: (v: string) => void }
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; icon?: ReactNode; onConfirm: () => void; onCancel?: () => void }
  | { kind: 'export'; ids: number[]; unmodified?: boolean }
  | { kind: 'shortcuts' }
  | { kind: 'connections' }
  | null

export interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

export interface State {
  source: string
  view: LibraryView
  zoom: number
  filter: ShowFilter
  assets: GridAsset[]
  assetsSource: string
  loading: boolean
  selection: Set<number>
  anchor: number | null
  viewer: ViewerState | null
  infoOpen: boolean
  sidebarCollapsed: boolean
  query: string
  counts: Record<string, number>
  albums: Album[]
  folders: FolderEntry[]
  imports: ImportEntry[]
  settings: Settings | null
  importProgress: ImportProgress | null
  thumbProgress: ThumbProgress | null
  menu: MenuState | null
  sheet: Sheet
  toast: Toast | null
  scrollTarget: number | null
  albumParent: number | null
  slideshow: { ids: number[]; title: string; subtitle?: string } | null
  maximized: boolean
  fullscreen: boolean
  version: number
  selectMode: boolean
  editor: { id: number; tab?: 'adjust' | 'filters' | 'crop' | 'video' | 'portrait' } | null
  /** Screen rect of the grid cell a viewer was opened from, for the zoom transition. */
  viewerOrigin: { id: number; rect: DOMRect } | null
  hiddenUnlocked: boolean
  sidebarPeek: boolean
  /** Share sheet anchored to the button that opened it. */
  share: { ids: number[]; anchor: { x: number; y: number; w: number; h: number } } | null
}

let state: State = {
  source: 'library',
  view: 'all',
  zoom: 5,
  filter: 'all',
  assets: [],
  assetsSource: '',
  loading: true,
  selection: new Set(),
  anchor: null,
  viewer: null,
  infoOpen: false,
  sidebarCollapsed: false,
  query: '',
  counts: {},
  albums: [],
  folders: [],
  imports: [],
  settings: null,
  importProgress: null,
  thumbProgress: null,
  menu: null,
  sheet: null,
  toast: null,
  scrollTarget: null,
  albumParent: null,
  slideshow: null,
  maximized: false,
  fullscreen: false,
  version: 0,
  selectMode: false,
  editor: null,
  viewerOrigin: null,
  hiddenUnlocked: false,
  sidebarPeek: false,
  share: null
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  listeners.forEach((l) => l())
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => sel(state)
  )
}

let toastId = 0
export function toast(text: string, action?: Toast['action']): void {
  const id = ++toastId
  setState({ toast: { id, text, action } })
  setTimeout(() => {
    if (getState().toast?.id === id) setState({ toast: null })
  }, action ? 5000 : 2600)
}

/** Apple-style confirmation sheet; resolves true when the user confirms. */
export function confirmSheet(opts: { title: string; message: string; confirm: string; danger?: boolean; icon?: ReactNode }): Promise<boolean> {
  return new Promise((resolve) => {
    setState({ sheet: { kind: 'confirm', ...opts, onConfirm: () => resolve(true), onCancel: () => resolve(false) } })
  })
}

/** Sources that are rendered by something other than the photo grid. */
export const PAGE_SOURCES = new Set(['memories', 'albums', 'imports'])

let loadSeq = 0
export async function loadAssets(source = state.source): Promise<void> {
  if (PAGE_SOURCES.has(source)) return
  const seq = ++loadSeq
  if (state.assetsSource !== source) setState({ loading: true })
  const assets = await api.list(source)
  if (seq !== loadSeq) return
  setEditVersions(assets)
  setState({ assets, assetsSource: source, loading: false })
}

export async function refreshMeta(): Promise<void> {
  const [counts, albums, folders, imports] = await Promise.all([api.counts(), api.albums(), api.folders(), api.imports()])
  setState({ counts, albums, folders, imports, thumbProgress: counts.thumbs })
}

export async function refreshAll(): Promise<void> {
  await Promise.all([loadAssets(), refreshMeta()])
  setState((s) => ({ version: s.version + 1 }))
}

export function navigate(source: string, opts: { view?: LibraryView; scrollTo?: number } = {}): void {
  setState({
    source,
    selection: new Set(),
    anchor: null,
    viewer: null,
    menu: null,
    selectMode: false,
    sidebarPeek: false,
    // Like iOS, the Hidden album locks again as soon as you leave it.
    hiddenUnlocked: source === 'hidden' ? state.hiddenUnlocked : false,
    view: opts.view ?? state.view,
    scrollTarget: opts.scrollTo ?? null,
    filter: source === state.source ? state.filter : 'all',
    albumParent: source === 'albums' ? state.albumParent : null
  })
  loadAssets(source)
}

export function updateSettings(patch: Partial<Settings>): void {
  if (!state.settings) return
  setState({ settings: { ...state.settings, ...patch } })
  api.setSettings(patch)
}

export function applyFilter(items: GridAsset[], filter: ShowFilter): GridAsset[] {
  switch (filter) {
    case 'favorites': return items.filter((a) => a.fav)
    case 'edited': return items.filter((a) => a.edited)
    case 'photos': return items.filter((a) => !a.video)
    case 'videos': return items.filter((a) => a.video)
    default: return items
  }
}

export function openViewer(ids: number[], id: number, source: string, origin?: DOMRect): void {
  const index = Math.max(0, ids.indexOf(id))
  setState({ viewer: { ids, index, source }, menu: null, viewerOrigin: origin ? { id, rect: origin } : null })
}

export function selectedIds(): number[] {
  return [...state.selection]
}

/** Applies a patch locally so the UI reacts immediately, then persists it. */
export async function patchAssets(ids: number[], patch: { favorite?: boolean; hidden?: boolean; deleted?: boolean; rotate?: number }): Promise<void> {
  const set = new Set(ids)
  setState((s) => ({
    assets: s.assets
      .map((a) => {
        if (!set.has(a.id)) return a
        return {
          ...a,
          fav: patch.favorite ?? a.fav,
          hidden: patch.hidden ?? a.hidden,
          rot: patch.rotate ? (((a.rot + patch.rotate) % 360) + 360) % 360 : a.rot
        }
      })
      .filter((a) => {
        if (!set.has(a.id)) return true
        if (patch.deleted !== undefined) return s.source === 'deleted' ? patch.deleted : !patch.deleted
        if (patch.hidden !== undefined) return s.source === 'hidden' ? patch.hidden : !patch.hidden
        if (patch.favorite === false && s.source === 'favorites') return false
        return true
      }),
    selection: patch.deleted !== undefined || patch.hidden !== undefined ? new Set([...s.selection].filter((x) => !set.has(x))) : s.selection
  }))
  await api.update(ids, patch)
  refreshMeta()
}

export type { ImportEntry }
