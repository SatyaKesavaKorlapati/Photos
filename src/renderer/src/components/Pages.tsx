import { useEffect, useState } from 'react'
import { Folder, Images, Plus, Lock, Download, ChevronLeft } from 'lucide-react'
import { api, thumbUrl } from '../api'
import { albumMenu, promptNewAlbum } from '../actions'
import { navigate, refreshAll, setState, useStore } from '../store'
import type { Album } from '../types'
import { formatDay, plural } from '../util'
import { openMenu } from './Menu'
import { PhotosFlower } from './Icons'
import { startPick } from './TitleBar'

export function AlbumsPage() {
  const albums = useStore((s) => s.albums)
  const parent = useStore((s) => s.albumParent)
  const list = albums.filter((a) => (a.parentId ?? null) === parent)
  const folder = albums.find((a) => a.id === parent)
  const open = (a: Album) => {
    if (a.isFolder) setState({ albumParent: a.id })
    else navigate(`album:${a.id}`)
  }
  return (
    <div className="scroller">
      <div className="page">
        {folder && (
          <button className="back-pill glass" style={{ marginBottom: 12 }} onClick={() => setState({ albumParent: folder.parentId ?? null })}>
            <ChevronLeft size={16} /> Back
          </button>
        )}
        <h1>{folder?.name ?? 'Albums'}</h1>
        <p className="lead">{plural(list.length, 'item')}</p>
        <div className="album-grid">
          <button className="album-tile" onClick={() => promptNewAlbum([], false, parent)}>
            <div className="cover" style={{ border: '1.5px dashed var(--text-3)', boxShadow: 'none', background: 'transparent' }}>
              <Plus size={30} />
            </div>
            <b>New Album</b>
            <span>&nbsp;</span>
          </button>
          {list.map((a) => (
            <button
              key={a.id}
              className="album-tile"
              onClick={() => open(a)}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(e, albumMenu(a.id, !!a.isFolder, () => {
                  setState({
                    sheet: {
                      kind: 'prompt', title: 'Rename', placeholder: 'Name', confirm: 'Rename', initial: a.name,
                      onSubmit: async (name) => {
                        await window.api.renameAlbum(a.id, name)
                        refreshAll()
                      }
                    }
                  })
                }))
              }}
            >
              <div className="cover">
                {a.isFolder ? <Folder size={46} /> : a.coverId ? <img src={thumbUrl(a.coverId)} loading="lazy" /> : <Images size={36} />}
              </div>
              <b>{a.name}</b>
              <span>{a.isFolder ? `${albums.filter((x) => x.parentId === a.id).length} items` : a.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ImportsPage() {
  const imports = useStore((s) => s.imports)
  return (
    <div className="scroller">
      <div className="page">
        <h1>Imports</h1>
        <p className="lead">Every import session, newest first.</p>
        {!imports.length && <p style={{ color: 'var(--text-2)' }}>Nothing imported yet.</p>}
        <div className="group-box">
          {imports.map((i) => (
            <button key={i.id} className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`import:${i.id}`)}>
              <Download size={16} style={{ color: 'var(--accent-2)' }} />
              <div className="rl">
                {formatDay(i.started_at)} · {plural(i.count, 'item')}
                <small>{i.source} · {i.mode === 'copy' ? 'Copied into library' : 'Referenced in place'}</small>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function EmptyLibrary() {
  return (
    <div className="empty">
      <div>
        <PhotosFlower size={96} />
        <h2>Your library is empty</h2>
        <p>Import a folder from your iPhone or pick photos and videos. Live Photos, Portrait renders and edits are merged automatically.</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => startPick('folder')}>Import Folder…</button>
          <button className="btn" onClick={() => startPick('files')}>Choose Photos…</button>
        </div>
      </div>
    </div>
  )
}

const systemLockName = api.platform === 'darwin' ? 'Touch ID' : 'Windows Hello'

/** Asks the OS (Windows Hello / Touch ID) to verify the user; falls back to a click when no system lock exists. */
export async function unlockHidden(): Promise<boolean> {
  const r = await api.authVerify('Photos wants to show your Hidden album.')
  if (r === 'ok' || r === 'unavailable') {
    setState({ hiddenUnlocked: true })
    return true
  }
  return false
}

export function HiddenLock() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    api.authAvailable().then(setAvailable)
  }, [])
  const go = async () => {
    setBusy(true)
    setFailed(false)
    const ok = await unlockHidden()
    setBusy(false)
    if (!ok) setFailed(true)
  }
  return (
    <div className="hidden-lock">
      <div>
        <div className={`lock-ic glass${failed ? ' shake' : ''}`} key={String(failed)}><Lock size={30} /></div>
        <h2 style={{ margin: '0 0 6px', fontFamily: 'var(--font-display)' }}>Hidden Album is Locked</h2>
        <p style={{ color: 'var(--text-2)', margin: '0 0 16px', maxWidth: 380 }}>
          {available === false
            ? `Set up ${systemLockName} in your system settings to protect this album. Until then it opens with a click.`
            : `Use ${systemLockName} to view this album. It locks again when you leave it.`}
        </p>
        <button className="btn primary" disabled={busy} onClick={go}>
          {busy ? 'Waiting for verification…' : available === false ? 'View Album' : `Unlock with ${systemLockName}`}
        </button>
        {failed && <p style={{ color: 'var(--red)', fontSize: 12, marginTop: 10 }}>Verification was cancelled.</p>}
      </div>
    </div>
  )
}
