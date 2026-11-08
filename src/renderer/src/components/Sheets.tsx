import { useEffect, useState } from 'react'
import { FolderInput, ImagePlus, CheckCircle2, AlertTriangle } from 'lucide-react'
import { api } from '../api'
import { navigate, refreshAll, setState, updateSettings, useStore, type Sheet } from '../store'
import type { ImportProgress } from '../types'
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
          <Row label="Lock Hidden Album" sub="Requires a click to reveal hidden items." k="hiddenLocked" />
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
        <div className="actions"><button className="btn primary" onClick={close}>Done</button></div>
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

export function SheetLayer() {
  const sheet = useStore((s) => s.sheet)
  if (!sheet) return null
  if (sheet.kind === 'import') return <ImportSheet sheet={sheet} />
  if (sheet.kind === 'settings') return <SettingsSheet />
  return <PromptSheet sheet={sheet} />
}
