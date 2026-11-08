import { contextBridge, ipcRenderer, webUtils } from 'electron'

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args)

const on = (ch: string, fn: (payload: any) => void): (() => void) => {
  const h = (_e: unknown, p: unknown) => fn(p)
  ipcRenderer.on(ch, h)
  return () => ipcRenderer.removeListener(ch, h)
}

const api = {
  platform: process.platform,
  list: (source: string) => invoke('library:list', source),
  counts: () => invoke('library:counts'),
  folders: () => invoke('library:folders'),
  imports: () => invoke('library:imports'),
  suggest: (q: string) => invoke('library:suggest', q),
  detail: (id: number) => invoke('asset:detail', id),
  update: (ids: number[], patch: Record<string, unknown>) => invoke('asset:update', ids, patch),
  setText: (id: number, field: string, value: string) => invoke('asset:text', id, field, value),
  purge: (ids: number[]) => invoke('asset:purge', ids),
  showInFolder: (path: string) => invoke('asset:show', path),
  openPath: (path: string) => invoke('asset:open', path),
  copyImage: (id: number) => invoke('asset:copy', id),
  exportAssets: (ids: number[], mode: 'original' | 'current') => invoke('asset:export', ids, mode),
  runExport: (ids: number[], opts: Record<string, unknown>) => invoke('export:run', ids, opts),
  getEdit: (id: number) => invoke('edit:get', id),
  saveEdit: (id: number, recipe: unknown, png: Uint8Array | null, out: { w: number; h: number }) => invoke('edit:save', id, recipe, png, out),
  revertEdit: (id: number) => invoke('edit:revert', id),
  authAvailable: () => invoke('auth:available'),
  authVerify: (reason: string) => invoke('auth:verify', reason),
  albums: () => invoke('albums:list'),
  createAlbum: (name: string, parentId: number | null, isFolder: boolean, ids?: number[]) => invoke('albums:create', name, parentId, isFolder, ids),
  renameAlbum: (id: number, name: string) => invoke('albums:rename', id, name),
  deleteAlbum: (id: number) => invoke('albums:delete', id),
  moveAlbum: (id: number, parentId: number | null) => invoke('albums:move', id, parentId),
  addToAlbum: (albumId: number, ids: number[]) => invoke('albums:add', albumId, ids),
  removeFromAlbum: (albumId: number, ids: number[]) => invoke('albums:remove', albumId, ids),
  pickImport: (mode: 'folder' | 'files') => invoke('import:pick', mode),
  startImport: (sources: { folders?: string[]; files?: string[] }, copy: boolean) => invoke('import:start', sources, copy),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => invoke('settings:set', patch),
  info: () => invoke('app:info'),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    fullscreen: (on?: boolean) => ipcRenderer.send('window:fullscreen', on),
    isFullscreen: () => invoke('window:isFullscreen'),
    close: () => ipcRenderer.send('window:close')
  },
  on
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
