import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { previewUrl, thumbUrl } from '../api'
import { getState, setState, useStore } from '../store'
import type { GridAsset, LibraryView } from '../types'
import { countLabel, dayKey, groupBy, monthKey, MONTHS, MONTHS_SHORT, pickCover, WEEKDAYS, yearKey, type Group } from '../util'

function CardImg({ id, big }: { id: number; big?: boolean }) {
  const [ok, setOk] = useState(false)
  return <img src={big ? previewUrl(id) : thumbUrl(id)} loading="lazy" decoding="async" style={{ opacity: ok ? 1 : 0 }} onLoad={() => setOk(true)} draggable={false} />
}

function YearCard({ g, onClick }: { g: Group; onClick: () => void }) {
  const picks = useMemo(() => {
    const months = groupBy(g.items, monthKey)
    const sorted = [...months].sort((a, b) => b.items.length - a.items.length).slice(0, 3)
    return sorted.map((m, i) => pickCover(m.items, i))
  }, [g])
  return (
    <div className="card year" style={{ aspectRatio: '16 / 9' }} onClick={onClick} data-key={g.key}>
      {picks.length >= 3 ? (
        <div className="mosaic">
          {picks.map((p, i) => (
            <div key={p.id}><CardImg id={p.id} big={i === 0} /></div>
          ))}
        </div>
      ) : (
        <CardImg id={picks[0]?.id ?? g.items[0].id} big />
      )}
      <div className="shade" />
      <div className="ct">{g.key}</div>
      <div className="cs">{countLabel(g.items)}</div>
    </div>
  )
}

function MonthCard({ g, onClick }: { g: Group; onClick: () => void }) {
  const d = new Date(g.start)
  const cover = useMemo(() => pickCover(g.items), [g])
  return (
    <div className="card" style={{ aspectRatio: '16 / 10.5' }} onClick={onClick} data-key={g.key}>
      <CardImg id={cover.id} />
      <div className="shade" />
      <div className="ct">{MONTHS[d.getMonth()]} {d.getFullYear()}</div>
      <div className="cs">{countLabel(g.items)}</div>
    </div>
  )
}

function DayCard({ g, onClick }: { g: Group; onClick: () => void }) {
  const d = new Date(g.start)
  const cover = useMemo(() => pickCover(g.items), [g])
  return (
    <div className="card" style={{ aspectRatio: '16 / 10.5', contentVisibility: 'auto', containIntrinsicSize: '300px 200px' }} onClick={onClick} data-key={g.key}>
      <CardImg id={cover.id} />
      <div className="shade" />
      <div className="ct">{d.getDate()} {MONTHS_SHORT[d.getMonth()]} {d.getFullYear()}</div>
      <div className="cs">{WEEKDAYS[d.getDay()]} · {countLabel(g.items)}</div>
    </div>
  )
}

export function CardsView({ items, view }: { items: GridAsset[]; view: Exclude<LibraryView, 'all'> }) {
  const ref = useRef<HTMLDivElement>(null)
  const focusKey = useStore((s) => s.scrollTarget)
  const groups = useMemo(() => groupBy(items, view === 'years' ? yearKey : view === 'months' ? monthKey : dayKey), [items, view])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (focusKey !== null) {
      const a = items.find((x) => x.id === focusKey)
      const key = a ? (view === 'months' ? monthKey(a.t) : view === 'days' ? dayKey(a.t) : yearKey(a.t)) : null
      const target = key ? el.querySelector<HTMLElement>(`[data-key="${key}"]`) : null
      if (target) {
        el.scrollTop = target.offsetTop - 20
        setState({ scrollTarget: null })
        return
      }
    }
    el.scrollTop = el.scrollHeight
  }, [view, groups.length])

  const drill = (g: Group) => {
    if (view === 'years') {
      const firstOfYear = g.items[0]
      setState({ view: 'months', scrollTarget: firstOfYear.id })
    } else if (view === 'months') {
      setState({ view: 'days', scrollTarget: g.items[0].id })
    } else {
      setState({ view: 'all', scrollTarget: g.items[0].id })
    }
    const s = getState()
    if (s.settings) window.api.setSettings({ libraryView: s.view })
  }

  const min = view === 'years' ? 440 : view === 'months' ? 300 : 230
  return (
    <div ref={ref} className="scroller">
      <div className="cards" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
        {groups.map((g) =>
          view === 'years' ? (
            <YearCard key={g.key} g={g} onClick={() => drill(g)} />
          ) : view === 'months' ? (
            <MonthCard key={g.key} g={g} onClick={() => drill(g)} />
          ) : (
            <DayCard key={g.key} g={g} onClick={() => drill(g)} />
          )
        )}
      </div>
    </div>
  )
}
