import { useEffect, useState } from 'react'
import { X, MapPin, ShieldCheck, FolderOpen, Wand2, Film } from 'lucide-react'
import { api, fileManager, isMac } from '../api'
import { setState } from '../store'
import type { AssetDetail } from '../types'
import { exposureLabel, formatBytes, formatDayLong, formatDuration, formatTime } from '../util'
import { LiveIcon, PortraitIcon } from './Icons'

const detailCache = new Map<number, AssetDetail>()

export function useDetail(id: number | null, version = 0): AssetDetail | null {
  const [d, setD] = useState<AssetDetail | null>(id !== null ? detailCache.get(id) ?? null : null)
  useEffect(() => {
    if (id === null) return setD(null)
    let live = true
    setD(detailCache.get(id) ?? null)
    api.detail(id).then((r) => {
      if (!live || !r) return
      detailCache.set(id, r)
      setD(r)
    })
    return () => {
      live = false
    }
  }, [id, version])
  return d
}

export function invalidateDetail(id: number): void {
  detailCache.delete(id)
}

function tileFor(lat: number, lon: number, z: number) {
  const n = 2 ** z
  const x = ((lon + 180) / 360) * n
  const r = (lat * Math.PI) / 180
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
  return { x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) }
}

function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const z = 13
  const t = tileFor(lat, lon, z)
  const tiles = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => ({ dx, dy })))
  const px = 256 + t.fx * 256
  const py = 256 + t.fy * 256
  return (
    <div style={{ position: 'relative', height: 140, overflow: 'hidden', background: '#2a2d33' }}>
      <div style={{ position: 'absolute', left: `calc(50% - ${px}px)`, top: 70 - py, width: 768, height: 768 }}>
        {tiles.map(({ dx, dy }) => (
          <img
            key={`${dx}${dy}`}
            src={`https://tile.openstreetmap.org/${z}/${t.x + dx}/${t.y + dy}.png`}
            style={{ position: 'absolute', left: (dx + 1) * 256, top: (dy + 1) * 256, width: 256, height: 256, filter: 'saturate(0.85)' }}
            draggable={false}
          />
        ))}
      </div>
      <div style={{ position: 'absolute', left: '50%', top: 70, transform: 'translate(-50%,-100%)', color: '#ff453a', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.4))' }}>
        <MapPin size={26} fill="#ff453a" stroke="#fff" strokeWidth={1.5} />
      </div>
    </div>
  )
}

function QualityTags({ d }: { d: AssetDetail }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {d.quality.map((q) => (
        <span key={q} className={`qtag${q === 'HDR' ? ' hdr' : q === 'Dolby Vision' ? ' dv' : q === 'ProRAW' || q === '4K' || q === '48 MP' ? ' accent' : ''}`}>{q}</span>
      ))}
    </div>
  )
}

export function InfoPanel({ id, onClose }: { id: number; onClose?: () => void }) {
  const [v, setV] = useState(0)
  const d = useDetail(id, v)
  const [title, setTitle] = useState('')
  const [caption, setCaption] = useState('')
  const [keywords, setKeywords] = useState('')
  useEffect(() => {
    setTitle(d?.title ?? '')
    setCaption(d?.caption ?? '')
    setKeywords(d?.keywords ?? '')
  }, [d?.id])
  if (!d) return <div className="info-panel glass-strong" />

  const save = (field: 'title' | 'caption' | 'keywords', value: string) => {
    api.setText(d.id, field, value).then(() => {
      invalidateDetail(d.id)
      setV((x) => x + 1)
    })
  }
  const t = d.tech ?? {}
  const vt = t.video
  const exif = [
    d.iso ? `ISO ${d.iso}` : '—',
    d.focal35 ? `${Math.round(d.focal35)} mm` : d.focal ? `${+d.focal.toFixed(2)} mm` : '—',
    d.ev !== null && d.ev !== undefined ? `${d.ev > 0 ? '+' : ''}${+d.ev.toFixed(1)} ev` : '0 ev',
    d.fnumber ? `ƒ${+d.fnumber.toFixed(2)}` : '—',
    exposureLabel(d.exposure) ?? '—'
  ]
  const mapsUrl = d.lat !== null && d.lon !== null
    ? isMac ? `https://maps.apple.com/?ll=${d.lat},${d.lon}&q=Photo` : `https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lon}`
    : null

  return (
    <div className="info-panel glass-strong" onMouseDown={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{formatDayLong(d.taken_at)}</h3>
          <div className="sub">{formatTime(d.taken_at)}{d.tz ? ` · GMT${d.tz}` : ''}</div>
        </div>
        <button className="circle-btn" style={{ width: 26, height: 26 }} onClick={onClose ?? (() => setState({ infoOpen: false }))}>
          <X size={14} />
        </button>
      </div>

      <input className="field" placeholder="Add a Title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => save('title', title)} />
      <input className="field" placeholder="Add a Caption" value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={() => save('caption', caption)} />
      <input className="field" placeholder="Add Keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} onBlur={() => save('keywords', keywords)} />

      <div className="info-card">
        <div className="ih">
          <b>{d.model ?? (d.kind === 'video' ? 'Video' : 'No Camera Information')}</b>
          <span className="format-pill">{t.format ?? d.name.split('.').pop()?.toUpperCase()}</span>
        </div>
        <div className="ib">
          {t.lensShort && <div className="line">{t.lensShort}{d.fnumber ? ` ƒ${+d.fnumber.toFixed(2)}` : ''}</div>}
          {d.lens && t.lensShort !== d.lens && <div>{d.lens}</div>}
          <div>
            {d.kind === 'photo'
              ? `${t.megapixels ?? '—'} MP · ${d.width ?? '?'} × ${d.height ?? '?'} · ${formatBytes(d.size_original)}`
              : `${vt?.width ?? d.width ?? '?'} × ${vt?.height ?? d.height ?? '?'} · ${formatBytes(d.size_original)} · ${formatDuration(d.duration ?? 0)}`}
          </div>
          {vt && (
            <div>
              {[vt.codec, vt.profile, vt.fps ? `${vt.fps} fps` : null, vt.bitrate ? `${(vt.bitrate / 1e6).toFixed(1)} Mbps` : null, vt.hdr].filter(Boolean).join(' · ')}
              {vt.audio && <div>Audio: {vt.audio}</div>}
            </div>
          )}
          {d.software && <div>Software {d.software}</div>}
          <div style={{ marginTop: 8 }}><QualityTags d={d} /></div>
        </div>
        {d.kind === 'photo' && <div className="exif">{exif.map((x, i) => <div key={i}>{x}</div>)}</div>}
      </div>

      {(d.subtypes.includes('live') || d.subtypes.includes('portrait') || d.edits?.items.length) && (
        <div className="info-card">
          <div className="ih"><b>Effects & Edits</b><Wand2 size={14} style={{ color: 'var(--text-3)' }} /></div>
          <div className="ib">
            {d.subtypes.includes('live') && (
              <div className="line" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <LiveIcon size={14} /> Live Photo
                {t.live?.duration ? ` · ${t.live.duration.toFixed(1)} s` : ''}
                {t.live?.codec ? ` · ${t.live.codec}` : ''}
                {t.contentIdMatch ? <span className="verify" style={{ marginLeft: 'auto' }}><ShieldCheck size={12} /> Paired</span> : null}
              </div>
            )}
            {d.subtypes.includes('portrait') && (
              <div className="line" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <PortraitIcon size={14} /> Portrait
                {d.edits?.portrait?.lighting ? ` · ${d.edits.portrait.lighting}` : ''}
                {d.edits?.portrait?.aperture ? ` · ƒ${d.edits.portrait.aperture.toFixed(1)}` : ''}
              </div>
            )}
            {d.edits?.items
              .filter((i) => i.id !== 'DepthEffect' && i.id !== 'PortraitEffect')
              .map((i, k) => (
                <div key={k}>
                  <span className="line">{i.label}</span>
                  {i.detail ? ` · ${i.detail}` : ''}
                </div>
              ))}
            {d.edits?.timestamp && <div style={{ marginTop: 4, color: 'var(--text-3)' }}>Edited {new Date(d.edits.timestamp).toLocaleString()}</div>}
          </div>
        </div>
      )}

      {d.lat !== null && d.lon !== null && (
        <div className="info-card">
          <MiniMap lat={d.lat} lon={d.lon} />
          <div className="ih" style={{ borderBottom: 0, borderTop: '1px solid var(--separator)' }}>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
              {d.lat.toFixed(5)}, {d.lon.toFixed(5)}{d.alt ? ` · ${Math.round(d.alt)} m` : ''}
            </span>
            {mapsUrl && <a href={mapsUrl} target="_blank" style={{ color: 'var(--accent-2)', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>Open in Maps</a>}
          </div>
        </div>
      )}

      <div className="info-card">
        <div className="ih">
          <b>Files</b>
          {d.copied && d.sha256 ? (
            <span className="verify" title={`SHA-256 ${d.sha256}`}><ShieldCheck size={12} /> Verified copy</span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Referenced in place</span>
          )}
        </div>
        {d.files.map((f) => (
          <div className="file-row" key={f.path}>
            {f.ext === 'MOV' || f.ext === 'MP4' ? <Film size={14} style={{ color: 'var(--text-3)' }} /> : <span className="format-pill" style={{ fontSize: 9 }}>{f.ext}</span>}
            <div className="fn">
              <div title={f.path}>{f.name}</div>
              <div>{f.role} · {f.missing ? 'Missing' : formatBytes(f.size)}</div>
            </div>
            <button title={`Show in ${fileManager}`} onClick={() => api.showInFolder(f.path)}><FolderOpen size={14} /></button>
          </div>
        ))}
        <div className="file-row" style={{ color: 'var(--text-3)', fontSize: 11 }}>
          {formatBytes(d.size_total)} total · originals are never modified
        </div>
      </div>

      {d.albums.length > 0 && (
        <div className="info-card">
          <div className="ih"><b>Albums</b></div>
          <div className="ib">{d.albums.map((a) => a.name).join(', ')}</div>
        </div>
      )}
    </div>
  )
}

export { QualityTags }
