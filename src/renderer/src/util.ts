import type { GridAsset } from './types'

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3))
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const dayKey = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const monthKey = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
export const yearKey = (t: number): string => String(new Date(t).getFullYear())

export interface Group {
  key: string
  start: number
  end: number
  items: GridAsset[]
  index: number
}

export function groupBy(items: GridAsset[], keyFn: (t: number) => string): Group[] {
  const out: Group[] = []
  let cur: Group | null = null
  items.forEach((a, i) => {
    const k = keyFn(a.t)
    if (!cur || cur.key !== k) {
      cur = { key: k, start: a.t, end: a.t, items: [], index: i }
      out.push(cur)
    }
    cur.items.push(a)
    cur.end = a.t
  })
  return out
}

export const formatDayLong = (t: number): string => {
  const d = new Date(t)
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export const formatDay = (t: number): string => {
  const d = new Date(t)
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`
}

export const formatTime = (t: number): string =>
  new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export const formatMonth = (t: number): string => {
  const d = new Date(t)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Apple-style range label for the visible part of a grid. */
export function rangeLabel(a: number, b: number): { title: string; subtitle?: string } {
  const da = new Date(Math.min(a, b))
  const db = new Date(Math.max(a, b))
  const sameYear = da.getFullYear() === db.getFullYear()
  const sameMonth = sameYear && da.getMonth() === db.getMonth()
  if (sameMonth && da.getDate() === db.getDate()) return { title: `${da.getDate()} ${MONTHS[da.getMonth()]} ${da.getFullYear()}`, subtitle: WEEKDAYS[da.getDay()] }
  if (sameMonth) return { title: `${da.getDate()}–${db.getDate()} ${MONTHS_SHORT[da.getMonth()]} ${da.getFullYear()}` }
  if (sameYear) return { title: `${MONTHS_SHORT[da.getMonth()]} – ${MONTHS_SHORT[db.getMonth()]} ${da.getFullYear()}` }
  return { title: `${MONTHS_SHORT[da.getMonth()]} ${da.getFullYear()} – ${MONTHS_SHORT[db.getMonth()]} ${db.getFullYear()}` }
}

export const formatDuration = (s: number): string => {
  if (!s || !isFinite(s)) return '0:00'
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export const formatBytes = (n: number): string => {
  if (!n) return '0 KB'
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1000)))
  const v = n / 1000 ** i
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`
}

export const plural = (n: number, one: string, many = one + 's'): string => `${n.toLocaleString()} ${n === 1 ? one : many}`

export function countLabel(items: GridAsset[]): string {
  let p = 0
  let v = 0
  for (const a of items) a.video ? v++ : p++
  if (p && v) return `${plural(p, 'Photo')}, ${plural(v, 'Video')}`
  if (v) return plural(v, 'Video')
  return plural(p, 'Photo')
}

/** Picks a representative cover: favourites first, then non-screenshots from the middle of the group. */
export function pickCover(items: GridAsset[], seed = 0): GridAsset {
  const fav = items.filter((a) => a.fav && !a.video)
  if (fav.length) return fav[seed % fav.length]
  const good = items.filter((a) => !a.video && !a.sub.includes('screenshot') && a.w && a.h)
  const pool = good.length ? good : items
  return pool[Math.floor(pool.length / 2 + seed) % pool.length]
}

export const exposureLabel = (e?: number | null): string | undefined => {
  if (!e) return undefined
  if (e >= 1) return `${+e.toFixed(1)} s`
  return `1/${Math.round(1 / e)} s`
}

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
