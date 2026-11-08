import {
  Copy, Download, EyeOff, Eye, FolderOpen, Heart, HeartOff, Info, ExternalLink, Plus, RotateCcw, Trash2, Undo2, Images, FolderPlus, MinusCircle,
  SlidersHorizontal, Play, Share
} from 'lucide-react'
import { api, fileManager, isMac, mod } from './api'
import { confirmSheet, getState, patchAssets, refreshAll, setState, toast, type MenuItem } from './store'
import { plural } from './util'

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
  if (!ids.length) return
  const label = word(ids)
  await patchAssets(ids, { hidden: v })
  toast(v ? `${label} hidden` : `${label} unhidden`, {
    label: 'Undo',
    run: async () => {
      await api.update(ids, { hidden: !v })
      refreshAll()
    }
  })
}

/** Moves to Recently Deleted after an Apple-style confirmation. Resolves false when cancelled. */
export async function trash(ids: number[]): Promise<boolean> {
  if (!ids.length) return false
  const label = word(ids)
  if (getState().settings?.confirmDelete !== false) {
    const ok = await confirmSheet({
      title: `Delete ${label}?`,
      message: `${ids.length === 1 ? 'This item' : 'These items'} will be moved to Recently Deleted. Files on disk are never touched, and you can recover ${ids.length === 1 ? 'it' : 'them'} at any time.`,
      confirm: `Delete ${label}`,
      danger: true
    })
    if (!ok) return false
  }
  await patchAssets(ids, { deleted: true })
  toast(`${label} moved to Recently Deleted`, {
    label: 'Undo',
    run: async () => {
      await api.update(ids, { deleted: false })
      refreshAll()
    }
  })
  return true
}

export async function restore(ids: number[]): Promise<void> {
  await patchAssets(ids, { deleted: false })
  toast(`Recovered ${word(ids)}`)
}

export async function purge(ids: number[]): Promise<boolean> {
  if (!ids.length) return false
  const label = word(ids)
  const ok = await confirmSheet({
    title: `Remove ${label} from the Library?`,
    message: 'This can’t be undone in Photos. The original files on disk stay untouched — only the library entry and any edits made in Photos are removed.',
    confirm: 'Remove from Library',
    danger: true
  })
  if (!ok) return false
  await api.purge(ids)
  setState({ selection: new Set(), viewer: null })
  refreshAll()
  return true
}

export function exportAssets(ids: number[], mode: 'original' | 'current'): void {
  if (!ids.length) return
  setState({ sheet: { kind: 'export', ids, unmodified: mode === 'original' }, menu: null })
}

export function openEditor(id: number): void {
  setState({ editor: { id }, menu: null })
}

export async function showInFolder(id: number): Promise<void> {
  const d = await api.detail(id)
  api.showInFolder(d.user_render ?? d.edited_path ?? d.original_path)
}

export async function openWithDefault(id: number): Promise<void> {
  const d = await api.detail(id)
  api.openPath(d.user_render ?? d.edited_path ?? d.original_path)
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
  toast(`Removed ${word(ids)} from the album`, {
    label: 'Undo',
    run: async () => {
      await api.addToAlbum(albumId, ids)
      refreshAll()
    }
  })
  refreshAll()
}

export function albumSubmenu(ids: number[]): MenuItem[] {
  const albums = getState().albums.filter((a) => !a.isFolder)
  return [
    { label: 'New Album…', icon: <Plus size={14} />, onClick: () => promptNewAlbum(ids) },
    ...(albums.length ? [{ separator: true } as MenuItem] : []),
    ...albums.map((a) => ({ label: a.name, icon: <Images size={14} />, onClick: () => addToAlbum(a.id, ids) }))
  ]
}

export function slideshow(ids: number[]): void {
  setState({ slideshow: { ids, title: '' }, menu: null })
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
    {
      quick: [
        { label: 'Slideshow', icon: <Play size={17} />, onClick: () => slideshow(ids.length > 1 ? ids : s.assets.map((a) => a.id).slice(Math.max(0, s.assets.findIndex((a) => a.id === ids[0])))) },
        { label: allFav ? 'Unfavourite' : 'Favourite', icon: allFav ? <HeartOff size={17} /> : <Heart size={17} />, onClick: () => toggleFavorite(ids) },
        { label: 'Share', icon: <Share size={17} />, onClick: () => exportAssets(ids, 'current') },
        { label: 'Delete', icon: <Trash2 size={17} />, danger: true, onClick: () => void trash(ids) }
      ]
    },
    { label: 'Edit', icon: <SlidersHorizontal size={14} />, shortcut: `${mod}E`, onClick: () => openEditor(ids[0]), disabled: !one },
    { label: 'Get Info', icon: <Info size={14} />, shortcut: `${mod}I`, onClick: opts.onInfo ?? (() => setState({ infoOpen: true })), disabled: !one },
    { label: 'Rotate Anticlockwise', icon: <RotateCcw size={14} />, shortcut: `${mod}R`, onClick: () => rotate(ids) },
    { separator: true },
    { label: 'Copy', icon: <Copy size={14} />, shortcut: `${mod}C`, onClick: () => api.copyImage(ids[0]).then(() => toast('Copied')), disabled: !one },
    { label: 'Add to', icon: <Plus size={14} />, submenu: albumSubmenu(ids) },
    ...(albumId ? [{ label: 'Remove from Album', icon: <MinusCircle size={14} />, onClick: () => removeFromAlbum(albumId, ids) } as MenuItem] : []),
    { separator: true },
    {
      label: 'Export',
      icon: <Download size={14} />,
      submenu: [
        { label: `Export ${label}…`, shortcut: isMac ? '⇧⌘E' : 'Ctrl+Shift+E', onClick: () => exportAssets(ids, 'current') },
        { label: `Export Unmodified Original${ids.length > 1 ? 's' : ''}…`, shortcut: isMac ? '⌥⇧⌘E' : 'Ctrl+Alt+Shift+E', onClick: () => exportAssets(ids, 'original') }
      ]
    },
    { label: `Show in ${fileManager}`, icon: <FolderOpen size={14} />, onClick: () => showInFolder(ids[0]), disabled: !one },
    { label: 'Open With Default App', icon: <ExternalLink size={14} />, onClick: () => openWithDefault(ids[0]), disabled: !one },
    { separator: true },
    inHidden
      ? { label: `Unhide ${label}`, icon: <Eye size={14} />, shortcut: `${mod}L`, onClick: () => hide(ids, false) }
      : { label: `Hide ${label}`, icon: <EyeOff size={14} />, shortcut: `${mod}L`, onClick: () => hide(ids, true) },
    { label: `Delete ${label}…`, icon: <Trash2 size={14} />, shortcut: isMac ? '⌘⌫' : 'Del', danger: true, onClick: () => void trash(ids) }
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
      label: `Delete ${isFolder ? 'Folder' : 'Album'}…`,
      danger: true,
      icon: <Trash2 size={14} />,
      onClick: async () => {
        const name = getState().albums.find((a) => a.id === albumId)?.name ?? ''
        const ok = await confirmSheet({
          title: `Delete “${name}”?`,
          message: isFolder
            ? 'The folder and the albums inside it are deleted. Photos stay in your library.'
            : 'The album is deleted. The photos in it stay in your library.',
          confirm: `Delete ${isFolder ? 'Folder' : 'Album'}`,
          danger: true
        })
        if (!ok) return
        await api.deleteAlbum(albumId)
        if (getState().source === `album:${albumId}`) setState({ source: 'albums' })
        refreshAll()
      }
    }
  ]
}
