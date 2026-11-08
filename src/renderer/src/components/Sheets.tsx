import { useEffect, useState } from 'react'
import { FolderInput, ImagePlus, CheckCircle2, AlertTriangle, Trash2, ChevronDown } from 'lucide-react'
import { api, mod } from '../api'
import { navigate, refreshAll, setState, toast, updateSettings, useStore, type Sheet } from '../store'
import { openMenu } from './Menu'
import type { ExportOptions, ExportProgress, ImportProgress, PhotoFormat, VideoFormat } from '../types'
import { formatBytes } from '../util'
import { Segmented, Switch } from './Controls'

const close = () => setState({ sheet: null })

function Backdrop({ children, onClose = close }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {children}
    </div>
  )
}

const PHASE: Record<ImportProgress['phase'], string> = {
  scanning: 'Looking for photos and videos…',
  copying: 'Copying originals into the library (byte-for-byte, SHA-256 verified)…',
  adding: 'Adding to your library…',
  reading: 'Reading metadata, Live Photo pairs, Portrait & edit sidecars…',
  done: 'Import complete',
  error: 'Import failed'
}

function ImportSheet({ sheet }: { sheet: Extract<Sheet, { kind: 'import' }> }) {
  const settings = useStore((s) => s.settings)
  const progress = useStore((s) => s.importProgress)
  const [started, setStarted] = useState(false)
  const [copy, setCopy] = useState(settings?.copyOnImport ?? false)
  const [sources, setSources] = useState<{ folders?: string[]; files?: string[] }>({ folders: sheet.folders, files: sheet.files })
  const hasSources = !!(sources.folders?.length || sources.files?.length)
  const running = progress && progress.phase !== 'done' && progress.phase !== 'error'

  const pick = async (mode: 'folder' | 'files') => {
    const p = await api.pickImport(mode)
    if (p.length) setSources(mode === 'folder' ? { folders: p } : { files: p })
  }

  const start = async () => {
    setStarted(true)
    setState({ importProgress: { importId: 0, phase: 'scanning', done: 0, total: 0, added: 0, skipped: 0, orphans: 0 } })
    updateSettings({ copyOnImport: copy })
    await api.startImport(sources, copy)
  }

  const p = started ? progress : null
  const pct = p ? (p.phase === 'copying' && p.bytesTotal ? (p.bytesDone ?? 0) / p.bytesTotal : p.total ? p.done / p.total : 0) : 0

  return (
    <Backdrop onClose={() => (!running || !started) && close()}>
      <div className="sheet">
        <h2>Import</h2>
        {!p ? (
          <>
            <p className="lead">
              Bring in a folder (including every sub-folder) or pick individual photos and videos. Companion files are merged the way an iPhone stores them:
              Live Photo movies, Portrait renders, edited versions and their <code>.AAE</code> edit recipes.
            </p>
            <div className="import-choices">
              <button className="import-choice" onClick={() => pick('folder')}>
                <span className="ic"><FolderInput size={20} /></span>
                <b>Import Folder…</b>
                <span>Scan a folder like your iPhone export, month by month.</span>
              </button>
              <button className="import-choice" onClick={() => pick('files')}>
                <span className="ic" style={{ background: '#30d158' }}><ImagePlus size={20} /></span>
                <b>Choose Photos & Videos…</b>
                <span>Select items; their Live, Portrait and edit companions come along.</span>
              </button>
            </div>
            {hasSources && (
              <>
                <div className="group-title">Selected</div>
                <div className="group-box">
                  {(sources.folders ?? []).map((f) => <div className="row" key={f}><div className="rl">{f}<small>Folder · all sub-folders</small></div></div>)}
                  {sources.files && <div className="row"><div className="rl">{sources.files.length.toLocaleString()} file{sources.files.length === 1 ? '' : 's'}<small>{sources.files[0]}{sources.files.length > 1 ? ' …' : ''}</small></div></div>}
                </div>
              </>
            )}
            <div className="group-title">Importing</div>
            <div className="group-box">
              <div className="row">
                <div className="rl">
                  Copy items to the Photos library
                  <small>
                    {copy
                      ? 'Originals are duplicated into the library byte-for-byte and verified with SHA-256. Your source folder stays untouched.'
                      : 'Photos stay where they are and are referenced in place. Nothing is ever written to the source folder.'}
                  </small>
                </div>
                <Switch on={copy} onChange={setCopy} />
              </div>
            </div>
            <div className="actions">
              <button className="btn" onClick={close}>Cancel</button>
              <button className="btn primary" disabled={!hasSources} onClick={start}>Import All</button>
            </div>
          </>
        ) : (
          <>
            <p className="lead" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {p.phase === 'done' ? <CheckCircle2 size={18} color="var(--green)" /> : p.phase === 'error' ? <AlertTriangle size={18} color="var(--red)" /> : null}
              {PHASE[p.phase]}
            </p>
            <div className={`progress${p.phase === 'scanning' ? ' indeterminate' : ''}`}>
              <div style={{ width: `${p.phase === 'done' ? 100 : Math.round(pct * 100)}%` }} />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)', minHeight: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.phase === 'scanning' && `${p.done.toLocaleString()} files found · ${p.current ?? ''}`}
              {p.phase === 'copying' && `${formatBytes(p.bytesDone ?? 0)} of ${formatBytes(p.bytesTotal ?? 0)} · ${p.current ?? ''}`}
              {(p.phase === 'adding' || p.phase === 'reading') && `${p.done.toLocaleString()} of ${p.total.toLocaleString()}${p.current ? ` · ${p.current}` : ''}`}
              {p.phase === 'error' && p.error}
              {p.phase === 'done' && 'Thumbnails continue rendering in the background — you can start browsing now.'}
            </div>
            <div className="stat-grid">
              <div><b>{p.added.toLocaleString()}</b><span>Added</span></div>
              <div><b>{p.skipped.toLocaleString()}</b><span>Already in Library</span></div>
              <div><b>{p.orphans.toLocaleString()}</b><span>Sidecars without a photo</span></div>
            </div>
            <div className="actions">
              {p.phase === 'done' || p.phase === 'error' ? (
                <button className="btn primary" onClick={() => { close(); refreshAll(); navigate('library', { view: 'all' }) }}>Done</button>
              ) : (
                <button className="btn" onClick={close}>Continue in Background</button>
              )}
            </div>
          </>
        )}
      </div>
    </Backdrop>
  )
}

function SettingsSheet() {
  const s = useStore((st) => st.settings)
  const [info, setInfo] = useState<{ libraryDir: string; version: string } | null>(null)
  useEffect(() => {
    api.info().then(setInfo)
  }, [])
  if (!s) return null
  const Row = ({ label, sub, k }: { label: string; sub?: string; k: keyof typeof s }) => (
    <div className="row">
      <div className="rl">{label}{sub && <small>{sub}</small>}</div>
      <Switch on={!!s[k]} onChange={(v) => updateSettings({ [k]: v })} />
    </div>
  )
  return (
    <Backdrop>
      <div className="sheet" style={{ width: 600 }}>
        <h2>Settings</h2>
        <p className="lead">Photos {info?.version ?? ''}</p>

        <div className="group-title">Appearance</div>
        <div className="group-box">
          <div className="row">
            <div className="rl">Appearance</div>
            <Segmented
              small
              value={s.appearance}
              onChange={(v) => updateSettings({ appearance: v })}
              options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Auto' }]}
            />
          </div>
          <Row label="Reduce Transparency" sub="Use solid backgrounds instead of glass." k="reduceTransparency" />
        </div>

        <div className="group-title">Library</div>
        <div className="group-box">
          <Row label="Square Thumbnails" sub="Off shows the full aspect ratio of each photo." k="squareThumbs" />
          <Row label="Show Live Photo & Video Badges" k="showLiveBadges" />
          <Row label="Lock Hidden Album" sub={`Requires ${api.platform === 'darwin' ? 'Touch ID' : 'Windows Hello'} to view hidden items. Locks again when you leave.`} k="hiddenLocked" />
          <Row label="Confirm Before Deleting" sub="Asks before moving items to Recently Deleted." k="confirmDelete" />
        </div>

        <div className="group-title">Playback</div>
        <div className="group-box">
          <Row label="Autoplay Live Photos" sub="Play the motion when you hover in the grid or open a Live Photo." k="autoplayLive" />
          <Row label="Autoplay Videos" k="autoplayVideos" />
        </div>

        <div className="group-title">Importing</div>
        <div className="group-box">
          <Row label="Copy items to the Photos library" sub="When off, photos are referenced where they are and never modified." k="copyOnImport" />
        </div>

        <div className="group-title">Library Location</div>
        <div className="group-box">
          <div className="row">
            <div className="rl" style={{ wordBreak: 'break-all' }}>{info?.libraryDir}<small>Database, thumbnails and copied originals live here.</small></div>
            <button className="btn" onClick={() => info && api.openPath(info.libraryDir)}>Open</button>
          </div>
        </div>
        <div className="actions">
          <button className="btn" style={{ marginRight: 'auto' }} onClick={() => setState({ sheet: { kind: 'shortcuts' } })}>Keyboard Shortcuts…</button>
          <button className="btn primary" onClick={close}>Done</button>
        </div>
      </div>
    </Backdrop>
  )
}

function PromptSheet({ sheet }: { sheet: Extract<Sheet, { kind: 'prompt' }> }) {
  const [v, setV] = useState(sheet.initial ?? '')
  const submit = () => {
    if (!v.trim()) return
    close()
    sheet.onSubmit(v.trim())
  }
  return (
    <Backdrop>
      <div className="sheet" style={{ width: 400 }}>
        <h2>{sheet.title}</h2>
        <input
          className="text-input"
          autoFocus
          placeholder={sheet.placeholder}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') close()
          }}
          style={{ marginTop: 12 }}
        />
        <div className="actions">
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" disabled={!v.trim()} onClick={submit}>{sheet.confirm}</button>
        </div>
      </div>
    </Backdrop>
  )
}

function ConfirmSheet({ sheet }: { sheet: Extract<Sheet, { kind: 'confirm' }> }) {
  const cancel = () => {
    close()
    sheet.onCancel?.()
  }
  const ok = () => {
    close()
    sheet.onConfirm()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  return (
    <Backdrop onClose={cancel}>
      <div className="alert">
        <div className={`alert-ic${sheet.danger ? ' danger' : ''}`}>{sheet.icon ?? (sheet.danger ? <Trash2 size={22} /> : <AlertTriangle size={22} />)}</div>
        <h3>{sheet.title}</h3>
        <p>{sheet.message}</p>
        <div className="alert-actions">
          <button className="btn" onClick={cancel}>Cancel</button>
          <button className={`btn ${sheet.danger ? 'danger' : 'primary'}`} autoFocus onClick={ok}>{sheet.confirm}</button>
        </div>
      </div>
    </Backdrop>
  )
}

const PHOTO_KINDS: { v: PhotoFormat; label: string }[] = [
  { v: 'jpeg', label: 'JPEG' }, { v: 'heic', label: 'HEIC' }, { v: 'png', label: 'PNG' }, { v: 'tiff', label: 'TIFF' },
  { v: 'avif', label: 'AVIF' }, { v: 'webp', label: 'WebP' }
]
const VIDEO_KINDS: { v: VideoFormat; label: string }[] = [
  { v: 'original', label: 'Original (as is)' }, { v: 'h264', label: 'MP4 · H.264 (Most Compatible)' }, { v: 'hevc', label: 'MP4 · HEVC' },
  { v: 'mov', label: 'MOV · HEVC' }, { v: 'webm', label: 'WebM · VP9' }, { v: 'gif', label: 'Animated GIF' }
]
const SIZES: { v: ExportOptions['size']; label: string }[] = [
  { v: 'full', label: 'Full Size' }, { v: 'large', label: 'Large (2048 px)' }, { v: 'medium', label: 'Medium (1280 px)' },
  { v: 'small', label: 'Small (640 px)' }, { v: 'custom', label: 'Custom…' }
]
const VQ: { v: ExportOptions['videoQuality']; label: string }[] = [
  { v: 'original', label: 'Original' }, { v: '2160', label: '4K' }, { v: '1080', label: '1080p' }, { v: '720', label: '720p' }, { v: '480', label: '480p' }
]

const DEFAULT_EXPORT: ExportOptions = {
  unmodified: false, photoFormat: 'jpeg', quality: 92, size: 'full', maxDim: 3000, colorProfile: 'p3', includeMetadata: true,
  videoFormat: 'original', videoQuality: 'original', includeLive: false, fileName: 'file', prefix: 'Photo', subfolder: 'none'
}

function Pick<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <button
      className="pick"
      onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), options.map((o) => ({ label: o.label, checked: o.v === value, onClick: () => onChange(o.v) })), 'right')}
    >
      {options.find((o) => o.v === value)?.label}
      <ChevronDown size={13} />
    </button>
  )
}

function ExportSheet({ sheet }: { sheet: Extract<Sheet, { kind: 'export' }> }) {
  const assets = useStore((s) => s.assets)
  const [o, setO] = useState<ExportOptions>(() => {
    try {
      return { ...DEFAULT_EXPORT, ...JSON.parse(localStorage.getItem('exportOptions') ?? '{}'), unmodified: !!sheet.unmodified }
    } catch {
      return { ...DEFAULT_EXPORT, unmodified: !!sheet.unmodified }
    }
  })
  const [prog, setProg] = useState<ExportProgress | null>(null)
  const set = (p: Partial<ExportOptions>) => setO((x) => ({ ...x, ...p }))
  const list = assets.filter((a) => sheet.ids.includes(a.id))
  const videos = list.filter((a) => a.video).length
  const photos = sheet.ids.length - videos
  const lives = list.filter((a) => a.live).length
  const noun = videos && photos ? 'Items' : videos ? (videos === 1 ? 'Video' : 'Videos') : photos === 1 ? 'Photo' : 'Photos'
  const lossy = ['jpeg', 'webp', 'avif'].includes(o.photoFormat)

  useEffect(() => api.on('export:progress', setProg), [])

  const run = async () => {
    localStorage.setItem('exportOptions', JSON.stringify({ ...o, unmodified: undefined }))
    setProg({ done: 0, total: sheet.ids.length, files: 0, bytes: 0 })
    const r = (await api.runExport(sheet.ids, o)) as (ExportProgress & { dir?: string }) | null
    close()
    if (!r) return
    const skipped = r.skipped?.length ? ` · ${r.skipped.length} note${r.skipped.length === 1 ? '' : 's'}` : ''
    toast(`Exported ${r.files.toLocaleString()} file${r.files === 1 ? '' : 's'} · ${formatBytes(r.bytes)}${skipped}`, r.dir ? { label: 'Show', run: () => api.openPath(r.dir!) } : undefined)
    if (r.skipped?.length) console.warn(r.skipped.join('\n'))
  }

  return (
    <Backdrop onClose={() => !prog && close()}>
      <div className="sheet export-sheet">
        <h2>{o.unmodified ? `Export Unmodified Original${sheet.ids.length === 1 ? '' : 's'}` : `Export ${sheet.ids.length.toLocaleString()} ${noun}`}</h2>
        {prog ? (
          <>
            <p className="lead">{prog.current ? `Exporting ${prog.current}…` : 'Choose a destination…'}</p>
            <div className="progress"><div style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} /></div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>
              {prog.done.toLocaleString()} of {prog.total.toLocaleString()} · {formatBytes(prog.bytes)}
            </div>
          </>
        ) : (
          <>
            <div className="seg-wide">
              <Segmented
                small
                value={o.unmodified ? 'orig' : 'conv'}
                onChange={(v) => set({ unmodified: v === 'orig' })}
                options={[{ value: 'conv', label: 'Current Version' }, { value: 'orig', label: 'Unmodified Original' }]}
              />
            </div>
            {o.unmodified ? (
              <p className="lead" style={{ marginTop: 14 }}>
                Copies every file exactly as it is on disk — the original, the iPhone’s edited render, Live Photo movie and
                <code> .AAE</code> sidecars — byte-for-byte, with all metadata and location intact.
              </p>
            ) : (
              <>
                {photos > 0 && (
                  <>
                    <div className="group-title">Photos</div>
                    <div className="group-box">
                      <div className="row"><div className="rl">Photo Kind</div><Pick value={o.photoFormat} options={PHOTO_KINDS} onChange={(v) => set({ photoFormat: v })} /></div>
                      {o.photoFormat === 'heic' && (
                        <div className="row"><div className="rl"><small>HEIC can only be copied as-is; edited or resized photos are written as JPEG instead.</small></div></div>
                      )}
                      {lossy && (
                        <div className="row">
                          <div className="rl">Quality</div>
                          <Segmented
                            small
                            value={String(o.quality)}
                            onChange={(v) => set({ quality: Number(v) })}
                            options={[{ value: '60', label: 'Low' }, { value: '78', label: 'Medium' }, { value: '92', label: 'High' }, { value: '98', label: 'Maximum' }]}
                          />
                        </div>
                      )}
                      <div className="row">
                        <div className="rl">Size</div>
                        {o.size === 'custom' && (
                          <input className="text-input" style={{ width: 90, height: 28 }} type="number" min={64} value={o.maxDim} onChange={(e) => set({ maxDim: Number(e.target.value) || 3000 })} />
                        )}
                        <Pick value={o.size} options={SIZES} onChange={(v) => set({ size: v })} />
                      </div>
                      <div className="row">
                        <div className="rl">Color Profile<small>{o.colorProfile === 'srgb' ? 'Best for the web and older devices.' : 'Keeps the wide colour of iPhone photos.'}</small></div>
                        <Segmented small value={o.colorProfile} onChange={(v) => set({ colorProfile: v })} options={[{ value: 'p3', label: 'Display P3' }, { value: 'srgb', label: 'sRGB' }]} />
                      </div>
                      <div className="row">
                        <div className="rl">Include Metadata<small>Camera, lens, date and caption. Unchanged full-size files keep everything, including location.</small></div>
                        <Switch on={o.includeMetadata} onChange={(v) => set({ includeMetadata: v })} />
                      </div>
                      {lives > 0 && (
                        <div className="row">
                          <div className="rl">Include Live Photo Motion<small>Also saves the movie of {lives.toLocaleString()} Live Photo{lives === 1 ? '' : 's'}.</small></div>
                          <Switch on={o.includeLive} onChange={(v) => set({ includeLive: v })} />
                        </div>
                      )}
                    </div>
                  </>
                )}
                {(videos > 0 || (o.includeLive && lives > 0)) && (
                  <>
                    <div className="group-title">Videos</div>
                    <div className="group-box">
                      <div className="row"><div className="rl">Movie Format</div><Pick value={o.videoFormat} options={VIDEO_KINDS} onChange={(v) => set({ videoFormat: v })} /></div>
                      {o.videoFormat !== 'original' && (
                        <div className="row"><div className="rl">Movie Quality</div><Pick value={o.videoQuality} options={VQ} onChange={(v) => set({ videoQuality: v })} /></div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
            <div className="group-title">Files</div>
            <div className="group-box">
              <div className="row">
                <div className="rl">File Name</div>
                {o.fileName === 'sequential' && (
                  <input className="text-input" style={{ width: 120, height: 28 }} value={o.prefix} onChange={(e) => set({ prefix: e.target.value })} />
                )}
                <Pick
                  value={o.fileName}
                  options={[{ v: 'file', label: 'Use File Name' }, { v: 'title', label: 'Use Title' }, { v: 'sequential', label: 'Sequential' }]}
                  onChange={(v) => set({ fileName: v })}
                />
              </div>
              <div className="row">
                <div className="rl">Subfolder Format</div>
                <Pick value={o.subfolder} options={[{ v: 'none', label: 'None' }, { v: 'day', label: 'Day (YYYY-MM-DD)' }]} onChange={(v) => set({ subfolder: v })} />
              </div>
            </div>
            <div className="actions">
              <button className="btn" onClick={close}>Cancel</button>
              <button className="btn primary" onClick={run}>Export…</button>
            </div>
          </>
        )}
      </div>
    </Backdrop>
  )
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['Library', [
    [`${mod}1 – ${mod}4`, 'Years · Months · Days · All Photos'], [`${mod}Shift+S`, 'Select'], ['Space / Enter', 'Open photo'], [`${mod}A`, 'Select all'],
    ['Shift-click · Ctrl-click', 'Range · add to selection'], [`${mod}+ / ${mod}-`, 'Zoom grid'], ['Home · End', 'Glide to top · newest'],
    ['Middle-click', 'Continuous scrolling'], [`${mod}F`, 'Search'], [`${mod}Alt+S`, 'Show or hide the sidebar']
  ]],
  ['Photo', [
    ['← →', 'Previous · next'], ['.', 'Favourite'], [`${mod}E · Enter`, 'Edit'], [`${mod}I`, 'Info'], [`${mod}R`, 'Rotate'], [`${mod}L`, 'Hide'],
    ['Del', 'Delete'], ['M (hold)', 'Show original'], ['H · click', 'Hide controls'], ['F', 'Full screen'], ['Esc', 'Back']
  ]],
  ['Video', [['Space · K', 'Play / pause'], ['J · L', 'Back / forward 10 s'], ['Shift+← →', '5 s'], ['↑ ↓', 'Volume'], ['M', 'Mute'], ['P', 'Picture in Picture']]],
  ['Editor', [['A · F · C · V', 'Adjust · Filters · Crop · Video'], ['E', 'Auto Enhance'], ['M (hold)', 'Compare'], [`${mod}Z · ${mod}Shift+Z`, 'Undo · redo'], ['Enter · Esc', 'Done · cancel']]],
  ['Export', [[`${mod}Shift+E`, 'Export'], [`${mod}Alt+Shift+E`, 'Export unmodified original']]]
]

function ShortcutsSheet() {
  return (
    <Backdrop>
      <div className="sheet" style={{ width: 720 }}>
        <h2>Keyboard Shortcuts</h2>
        <div className="shortcut-cols">
          {SHORTCUTS.map(([title, rows]) => (
            <div key={title}>
              <div className="group-title">{title}</div>
              <div className="group-box">
                {rows.map(([k, v]) => (
                  <div className="row" key={k} style={{ minHeight: 34, padding: '7px 12px' }}>
                    <div className="rl">{v}</div>
                    <kbd>{k}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="actions"><button className="btn primary" onClick={close}>Done</button></div>
      </div>
    </Backdrop>
  )
}

export function SheetLayer() {
  const sheet = useStore((s) => s.sheet)
  if (!sheet) return null
  if (sheet.kind === 'import') return <ImportSheet sheet={sheet} />
  if (sheet.kind === 'settings') return <SettingsSheet />
  if (sheet.kind === 'confirm') return <ConfirmSheet sheet={sheet} />
  if (sheet.kind === 'export') return <ExportSheet sheet={sheet} />
  if (sheet.kind === 'shortcuts') return <ShortcutsSheet />
  return <PromptSheet sheet={sheet} />
}
