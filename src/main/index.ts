import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { openDb, getDb } from './db'
import { isImporting, processMetadata, runImport } from './importer'
import { handleMediaProtocol, registerSchemes } from './protocol'
import {
  addToAlbum, assetDetail, createAlbum, deleteAlbum, listAlbums, listAssets, listFolders, listImports, moveAlbum, purgeAssets,
  removeFromAlbum, renameAlbum, setText, sidebarCounts, suggest, updateAssets
} from './queries'
import { backgroundProgress, ensurePreview, onThumbnailDone, runBackgroundThumbs, setCacheRoot } from './render'
import { getSettings, loadSettings, setSettings, type Settings } from './settings'
import { getEdit, revertEdit, saveEdit, setRendersDir } from './editRender'
import { runExport, type ExportOptions } from './exporter'
import { systemAuth, systemAuthAvailable } from './auth'
import { readFileSync, writeFileSync } from 'node:fs'
import type { EditRecipe } from '../shared/edits'

app.setName('Photos')
registerSchemes()
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

interface WinState { x?: number; y?: number; width: number; height: number; maximized?: boolean }
const winStateFile = (): string => join(app.getPath('userData'), 'window.json')
function loadWinState(): WinState {
  try {
    return { width: 1440, height: 920, ...JSON.parse(readFileSync(winStateFile(), 'utf8')) }
  } catch {
    return { width: 1440, height: 920 }
  }
}
function saveWinState(): void {
  if (!win || win.isFullScreen()) return
  const b = win.getNormalBounds()
  try {
    writeFileSync(winStateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }))
  } catch { /* ignore */ }
}

const isMac = process.platform === 'darwin'
let win: BrowserWindow | null = null
let libraryDir = ''

function send(channel: string, payload?: unknown): void {
  win?.webContents.send(channel, payload)
}

let changeTimer: NodeJS.Timeout | null = null
function libraryChanged(): void {
  if (changeTimer) return
  changeTimer = setTimeout(() => {
    changeTimer = null
    send('library:changed')
  }, 600)
}

function kickThumbs(): void {
  runBackgroundThumbs((p) => {
    send('thumbs:progress', p)
    if (!p.running) libraryChanged()
  }).catch(() => undefined)
}

function applyTheme(s: Settings): void {
  nativeTheme.themeSource = s.appearance
}

function createWindow(): void {
  const icon = join(__dirname, '../../build/icon.png')
  const st = loadWinState()
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 920,
    minHeight: 600,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 22, y: 22 },
    backgroundColor: '#1b1b1d',
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.once('ready-to-show', () => {
    if (st.maximized) win?.maximize()
    win?.show()
  })
  win.on('close', saveWinState)
  win.on('maximize', () => send('window:state', { maximized: true }))
  win.on('unmaximize', () => send('window:state', { maximized: false }))
  win.on('enter-full-screen', () => send('window:state', { fullscreen: true }))
  win.on('leave-full-screen', () => send('window:state', { fullscreen: false }))
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }
  const cmd = (id: string) => () => send('menu:command', id)
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Album', accelerator: 'Cmd+N', click: cmd('new-album') },
        { label: 'New Folder', accelerator: 'Cmd+Alt+N', click: cmd('new-folder') },
        { type: 'separator' },
        { label: 'Import Folder…', accelerator: 'Cmd+Shift+I', click: cmd('import-folder') },
        { label: 'Import Photos…', click: cmd('import-files') },
        { label: 'Export…', accelerator: 'Cmd+Shift+E', click: cmd('export') },
        { label: 'Export Unmodified Original…', accelerator: 'Cmd+Alt+Shift+E', click: cmd('export-original') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Image',
      submenu: [
        { label: 'Favourite', accelerator: '.', click: cmd('favorite') },
        { label: 'Rotate Anticlockwise', accelerator: 'Cmd+R', click: cmd('rotate') },
        { label: 'Hide', accelerator: 'Cmd+L', click: cmd('hide') },
        { label: 'Delete', accelerator: 'Cmd+Backspace', click: cmd('delete') },
        { type: 'separator' },
        { label: 'Edit', accelerator: 'Cmd+E', click: cmd('edit') },
        { label: 'Get Info', accelerator: 'Cmd+I', click: cmd('info') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Years', accelerator: 'Cmd+1', click: cmd('view-years') },
        { label: 'Months', accelerator: 'Cmd+2', click: cmd('view-months') },
        { label: 'Days', accelerator: 'Cmd+3', click: cmd('view-days') },
        { label: 'All Photos', accelerator: 'Cmd+4', click: cmd('view-all') },
        { type: 'separator' },
        { label: 'Show Sidebar', accelerator: 'Cmd+Alt+S', click: cmd('toggle-sidebar') },
        { label: 'Select', accelerator: 'Cmd+Shift+S', click: cmd('select-mode') },
        { label: 'Zoom In', accelerator: 'Cmd+=', click: cmd('zoom-in') },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: cmd('zoom-out') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function uniqueDest(dir: string, name: string): Promise<string> {
  let dest = join(dir, name)
  let n = 1
  while (existsSync(dest)) {
    dest = join(dir, `${basename(name, extname(name))} (${n++})${extname(name)}`)
  }
  return dest
}

/** Byte-exact export. "original" exports every file of the asset (like Photos' Export Unmodified Original). */
async function exportAssets(ids: number[], dir: string, mode: 'original' | 'current'): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  await mkdir(dir, { recursive: true })
  for (const id of ids) {
    const r = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, any> | undefined
    if (!r) continue
    const list: string[] =
      mode === 'original'
        ? [r.original_path, r.edited_path, r.live_path, r.live_edited_path, r.aae_path, ...JSON.parse(r.sidecars || '[]')].filter(Boolean)
        : [r.edited_path ?? r.original_path, r.live_edited_path ?? r.live_path].filter(Boolean)
    for (const src of list) {
      const dest = await uniqueDest(dir, basename(src))
      await copyFile(src, dest)
      const [a, b] = await Promise.all([stat(src), stat(dest)])
      if (a.size !== b.size) throw new Error(`Export size mismatch for ${basename(src)}`)
      files++
      bytes += a.size
    }
  }
  return { files, bytes }
}

function registerIpc(): void {
  ipcMain.handle('library:list', (_e, source: string) => listAssets(source))
  ipcMain.handle('library:counts', () => ({ ...sidebarCounts(), importing: isImporting(), thumbs: backgroundProgress() }))
  ipcMain.handle('library:folders', () => listFolders())
  ipcMain.handle('library:imports', () => listImports())
  ipcMain.handle('library:suggest', (_e, q: string) => suggest(q))
  ipcMain.handle('asset:detail', (_e, id: number) => assetDetail(id))
  ipcMain.handle('asset:update', (_e, ids: number[], patch) => {
    updateAssets(ids, patch)
    libraryChanged()
  })
  ipcMain.handle('asset:text', (_e, id: number, field: 'title' | 'caption' | 'keywords', value: string) => setText(id, field, value))
  // The renderer shows the confirmation sheet before calling this.
  ipcMain.handle('asset:purge', async (_e, ids: number[]) => {
    for (const id of ids) await revertEdit(id).catch(() => undefined)
    purgeAssets(ids)
    libraryChanged()
    return true
  })
  ipcMain.handle('asset:show', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('asset:open', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('asset:copy', async (_e, id: number) => {
    const p = await ensurePreview(id)
    const png = nativeImage.createFromPath(p).toPNG()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  })
  ipcMain.handle('asset:export', async (_e, ids: number[], mode: 'original' | 'current') => {
    const r = await dialog.showOpenDialog(win!, {
      title: mode === 'original' ? 'Export Unmodified Original' : 'Export',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Export'
    })
    if (r.canceled || !r.filePaths[0]) return null
    return exportAssets(ids, r.filePaths[0], mode)
  })

  ipcMain.handle('export:run', async (_e, ids: number[], opts: ExportOptions) => {
    const r = await dialog.showOpenDialog(win!, {
      title: opts.unmodified ? 'Export Unmodified Original' : 'Export',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Export'
    })
    if (r.canceled || !r.filePaths[0]) return null
    return runExport(ids, r.filePaths[0], opts, (p) => send('export:progress', p))
  })

  ipcMain.handle('edit:get', (_e, id: number) => getEdit(id))
  ipcMain.handle('edit:save', async (_e, id: number, recipe: EditRecipe, png: Uint8Array | null, out: { w: number; h: number }) => {
    await saveEdit(id, recipe, png, out, (p) => send('edit:progress', { id, p }))
    libraryChanged()
    kickThumbs()
  })
  ipcMain.handle('edit:revert', async (_e, id: number) => {
    await revertEdit(id)
    libraryChanged()
    kickThumbs()
  })

  ipcMain.handle('auth:available', () => systemAuthAvailable())
  ipcMain.handle('auth:verify', (_e, reason: string) => systemAuth(win, reason))

  ipcMain.handle('albums:list', () => listAlbums())
  ipcMain.handle('albums:create', (_e, name: string, parentId: number | null, isFolder: boolean, ids?: number[]) => {
    const id = createAlbum(name, parentId, isFolder, ids)
    libraryChanged()
    return id
  })
  ipcMain.handle('albums:rename', (_e, id: number, name: string) => renameAlbum(id, name))
  ipcMain.handle('albums:delete', (_e, id: number) => {
    deleteAlbum(id)
    libraryChanged()
  })
  ipcMain.handle('albums:move', (_e, id: number, parentId: number | null) => moveAlbum(id, parentId))
  ipcMain.handle('albums:add', (_e, albumId: number, ids: number[]) => {
    addToAlbum(albumId, ids)
    libraryChanged()
  })
  ipcMain.handle('albums:remove', (_e, albumId: number, ids: number[]) => {
    removeFromAlbum(albumId, ids)
    libraryChanged()
  })

  ipcMain.handle('import:pick', async (_e, mode: 'folder' | 'files') => {
    const r = await dialog.showOpenDialog(win!, {
      title: mode === 'folder' ? 'Import Folder' : 'Import Photos',
      buttonLabel: 'Review for Import',
      properties: mode === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters:
        mode === 'files'
          ? [{ name: 'Photos & Videos', extensions: ['heic', 'heif', 'jpg', 'jpeg', 'png', 'dng', 'webp', 'gif', 'avif', 'tif', 'tiff', 'mov', 'mp4', 'm4v'] }]
          : undefined
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('import:start', async (_e, sources: { folders?: string[]; files?: string[] }, copy: boolean) => {
    const id = await runImport(sources, { copy, libraryDir }, (p) => {
      send('import:progress', p)
      if (p.phase === 'adding' || p.phase === 'done') libraryChanged()
      if (p.phase === 'done') kickThumbs()
    })
    return id
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = setSettings(patch)
    applyTheme(s)
    return s
  })
  ipcMain.handle('app:info', () => ({ platform: process.platform, libraryDir, version: app.getVersion() }))

  ipcMain.on('window:minimize', () => win?.minimize())
  ipcMain.on('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.on('window:fullscreen', (_e, on?: boolean) => win?.setFullScreen(on ?? !win.isFullScreen()))
  ipcMain.handle('window:isFullscreen', () => !!win?.isFullScreen())
  ipcMain.on('window:close', () => win?.close())
}

app.whenReady().then(async () => {
  libraryDir = process.env.PHOTOS_LIBRARY ?? join(app.getPath('userData'), 'Library')
  openDb(libraryDir)
  setCacheRoot(join(libraryDir, 'Cache'))
  setRendersDir(join(libraryDir, 'Renders'))
  applyTheme(loadSettings(libraryDir))
  handleMediaProtocol()
  registerIpc()
  buildMenu()
  createWindow()

  let thumbTick = 0
  onThumbnailDone(() => {
    if (++thumbTick % 60 === 0) libraryChanged()
  })

  const seed = process.env.PHOTOS_IMPORT
  const count = (getDb().prepare('SELECT COUNT(*) n FROM assets').get() as { n: number }).n
  if (seed && count === 0 && existsSync(seed)) {
    await runImport({ folders: [seed] }, { copy: false, libraryDir }, (p) => {
      send('import:progress', p)
      if (p.phase === 'adding' || p.phase === 'done') libraryChanged()
      if (p.phase === 'done') kickThumbs()
    })
  } else {
    processMetadata().then(() => {
      libraryChanged()
      kickThumbs()
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
