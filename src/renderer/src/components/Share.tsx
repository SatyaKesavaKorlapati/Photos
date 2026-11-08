import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, Download, FolderOpen, Images, Link2, Plus, Settings2, Share, Play, AppWindow, Send } from 'lucide-react'
import blipIcon from '../assets/blip.png'
import whatsappIcon from '../assets/whatsapp.png'
import { api, thumbUrl } from '../api'
import { albumSubmenu, exportAssets, slideshow } from '../actions'
import { getState, setState, toast, updateSettings, useStore } from '../store'
import type { ShareDestination } from '../types'
import { plural } from '../util'
import { Segmented, Switch } from './Controls'
import { openMenu } from './Menu'

/** Opens the share sheet for these items, anchored under the button that was clicked. */
export function openShare(ids: number[], from?: Element | DOMRect | null): void {
  if (!ids.length) return
  const r = from instanceof Element ? from.getBoundingClientRect() : from
  const anchor = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: window.innerWidth / 2, y: 60, w: 0, h: 0 }
  setState({ share: { ids, anchor }, menu: null })
}

const close = () => setState({ share: null })

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'
const HUES = [212, 145, 280, 25, 330, 190, 48]
const hue = (s: string) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length]

function AppIcon({ d }: { d: ShareDestination }) {
  if (d.kind === 'whatsapp') return <img src={whatsappIcon} draggable={false} alt="" />
  if (d.kind === 'blip' && !d.peer) return <img src={blipIcon} draggable={false} alt="" />
  if (d.icon) return <img src={d.icon} draggable={false} alt="" />
  switch (d.kind) {
    case 'system': return <span className="sh-glyph system"><Share size={24} /></span>
    case 'blip': return <span className="sh-glyph blip"><Send size={22} /></span>
    case 'clipboard': return <span className="sh-glyph copy"><Copy size={22} /></span>
    case 'folder': return <span className="sh-glyph folder"><FolderOpen size={24} /></span>
    default: return <span className="sh-glyph"><AppWindow size={24} /></span>
  }
}

export function ShareLayer() {
  const share = useStore((s) => s.share)
  const settings = useStore((s) => s.settings)
  const assets = useStore((s) => s.assets)
  const [dests, setDests] = useState<ShareDestination[] | null>(null)
  const [options, setOptions] = useState(false)
  const [busy, setBusy] = useState<{ title: string; p: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null)

  useEffect(() => {
    if (!share) return
    setDests(null)
    setOptions(false)
    setBusy(null)
    api.shareDestinations().then(setDests)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (!getState().menu) close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [share])

  useEffect(() => api.on('share:progress', (p) => setBusy((b) => (b ? { ...b, p } : b))), [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!share || !el) return
    const a = share.anchor
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = a.x + a.w / 2 - w / 2
    left = Math.max(10, Math.min(window.innerWidth - w - 10, left))
    let top = a.y + a.h + 8
    if (top + h > window.innerHeight - 10) top = Math.max(10, a.y - h - 8)
    setPos({ left, top, origin: `${a.x + a.w / 2 - left}px ${top > a.y ? 0 : h}px` })
  }, [share, dests, options, busy])

  if (!share || !settings) return null
  const ids = share.ids
  const list = assets.filter((a) => ids.includes(a.id))
  const videos = list.filter((a) => a.video).length
  const lives = list.filter((a) => a.live).length
  const noun = videos === ids.length ? plural(ids.length, 'Video') : videos ? plural(ids.length, 'Item') : plural(ids.length, 'Photo')
  const people = (dests ?? []).filter((d) => d.peer)
  const apps = (dests ?? []).filter((d) => !d.peer)

  const run = async (d: ShareDestination) => {
    setBusy({ title: d.peer ? `Sending to ${d.peer}…` : `Preparing for ${d.title}…`, p: 0 })
    const r = await api.share(ids, d.id, noun)
    close()
    if (r.message) toast(r.message)
    else if (!r.ok) toast('Couldn’t share')
  }

  return (
    <div className="share-layer" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div
        ref={ref}
        className="share-sheet glass-strong"
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, transformOrigin: pos?.origin }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sh-head">
          <div className="sh-stack">
            {ids.slice(0, 3).reverse().map((id, i, arr) => (
              <img key={id} src={thumbUrl(id)} style={{ transform: `rotate(${(arr.length - 1 - i) * -6}deg) translate(${(arr.length - 1 - i) * -3}px, 0)` }} draggable={false} />
            ))}
          </div>
          <div className="sh-title">
            <b>{ids.length === 1 ? (list[0]?.name ?? noun) : `${noun} Selected`}</b>
            <button className="sh-opts" onClick={() => setOptions(!options)}>
              Options <ChevronRight size={12} className={options ? 'open' : ''} />
            </button>
          </div>
        </div>

        {options && (
          <div className="sh-options">
            <div className="row">
              <div className="rl">Send As</div>
              <Segmented
                small
                value={settings.shareFormat}
                onChange={(v) => updateSettings({ shareFormat: v })}
                options={[{ value: 'compatible', label: 'Most Compatible' }, { value: 'original', label: 'Current' }]}
              />
            </div>
            <div className="row sub">
              {settings.shareFormat === 'compatible'
                ? 'HEIC becomes JPEG and HDR/HEVC video becomes H.264 so it opens anywhere, including WhatsApp.'
                : 'Sends the files as they are (HEIC, HEVC), with every detail and the location intact.'}
            </div>
            {lives > 0 && (
              <div className="row">
                <div className="rl">Include Live Photo Motion</div>
                <Switch on={settings.shareIncludeLive} onChange={(v) => updateSettings({ shareIncludeLive: v })} />
              </div>
            )}
            {settings.shareFormat === 'compatible' && (
              <div className="row">
                <div className="rl">Include Camera Details</div>
                <Switch on={settings.shareIncludeMetadata} onChange={(v) => updateSettings({ shareIncludeMetadata: v })} />
              </div>
            )}
          </div>
        )}

        {busy ? (
          <div className="sh-busy">
            <span>{busy.title}</span>
            <div className="progress"><div style={{ width: `${Math.round(busy.p * 100)}%` }} /></div>
          </div>
        ) : (
          <>
            {people.length > 0 && (
              <div className="sh-row people">
                {people.map((d) => (
                  <button key={d.id} className="sh-target" onClick={() => run(d)} title={`Send with Blip to ${d.title}`}>
                    <span className="sh-avatar" style={{ ['--h' as string]: hue(d.title) }}>
                      {d.icon ? <img src={d.icon} draggable={false} /> : initials(d.title)}
                      <span className="sh-badge"><Send size={9} /></span>
                    </span>
                    <span className="sh-name">{d.title}</span>
                    <span className="sh-sub">Blip</span>
                  </button>
                ))}
              </div>
            )}
            <div className="sh-row apps">
              {!dests && <div className="sh-loading">Finding connections…</div>}
              {apps.map((d) => (
                <button key={d.id} className="sh-target" onClick={() => run(d)} title={d.subtitle}>
                  <span className="sh-app"><AppIcon d={d} /></span>
                  <span className="sh-name">{d.title}</span>
                </button>
              ))}
              <button className="sh-target" onClick={() => { close(); setState({ sheet: { kind: 'connections' } }) }} title="Add or manage share connections">
                <span className="sh-app more"><Plus size={22} /></span>
                <span className="sh-name">Connect</span>
              </button>
            </div>
            <div className="sh-actions">
              {ids.length === 1 && !videos && (
                <button onClick={() => { close(); api.copyImage(ids[0]).then(() => toast('Photo copied')) }}>
                  <span>Copy Photo</span><Copy size={16} />
                </button>
              )}
              <button onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), albumSubmenu(ids).map((m) => ({ ...m, onClick: m.onClick && (() => { close(); m.onClick!() }) })), 'right')}>
                <span>Add to Album</span><Images size={16} />
              </button>
              <button onClick={() => { close(); slideshow(ids.length > 1 ? ids : getState().assets.map((a) => a.id).slice(Math.max(0, getState().assets.findIndex((a) => a.id === ids[0])))) }}>
                <span>Play Slideshow</span><Play size={16} />
              </button>
              <button onClick={() => { close(); exportAssets(ids, 'current') }}>
                <span>Export…</span><Download size={16} />
              </button>
              <button onClick={() => { close(); setState({ sheet: { kind: 'connections' } }) }}>
                <span>Edit Connections…</span><Settings2 size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  system: 'Built in', blip: 'Detected app', whatsapp: 'Built in', clipboard: 'Built in', app: 'App', folder: 'Folder'
}

/** Share connections: built-ins can be turned off; apps and folders can be added for future targets. */
export function ConnectionsSheet() {
  const [list, setList] = useState<import('../types').ShareConnection[] | null>(null)
  useEffect(() => {
    api.shareConnections().then(setList)
  }, [])
  const save = (next: typeof list) => {
    if (!next) return
    setList(next)
    api.saveShareConnections(next).then(setList)
  }
  const add = async (kind: 'app' | 'folder') => {
    const path = await api.pickShareTarget(kind)
    if (!path || !list) return
    const name = path.split(/[\\/]/).pop()!.replace(/\.(exe|lnk|bat|cmd|app)$/i, '')
    save([...list, { id: `${kind}:${Date.now()}`, kind, name, enabled: true, path, args: kind === 'app' ? '{files}' : undefined }])
  }
  const move = (i: number, d: number) => {
    if (!list) return
    const next = [...list]
    const [x] = next.splice(i, 1)
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, x)
    save(next)
  }
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setState({ sheet: null })}>
      <div className="sheet" style={{ width: 560 }}>
        <h2>Share Connections</h2>
        <p className="lead">
          Choose what appears in the Share sheet. Blip recipients come from the Blip app; the Windows share sheet reaches
          Nearby Share, Phone Link, Mail and any installed app that accepts photos. Add an app or a folder (OneDrive, a phone sync folder) to
          connect more destinations.
        </p>
        <div className="group-box">
          {(list ?? []).map((c, i) => (
            <div className="row" key={c.id}>
              <div className="rl">
                {c.kind === 'app' || c.kind === 'folder' ? (
                  <input className="inline-edit" value={c.name} onChange={(e) => save(list!.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))} />
                ) : c.name}
                <small>{KIND_LABEL[c.kind]}{c.path ? ` · ${c.path}` : ''}</small>
                {c.kind === 'app' && (
                  <label className="args">
                    Arguments
                    <input className="text-input" value={c.args ?? '{files}'} onChange={(e) => save(list!.map((x) => (x.id === c.id ? { ...x, args: e.target.value } : x)))} />
                  </label>
                )}
              </div>
              <button className="tb-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="tb-btn" title="Move down" disabled={i === list!.length - 1} onClick={() => move(i, 1)}>↓</button>
              {(c.kind === 'app' || c.kind === 'folder') && (
                <button className="tb-btn" title="Remove" onClick={() => save(list!.filter((x) => x.id !== c.id))}>✕</button>
              )}
              <Switch on={c.enabled} onChange={(v) => save(list!.map((x) => (x.id === c.id ? { ...x, enabled: v } : x)))} />
            </div>
          ))}
        </div>
        <div className="actions">
          <button className="btn" onClick={() => add('app')}><AppWindow size={14} style={{ verticalAlign: -2 }} /> Add App…</button>
          <button className="btn" style={{ marginRight: 'auto' }} onClick={() => add('folder')}><Link2 size={14} style={{ verticalAlign: -2 }} /> Add Folder…</button>
          <button className="btn primary" onClick={() => setState({ sheet: null })}>Done</button>
        </div>
      </div>
    </div>
  )
}
