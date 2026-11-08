import { useEffect, useMemo, useState } from 'react'
import { Play, Pause, Plus, X, ChevronLeft, ChevronRight, Heart } from 'lucide-react'
import { api, previewUrl } from '../api'
import { promptNewAlbum, toggleFavorite } from '../actions'
import { navigate, setState, useStore } from '../store'
import type { GridAsset } from '../types'
import { countLabel, dayKey, groupBy, MONTHS, monthKey, pickCover, WEEKDAYS } from '../util'
import { Segmented } from './Controls'

interface Memory {
  key: string
  over: string
  title: string
  text: string
  items: GridAsset[]
  cover: GridAsset
}

type Tab = 'memories' | 'featured' | 'recent' | 'onthisday'

function buildMemories(all: GridAsset[], tab: Tab): Memory[] {
  const photos = all.filter((a) => !a.sub.includes('screenshot') && !a.sub.includes('screenrec'))
  if (tab === 'memories') {
    return groupBy(photos, monthKey)
      .filter((g) => g.items.length >= 12)
      .sort((a, b) => b.start - a.start)
      .slice(0, 12)
      .map((g, i) => {
        const d = new Date(g.start)
        const live = g.items.filter((x) => x.live).length
        return {
          key: g.key,
          over: i === 0 ? 'Latest Memory' : `${d.getFullYear()}`,
          title: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
          text: `${countLabel(g.items)}${live ? ` · ${live} Live` : ''}. Relive ${MONTHS[d.getMonth()]} from start to finish — every moment you captured that month, played back as a memory.`,
          items: g.items,
          cover: pickCover(g.items, i)
        }
      })
  }
  if (tab === 'recent') {
    return groupBy(photos, dayKey)
      .sort((a, b) => b.start - a.start)
      .slice(0, 10)
      .map((g) => {
        const d = new Date(g.start)
        return {
          key: g.key,
          over: WEEKDAYS[d.getDay()],
          title: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
          text: `${countLabel(g.items)} from ${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
          items: g.items,
          cover: pickCover(g.items)
        }
      })
  }
  if (tab === 'onthisday') {
    const now = new Date()
    const groups = groupBy(
      photos.filter((a) => {
        const d = new Date(a.t)
        if (d.getFullYear() === now.getFullYear()) return false
        const doy = (x: Date) => Math.floor((Date.UTC(2001, x.getMonth(), x.getDate()) - Date.UTC(2001, 0, 1)) / 86400000)
        return Math.abs(doy(d) - doy(now)) <= 3
      }),
      (t) => String(new Date(t).getFullYear())
    )
    return groups
      .sort((a, b) => b.start - a.start)
      .map((g) => ({
        key: g.key,
        over: 'On This Day',
        title: `${now.getFullYear() - +g.key} Year${now.getFullYear() - +g.key === 1 ? '' : 's'} Ago`,
        text: `${countLabel(g.items)} from around ${now.getDate()} ${MONTHS[now.getMonth()]} ${g.key}.`,
        items: g.items,
        cover: pickCover(g.items)
      }))
  }
  const featured = photos.filter((a) => !a.video && (a.fav || a.sub.includes('portrait') || a.sub.includes('panorama') || a.live === 'loop' || a.sub.includes('longexposure')))
  const pool = featured.length >= 6 ? featured : photos.filter((a) => !a.video)
  const step = Math.max(1, Math.floor(pool.length / 10))
  return pool
    .filter((_, i) => i % step === 0)
    .slice(-10)
    .reverse()
    .map((a) => {
      const d = new Date(a.t)
      const kind = a.sub.includes('portrait') ? 'Portrait' : a.sub.includes('panorama') ? 'Panorama' : a.live ? 'Live Photo' : a.fav ? 'Favourite' : 'Featured Photo'
      return {
        key: String(a.id),
        over: kind,
        title: `${MONTHS[d.getMonth()]} ${d.getDate()}`,
        text: `${kind} from ${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
        items: [a],
        cover: a
      }
    })
}

export function Memories() {
  const [all, setAll] = useState<GridAsset[] | null>(null)
  const [tab, setTab] = useState<Tab>('memories')
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const version = useStore((s) => s.version)

  useEffect(() => {
    api.list('library').then(setAll)
  }, [version])

  const mems = useMemo(() => buildMemories(all ?? [], tab), [all, tab])
  useEffect(() => setIndex(0), [tab])
  useEffect(() => {
    if (paused || mems.length < 2) return
    const t = window.setInterval(() => setIndex((i) => (i + 1) % mems.length), 7000)
    return () => window.clearInterval(t)
  }, [paused, mems.length, index])

  useEffect(() => {
    const m = mems[index]
    if (m) document.documentElement.style.setProperty('--ambient-image', `url("${previewUrl(m.cover.id)}")`)
  }, [mems, index])

  const m = mems[index]
  return (
    <div className="hero">
      {mems.map((x, i) => (
        <div key={x.key} className={`slide${i === index ? ' on' : ''}`}>
          {Math.abs(i - index) <= 1 || (index === 0 && i === mems.length - 1) ? <img src={previewUrl(x.cover.id)} draggable={false} /> : null}
        </div>
      ))}
      <div className="shade" />
      {m ? (
        <>
          <div className="copy" key={m.key}>
            <div className="over">{m.over}</div>
            <h1>{m.title}</h1>
            <p>{m.text}</p>
            <div className="ctas">
              <button className="play" onClick={() => setState({ slideshow: { ids: m.items.filter((a) => !a.video).map((a) => a.id), title: m.title, subtitle: countLabel(m.items) } })}>
                <Play size={16} fill="currentColor" /> Play
              </button>
              <button className="ghost" onClick={() => promptNewAlbum(m.items.map((a) => a.id))}>
                <Plus size={16} /> Add to Album
              </button>
              {m.items.length === 1 && (
                <button className="ghost" onClick={() => toggleFavorite([m.cover.id]).then(() => api.list('library').then(setAll))}>
                  <Heart size={15} fill={m.cover.fav ? 'currentColor' : 'none'} /> {m.cover.fav ? 'Favourited' : 'Favourite'}
                </button>
              )}
              <button className="ghost" onClick={() => navigate('library', { view: 'all', scrollTo: m.items[0].id })}>
                Show in Library
              </button>
            </div>
          </div>
          <div className="ctrl">
            <button onClick={() => setIndex((index - 1 + mems.length) % mems.length)}><ChevronLeft size={15} /></button>
            <button onClick={() => setPaused(!paused)}>{paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}</button>
            <button onClick={() => setIndex((index + 1) % mems.length)}><ChevronRight size={15} /></button>
          </div>
          <div className="dots">
            {mems.map((x, i) => (
              <button key={x.key} className={i === index ? 'on' : ''} onClick={() => setIndex(i)} />
            ))}
          </div>
        </>
      ) : all && (
        <div className="empty"><div><h2>No memories yet</h2><p>Memories appear once your library has photos from several days.</p></div></div>
      )}
      <div className="seg-float">
        <Segmented<Tab>
          className="glass"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'memories', label: 'Memories' },
            { value: 'featured', label: 'Featured' },
            { value: 'recent', label: 'Recent Days' },
            { value: 'onthisday', label: 'On This Day' }
          ]}
        />
      </div>
    </div>
  )
}

export function Slideshow() {
  const show = useStore((s) => s.slideshow)
  const [i, setI] = useState(-1)
  const [paused, setPaused] = useState(false)
  const seconds = useStore((s) => s.settings?.slideshowSeconds ?? 3)
  useEffect(() => {
    setI(-1)
    const t = window.setTimeout(() => setI(0), 2200)
    return () => window.clearTimeout(t)
  }, [show])
  useEffect(() => {
    if (!show || paused || i < 0) return
    const t = window.setTimeout(() => setI((x) => (x + 1 >= show.ids.length ? x : x + 1)), (seconds + 1.2) * 1000)
    return () => window.clearTimeout(t)
  }, [i, paused, show, seconds])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!show) return
      if (e.key === 'Escape') setState({ slideshow: null })
      if (e.key === ' ') setPaused((p) => !p)
      if (e.key === 'ArrowRight') setI((x) => Math.min(show.ids.length - 1, x + 1))
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [show])
  if (!show) return null
  return (
    <div className="slideshow">
      {show.ids.map((id, k) =>
        Math.abs(k - i) <= 1 || (i < 0 && k === 0) ? (
          <div key={id} className={`s-img${k === Math.max(0, i) ? ' on' : ''}`}>
            <img src={previewUrl(id)} />
          </div>
        ) : null
      )}
      <div className="s-title" style={{ opacity: i < 1 ? 1 : 0 }}>
        <h1>{show.title}</h1>
        {show.subtitle && <p>{show.subtitle}</p>}
      </div>
      <div className="s-bar glass">
        <button className="circle-btn" onClick={() => setI((x) => Math.max(0, x - 1))}><ChevronLeft size={18} /></button>
        <button className="circle-btn" onClick={() => setPaused(!paused)}>{paused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}</button>
        <button className="circle-btn" onClick={() => setI((x) => Math.min(show.ids.length - 1, x + 1))}><ChevronRight size={18} /></button>
        <button className="circle-btn" onClick={() => setState({ slideshow: null })}><X size={18} /></button>
      </div>
    </div>
  )
}
