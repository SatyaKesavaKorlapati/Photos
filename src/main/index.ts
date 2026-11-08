import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { openDb, getDb } from './db'
import { isImporting, processMetadata, runImport } from './importer'
import { handleMediaProtocol, registerSchemes } from './protocol'
import {
  addToAlbum, assetDetail, createAlbum, deleteAlbum, listAlbums, listAssets, listFolders, listImports, moveAlbum, purgeAssets,
  removeFromAlbum, renameAlbum, setText, sidebarCounts, suggest, updateAssets
} from './queries'
import { backgroundProgress, cachePath, displayPath, ensureFull, ensurePreview, getRenderRow, onThumbnailDone, runBackgroundThumbs, setCacheRoot } from './render'
import { getSettings, loadSettings, resetSettings, setSettings, type Settings } from './settings'
import { getEdit, revertEdit, saveEdit, setRendersDir } from './editRender'
import { runExport, type ExportOptions } from './exporter'
import { systemAuth, systemAuthAvailable } from './auth'
import { readFileSync, writeFileSync } from 'node:fs'
import type { EditRecipe } from '../shared/edits'
import { connections, destinations, prepareFiles, saveConnections, shareFiles, type ShareConnection } from './share'
import { ensureDepth } from './depth'

app.setName('Photos')
if (process.platform === 'win32') app.setAppUserModelId('com.satyakesava.photos')
registerSchemes()
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (_e, argv) => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
  const files = incomingFiles(argv)
  if (files.length) send('open:files', files)
})

const MEDIA_EXT = /\.(jpe?g|heic|heif|png|gif|webp|tif|tiff|dng|avif|mp4|mov|m4v|webm)$/i
function incomingFiles(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && MEDIA_EXT.test(a) && existsSync(a))
}

async function setWallpaper(id: number): Promise<boolean> {
  try {
    const src = await ensureFull(id)
    const dest = join(app.getPath('userData'), 'wallpaper.jpg')
    if (src !== dest) await copyFile(src, dest)
    const quoted = dest.replace(/'/g, "''")
    await new Promise<void>((res, rej) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class P { [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int SystemParametersInfo(int a, int b, string c, int d); }'; [P]::SystemParametersInfo(20, 0, '${quoted}', 3)`
      ], (e) => e ? rej(e) : res())
    })
    return true
  } catch {
    return false
  }
}

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

async function dirSize(dir: string): Promise<number> {
  let total = 0
  const walk = async (d: string): Promise<void> => {
    let list: import('node:fs').Dirent[]
    try {
      list = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(list.map(async (e) => {
      const p = join(d, e.name)
      if (e.isDirectory()) return walk(p)
      total += (await stat(p).catch(() => ({ size: 0 }))).size
    }))
  }
  await walk(dir)
  return total
}

function kickThumbs(): void {
  if (!getSettings().backgroundThumbs) return
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
    const shotDir = process.env.PHOTOS_SHOT
    if (shotDir) {
      const shot = async (name: string) => {
        const img = await win?.webContents.capturePage()
        if (img) await writeFile(join(shotDir, name), img.toPNG())
      }
      const js = (code: string) => win?.webContents.executeJavaScript(code)
      setTimeout(() => {
        void (async () => {
          try {
            await shot('shot.png')
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true}))`)
            await new Promise((r) => setTimeout(r, 900))
            await shot('shot-settings.png')
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
            await new Promise((r) => setTimeout(r, 400))
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,altKey:true,bubbles:true}))`)
            await new Promise((r) => setTimeout(r, 900))
            await shot('shot-collapsed.png')
          } catch { /* ignore */ }
        })()
      }, 1800)
    }
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

  ipcMain.handle('share:destinations', () => destinations())
  ipcMain.handle('share:connections', () => connections())
  ipcMain.handle('share:saveConnections', (_e, list: ShareConnection[]) => saveConnections(list))
  ipcMain.handle('share:run', async (_e, ids: number[], destId: string, title: string) => {
    try {
      const files = await prepareFiles(ids, (p) => send('share:progress', p))
      send('share:progress', 1)
      return await shareFiles(files, destId, win, title)
    } catch (e) {
      return { ok: false, message: (e as Error).message.split('\n')[0] }
    }
  })
  ipcMain.handle('share:pick', async (_e, kind: 'app' | 'folder') => {
    const r = await dialog.showOpenDialog(win!, kind === 'app'
      ? { title: 'Choose an App to Share With', properties: ['openFile'], filters: [{ name: 'Apps', extensions: isMac ? ['app'] : ['exe', 'lnk', 'bat', 'cmd'] }] }
      : { title: 'Choose a Folder to Share Into', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  })
  // Drags the version shown in the library; Electron offers copy/link only, so a drop never moves the file.
  ipcMain.on('drag:start', (e, ids: number[]) => {
    const files = ids.map((id) => getRenderRow(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => displayPath(r))
    if (!files.length) return
    const thumb = cachePath('thumbs', ids[0])
    let icon = existsSync(thumb) ? nativeImage.createFromPath(thumb) : nativeImage.createEmpty()
    icon = icon.isEmpty() ? nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0x90), { width: 16, height: 16 }) : icon.resize({ width: 72 })
    e.sender.startDrag({ file: files[0], files, icon })
  })
  ipcMain.handle('asset:depth', (_e, id: number) => ensureDepth(id).catch(() => null))
  ipcMain.handle('cache:size', () => dirSize(join(libraryDir, 'Cache')))
  ipcMain.handle('cache:clear', async (_e, what: 'previews' | 'all') => {
    const root = join(libraryDir, 'Cache')
    const kinds = what === 'all' ? ['previews', 'full', 'video', 'live', 'thumbs'] : ['previews', 'full', 'video', 'live']
    for (const k of kinds) await rm(join(root, k), { recursive: true, force: true }).catch(() => undefined)
    if (what === 'all') {
      getDb().exec('UPDATE assets SET thumb_done = 0')
      kickThumbs()
    }
    libraryChanged()
    return dirSize(root)
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
    if (patch.backgroundThumbs) kickThumbs()
    return s
  })
  ipcMain.handle('settings:reset', () => {
    const s = resetSettings()
    applyTheme(s)
    return s
  })
  ipcMain.handle('asset:wallpaper', (_e, id: number) => setWallpaper(id))
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
  const launched = incomingFiles(process.argv)
  if (launched.length) win?.webContents.once('did-finish-load', () => send('open:files', launched))

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
