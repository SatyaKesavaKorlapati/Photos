import {
  Copy, Download, EyeOff, Eye, FolderOpen, Heart, HeartOff, Info, ExternalLink, Plus, RotateCcw, Trash2, Undo2, Images, FolderPlus, MinusCircle
} from 'lucide-react'
import { api, fileManager, isMac, mod } from './api'
import { getState, patchAssets, refreshAll, setState, toast, type MenuItem } from './store'
import { formatBytes, plural } from './util'

const word = (ids: number[]): string => {
  const list = getState().assets.filter((a) => ids.includes(a.id))
  const v = list.filter((a) => a.video).length
  const n = ids.length
  if (v === n) return plural(n, 'Video')
  if (v === 0) return plural(n, 'Photo')
  return plural(n, 'Item')
}

export async function toggleFavorite(ids: number[]): Promise<void> {
  const list = getState().assets.filter((a) => ids.includes(a.id))
  const make = !list.every((a) => a.fav)
  await patchAssets(ids, { favorite: make })
}

export const rotate = (ids: number[], deg = -90): Promise<void> => patchAssets(ids, { rotate: deg })

export async function hide(ids: number[], v = true): Promise<void> {
  await patchAssets(ids, { hidden: v })
  toast(v ? `${word(ids)} hidden` : `${word(ids)} unhidden`)
}

export async function trash(ids: number[]): Promise<void> {
  await patchAssets(ids, { deleted: true })
  setState({ selection: new Set() })
  toast(`${word(ids)} moved to Recently Deleted`)
}

export async function restore(ids: number[]): Promise<void> {
  await patchAssets(ids, { deleted: false })
  toast(`Recovered ${word(ids)}`)
}

export async function purge(ids: number[]): Promise<void> {
  if (await api.purge(ids)) {
    setState({ selection: new Set(), viewer: null })
    refreshAll()
  }
}

export async function exportAssets(ids: number[], mode: 'original' | 'current'): Promise<void> {
  const r = await api.exportAssets(ids, mode)
  if (r) toast(`Exported ${plural(r.files, 'file')} · ${formatBytes(r.bytes)} · byte-for-byte`)
}

export async function showInFolder(id: number): Promise<void> {
  const d = await api.detail(id)
  api.showInFolder(d.edited_path ?? d.original_path)
}

export async function openWithDefault(id: number): Promise<void> {
  const d = await api.detail(id)
  api.openPath(d.edited_path ?? d.original_path)
}

export function promptNewAlbum(ids: number[] = [], folder = false, parentId: number | null = null): void {
  setState({
    sheet: {
      kind: 'prompt',
      title: folder ? 'New Folder' : 'New Album',
      placeholder: folder ? 'Folder Name' : 'Album Name',
      confirm: 'Create',
      onSubmit: async (name) => {
        await api.createAlbum(name, parentId, folder, ids)
        await refreshAll()
        if (ids.length) toast(`Added ${word(ids)} to “${name}”`)
      }
    }
  })
}

export async function addToAlbum(albumId: number, ids: number[]): Promise<void> {
  await api.addToAlbum(albumId, ids)
  const a = getState().albums.find((x) => x.id === albumId)
  toast(`Added ${word(ids)} to “${a?.name ?? 'Album'}”`)
  refreshAll()
}

export async function removeFromAlbum(albumId: number, ids: number[]): Promise<void> {
  await api.removeFromAlbum(albumId, ids)
  setState((s) => ({ assets: s.assets.filter((a) => !ids.includes(a.id)), selection: new Set() }))
  refreshAll()
}

function albumSubmenu(ids: number[]): MenuItem[] {
  const albums = getState().albums.filter((a) => !a.isFolder)
  return [
    { label: 'New Album…', icon: <Plus size={14} />, onClick: () => promptNewAlbum(ids) },
    ...(albums.length ? [{ separator: true } as MenuItem] : []),
    ...albums.map((a) => ({ label: a.name, icon: <Images size={14} />, onClick: () => addToAlbum(a.id, ids) }))
  ]
}

export function assetMenu(ids: number[], opts: { onInfo?: () => void; viewer?: boolean } = {}): MenuItem[] {
  const s = getState()
  const list = s.assets.filter((a) => ids.includes(a.id))
  const allFav = list.length > 0 && list.every((a) => a.fav)
  const inDeleted = s.source === 'deleted'
  const inHidden = s.source === 'hidden'
  const albumId = s.source.startsWith('album:') ? Number(s.source.slice(6)) : null
  const one = ids.length === 1
  const label = word(ids)

  if (inDeleted) {
    return [
      { label: `Recover ${label}`, icon: <Undo2 size={14} />, onClick: () => restore(ids) },
      { separator: true },
      { label: `Remove ${label} from Library…`, icon: <Trash2 size={14} />, danger: true, onClick: () => purge(ids) }
    ]
  }

  return [
    { label: 'Get Info', icon: <Info size={14} />, shortcut: `${mod}I`, onClick: opts.onInfo ?? (() => setState({ infoOpen: true })), disabled: !one },
    { label: 'Rotate Anticlockwise', icon: <RotateCcw size={14} />, shortcut: `${mod}R`, onClick: () => rotate(ids) },
    {
      label: allFav ? 'Unfavourite' : 'Favourite',
      icon: allFav ? <HeartOff size={14} /> : <Heart size={14} />,
      shortcut: '.',
      onClick: () => toggleFavorite(ids)
    },
    { separator: true },
    { label: 'Copy', icon: <Copy size={14} />, shortcut: `${mod}C`, onClick: () => api.copyImage(ids[0]).then(() => toast('Copied')), disabled: !one },
    { label: 'Add to', icon: <Plus size={14} />, submenu: albumSubmenu(ids) },
    ...(albumId ? [{ label: 'Remove from Album', icon: <MinusCircle size={14} />, onClick: () => removeFromAlbum(albumId, ids) } as MenuItem] : []),
    { separator: true },
    {
      label: 'Export',
      icon: <Download size={14} />,
      submenu: [
        { label: `Export ${label}…`, onClick: () => exportAssets(ids, 'current') },
        { label: `Export Unmodified Original${ids.length > 1 ? 's' : ''}…`, shortcut: isMac ? '⇧⌘E' : 'Ctrl+Shift+E', onClick: () => exportAssets(ids, 'original') }
      ]
    },
    { label: `Show in ${fileManager}`, icon: <FolderOpen size={14} />, onClick: () => showInFolder(ids[0]), disabled: !one },
    { label: 'Open With Default App', icon: <ExternalLink size={14} />, onClick: () => openWithDefault(ids[0]), disabled: !one },
    { separator: true },
    inHidden
      ? { label: `Unhide ${label}`, icon: <Eye size={14} />, shortcut: `${mod}L`, onClick: () => hide(ids, false) }
      : { label: `Hide ${label}`, icon: <EyeOff size={14} />, shortcut: `${mod}L`, onClick: () => hide(ids, true) },
    { label: `Delete ${label}`, icon: <Trash2 size={14} />, shortcut: isMac ? '⌘⌫' : 'Del', danger: true, onClick: () => trash(ids) }
  ]
}

export function albumMenu(albumId: number, isFolder: boolean, onRename: () => void): MenuItem[] {
  return [
    ...(isFolder
      ? [
          { label: 'New Album in Folder…', icon: <Plus size={14} />, onClick: () => promptNewAlbum([], false, albumId) },
          { label: 'New Folder in Folder…', icon: <FolderPlus size={14} />, onClick: () => promptNewAlbum([], true, albumId) },
          { separator: true } as MenuItem
        ]
      : []),
    { label: `Rename ${isFolder ? 'Folder' : 'Album'}`, onClick: onRename },
    { separator: true },
    {
      label: `Delete ${isFolder ? 'Folder' : 'Album'}`,
      danger: true,
      icon: <Trash2 size={14} />,
      onClick: async () => {
        await api.deleteAlbum(albumId)
        if (getState().source === `album:${albumId}`) setState({ source: 'albums' })
        refreshAll()
      }
    }
  ]
}
