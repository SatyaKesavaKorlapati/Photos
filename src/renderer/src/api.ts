import type {
  Album, AssetDetail, FolderEntry, GridAsset, ImportEntry, ImportProgress, Settings, Suggestion, ThumbProgress
} from './types'

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
  win: { minimize(): void; maximize(): void; fullscreen(): void; close(): void }
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

export const thumbUrl = (id: number): string => `media://thumb/${id}`
export const previewUrl = (id: number, original = false): string => `media://preview/${id}${original ? '?original=1' : ''}`
export const fullUrl = (id: number, original = false): string => `media://full/${id}${original ? '?original=1' : ''}`
export const videoUrl = (id: number, original = false): string => `media://video/${id}${original ? '?original=1' : ''}`
export const liveUrl = (id: number, original = false): string => `media://live/${id}${original ? '?original=1' : ''}`
export const bounceUrl = (id: number): string => `media://bounce/${id}`
export const longExposureUrl = (id: number): string => `media://longexposure/${id}`
export const compatUrl = (id: number, which: 'video' | 'live' = 'video'): string => `media://compat/${id}?which=${which}`
