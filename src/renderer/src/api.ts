import type {
  Album, AssetDetail, FolderEntry, GridAsset, ImportEntry, ImportProgress, Settings, Suggestion, ThumbProgress
} from './types'
import type { ExportOptions, ExportProgress } from './types'
import type { EditRecipe } from '../../shared/edits'

interface Api {
  platform: string
  list(source: string): Promise<GridAsset[]>
  counts(): Promise<Record<string, number> & { importing: boolean; thumbs: ThumbProgress }>
  folders(): Promise<FolderEntry[]>
  imports(): Promise<ImportEntry[]>
  suggest(q: string): Promise<Suggestion[]>
  detail(id: number): Promise<AssetDetail>
  update(ids: number[], patch: { favorite?: boolean; hidden?: boolean; deleted?: boolean; rotate?: number }): Promise<void>
  setText(id: number, field: 'title' | 'caption' | 'keywords', value: string): Promise<void>
  purge(ids: number[]): Promise<boolean>
  showInFolder(path: string): Promise<void>
  openPath(path: string): Promise<string>
  copyImage(id: number): Promise<void>
  exportAssets(ids: number[], mode: 'original' | 'current'): Promise<{ files: number; bytes: number } | null>
  runExport(ids: number[], opts: ExportOptions): Promise<ExportProgress | null>
  getEdit(id: number): Promise<{ recipe: EditRecipe; out: { w: number; h: number }; at: number } | null>
  saveEdit(id: number, recipe: EditRecipe, png: Uint8Array | null, out: { w: number; h: number }): Promise<void>
  revertEdit(id: number): Promise<void>
  authAvailable(): Promise<boolean>
  authVerify(reason: string): Promise<'ok' | 'cancelled' | 'unavailable'>
  albums(): Promise<Album[]>
  createAlbum(name: string, parentId: number | null, isFolder: boolean, ids?: number[]): Promise<number>
  renameAlbum(id: number, name: string): Promise<void>
  deleteAlbum(id: number): Promise<void>
  moveAlbum(id: number, parentId: number | null): Promise<void>
  addToAlbum(albumId: number, ids: number[]): Promise<void>
  removeFromAlbum(albumId: number, ids: number[]): Promise<void>
  pickImport(mode: 'folder' | 'files'): Promise<string[]>
  startImport(sources: { folders?: string[]; files?: string[] }, copy: boolean): Promise<number>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  info(): Promise<{ platform: string; libraryDir: string; version: string }>
  pathForFile(f: File): string
  win: { minimize(): void; maximize(): void; fullscreen(on?: boolean): void; isFullscreen(): Promise<boolean>; close(): void }
  on(channel: 'export:progress', fn: (p: ExportProgress) => void): () => void
  on(channel: 'edit:progress', fn: (p: { id: number; p: number }) => void): () => void
  on(channel: 'library:changed', fn: () => void): () => void
  on(channel: 'import:progress', fn: (p: ImportProgress) => void): () => void
  on(channel: 'thumbs:progress', fn: (p: ThumbProgress) => void): () => void
  on(channel: 'window:state', fn: (p: { maximized?: boolean; fullscreen?: boolean }) => void): () => void
  on(channel: 'menu:command', fn: (cmd: string) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}

export const api: Api = window.api
export const isMac = api.platform === 'darwin'
export const mod = isMac ? '⌘' : 'Ctrl+'
export const fileManager = isMac ? 'Finder' : 'File Explorer'

/** In-app edits change what these URLs serve, so each carries the edit version to bypass the immutable HTTP cache. */
const ver = new Map<number, number>()
export const setEditVersions = (list: { id: number; ev: number }[]): void => list.forEach((a) => a.ev && ver.set(a.id, a.ev))
export const bumpEditVersion = (id: number, ev = Date.now()): void => void ver.set(id, ev)
const q = (id: number, original = false, extra = ''): string => {
  const p = [original ? 'original=1' : '', !original && ver.get(id) ? `v=${ver.get(id)}` : '', extra].filter(Boolean)
  return p.length ? `?${p.join('&')}` : ''
}
export const thumbUrl = (id: number): string => `media://thumb/${id}${q(id)}`
export const previewUrl = (id: number, original = false): string => `media://preview/${id}${q(id, original)}`
export const fullUrl = (id: number, original = false): string => `media://full/${id}${q(id, original)}`
export const videoUrl = (id: number, original = false): string => `media://video/${id}${q(id, original)}`
export const liveUrl = (id: number, original = false): string => `media://live/${id}${q(id, original)}`
export const baseUrl = (id: number): string => `media://base/${id}?t=${ver.get(id) ?? 0}`
export const stripUrl = (id: number): string => `media://strip/${id}`
export const bounceUrl = (id: number): string => `media://bounce/${id}${q(id)}`
export const longExposureUrl = (id: number): string => `media://longexposure/${id}`
export const compatUrl = (id: number, which: 'video' | 'live' = 'video'): string => `media://compat/${id}?which=${which}`
