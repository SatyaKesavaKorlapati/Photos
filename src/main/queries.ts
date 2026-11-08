import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { getDb, tx } from './db'

export interface GridAsset {
  id: number
  t: number
  w: number
  h: number
  video: boolean
  dur: number
  fav: boolean
  sub: string
  rot: number
  live: string | null
  edited: boolean
  hidden: boolean
  name: string
  /** Timestamp of the in-app edit render, used to bust cached thumbnails; 0 when unedited. */
  ev: number
}

const SUBTYPE_SOURCES = new Set([
  'selfie', 'live', 'portrait', 'panorama', 'screenshot', 'screenrec', 'raw', 'animated', 'slomo', 'cinematic',
  'longexposure', 'loop', 'bounce', 'burst', 'spatial', 'hdr', 'timelapse', 'edited'
])

const COLS = `id, taken_at AS t, COALESCE(width,0) AS w, COALESCE(height,0) AS h, kind, COALESCE(duration,0) AS dur, favorite,
  subtypes AS sub, rotation AS rot, live_style, edited_path, aae_path, hidden, name, user_edit_at, user_render, user_edits`

const editedDims = (r: any): { w: number; h: number } | null => {
  if (!r.user_render || !r.user_edits) return null
  try {
    const d = JSON.parse(r.user_edits).out as { w: number; h: number } | undefined
    return d?.w && d?.h ? d : null
  } catch {
    return null
  }
}

const toGrid = (r: any): GridAsset => {
  const d = editedDims(r)
  return {
    id: r.id, t: r.t, w: d?.w ?? r.w, h: d?.h ?? r.h, video: r.kind === 'video', dur: r.dur, fav: !!r.favorite, sub: r.sub ?? '',
    rot: r.rot ?? 0, live: (r.sub ?? '').includes('live') ? r.live_style ?? 'live' : null,
    edited: (r.sub ?? '').includes('edited') || !!r.user_render, hidden: !!r.hidden, name: r.name, ev: r.user_render ? r.user_edit_at ?? 0 : 0
  }
}

const LIVE = 'deleted_at IS NULL AND hidden = 0'
const hasSub = (s: string): string => `(',' || subtypes || ',') LIKE '%,${s},%'`

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

const SYNONYMS: Record<string, string> = {
  selfie: 'selfie', selfies: 'selfie', live: 'live', portrait: 'portrait', portraits: 'portrait', panorama: 'panorama',
  panoramas: 'panorama', pano: 'panorama', screenshot: 'screenshot', screenshots: 'screenshot', 'screen recording': 'screenrec',
  'screen recordings': 'screenrec', raw: 'raw', proraw: 'raw', gif: 'animated', gifs: 'animated', animated: 'animated',
  'slo-mo': 'slomo', slomo: 'slomo', 'slow motion': 'slomo', cinematic: 'cinematic', 'long exposure': 'longexposure',
  loop: 'loop', bounce: 'bounce', burst: 'burst', bursts: 'burst', spatial: 'spatial', hdr: 'hdr', edited: 'edited',
  'time-lapse': 'timelapse', timelapse: 'timelapse'
}

function searchWhere(q: string): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = []
  const clauses: string[] = []
  let text = q.toLowerCase().trim()
  for (const phrase of ['screen recordings', 'screen recording', 'slow motion', 'long exposure']) {
    if (text.includes(phrase)) {
      clauses.push(hasSub(SYNONYMS[phrase]))
      text = text.replace(phrase, ' ')
    }
  }
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (/^(19|20)\d{2}$/.test(tok)) {
      clauses.push(`strftime('%Y', taken_at / 1000, 'unixepoch', 'localtime') = ?`)
      params.push(tok)
      continue
    }
    const mi = MONTHS.findIndex((m) => tok.length >= 3 && m.startsWith(tok))
    if (mi >= 0) {
      clauses.push(`strftime('%m', taken_at / 1000, 'unixepoch', 'localtime') = ?`)
      params.push(String(mi + 1).padStart(2, '0'))
      continue
    }
    if (tok === 'video' || tok === 'videos') { clauses.push(`kind = 'video'`); continue }
    if (tok === 'photo' || tok === 'photos') { clauses.push(`kind = 'photo'`); continue }
    if (/^favou?rites?$|^fav$/.test(tok)) { clauses.push('favorite = 1'); continue }
    if (SYNONYMS[tok]) { clauses.push(hasSub(SYNONYMS[tok])); continue }
    if (tok === '4k') { clauses.push(`quality LIKE '%"4K"%'`); continue }
    const like = `%${tok}%`
    clauses.push(`(name LIKE ? OR dir LIKE ? OR model LIKE ? OR lens LIKE ? OR title LIKE ? OR caption LIKE ? OR keywords LIKE ?
      OR ai_caption LIKE ? OR ai_tags LIKE ? OR quality LIKE ? OR edits LIKE ?
      OR id IN (SELECT aa.asset_id FROM album_assets aa JOIN albums al ON al.id = aa.album_id WHERE al.name LIKE ?))`)
    params.push(like, like, like, like, like, like, like, like, like, like, like, like)
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', params }
}

export function listAssets(source: string): GridAsset[] {
  const db = getDb()
  let where = LIVE
  let params: (string | number)[] = []
  let order = 'taken_at ASC, id ASC'
  const [kind, ...rest] = source.split(':')
  const arg = rest.join(':')
  switch (kind) {
    case 'library': break
    case 'favorites': where += ' AND favorite = 1'; break
    case 'videos': where += ` AND kind = 'video'`; break
    case 'recent': where += ' AND imported_at > ?'; params = [Date.now() - 30 * 86400000]; order = 'imported_at ASC, taken_at ASC'; break
    case 'hidden': where = 'deleted_at IS NULL AND hidden = 1'; break
    case 'deleted': where = 'deleted_at IS NOT NULL'; order = 'deleted_at ASC'; break
    case 'duplicates':
      where += ` AND (size_original, taken_at) IN (SELECT size_original, taken_at FROM assets WHERE deleted_at IS NULL
        GROUP BY size_original, taken_at HAVING COUNT(*) > 1)`
      order = 'size_original, taken_at'
      break
    case 'album':
      where += ' AND id IN (SELECT asset_id FROM album_assets WHERE album_id = ?)'
      params = [Number(arg)]
      break
    case 'folder': where += ' AND dir = ?'; params = [arg]; break
    case 'import': where += ' AND import_id = ?'; params = [Number(arg)]; break
    case 'search': {
      const s = searchWhere(arg)
      where += ` AND ${s.sql}`
      params = s.params
      break
    }
    default:
      if (SUBTYPE_SOURCES.has(kind)) where += ` AND ${hasSub(kind)}`
  }
  return (db.prepare(`SELECT ${COLS} FROM assets WHERE ${where} ORDER BY ${order}`).all(...params) as any[]).map(toGrid)
}

export function sidebarCounts(): Record<string, number> {
  const db = getDb()
  const subs = [...SUBTYPE_SOURCES].map((s) => `SUM(CASE WHEN ${LIVE} AND ${hasSub(s)} THEN 1 ELSE 0 END) AS "${s}"`).join(', ')
  const row = db
    .prepare(`SELECT
      SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS library,
      SUM(CASE WHEN ${LIVE} AND kind = 'photo' THEN 1 ELSE 0 END) AS photos,
      SUM(CASE WHEN ${LIVE} AND kind = 'video' THEN 1 ELSE 0 END) AS videos,
      SUM(CASE WHEN ${LIVE} AND favorite = 1 THEN 1 ELSE 0 END) AS favorites,
      SUM(CASE WHEN ${LIVE} AND imported_at > ? THEN 1 ELSE 0 END) AS recent,
      SUM(CASE WHEN deleted_at IS NULL AND hidden = 1 THEN 1 ELSE 0 END) AS hidden,
      SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
      SUM(CASE WHEN meta_done = 0 THEN 1 ELSE 0 END) AS pendingMeta,
      SUM(CASE WHEN thumb_done = 0 THEN 1 ELSE 0 END) AS pendingThumbs,
      ${subs}
      FROM assets`)
    .get(Date.now() - 30 * 86400000) as Record<string, number | null>
  const dup = db
    .prepare(`SELECT COUNT(*) n FROM assets WHERE ${LIVE} AND (size_original, taken_at) IN (SELECT size_original, taken_at FROM assets
      WHERE deleted_at IS NULL GROUP BY size_original, taken_at HAVING COUNT(*) > 1)`)
    .get() as { n: number }
  const out: Record<string, number> = { duplicates: dup.n }
  for (const [k, v] of Object.entries(row)) out[k] = v ?? 0
  return out
}

export function assetDetail(id: number): Record<string, unknown> | undefined {
  const r = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, any> | undefined
  if (!r) return undefined
  const file = (path: string | null, role: string) => {
    if (!path) return null
    let size = 0
    let mtime = 0
    let missing = false
    try {
      const s = statSync(path)
      size = s.size
      mtime = s.mtimeMs
    } catch {
      missing = true
    }
    return { role, path, name: basename(path), ext: extname(path).slice(1).toUpperCase(), size, mtime, missing }
  }
  const sidecars: string[] = JSON.parse(r.sidecars || '[]')
  const files = [
    file(r.original_path, r.kind === 'video' ? 'Original Video' : 'Original'),
    file(r.edited_path, (r.subtypes ?? '').includes('portrait') ? 'Rendered Portrait' : r.kind === 'video' ? 'Edited Video' : 'Edited Version'),
    file(r.live_path, 'Live Photo Video'),
    file(r.live_edited_path, 'Edited Live Video'),
    file(r.aae_path, 'Adjustments (AAE)'),
    file(r.user_render, 'Edited in Photos'),
    file(r.user_live_render, 'Edited Live Video (Photos)'),
    ...sidecars.map((s) => file(s, /\.aae$/i.test(s) ? 'Original Adjustments (AAE)' : 'Sidecar'))
  ].filter(Boolean)
  const albums = getDb()
    .prepare('SELECT al.id, al.name FROM albums al JOIN album_assets aa ON aa.album_id = al.id WHERE aa.asset_id = ?')
    .all(id)
  return {
    ...r,
    edits: r.edits ? JSON.parse(r.edits) : null,
    user_edits: r.user_edits ? JSON.parse(r.user_edits) : null,
    quality: r.quality ? JSON.parse(r.quality) : [],
    tech: r.tech ? JSON.parse(r.tech) : {},
    subtypes: (r.subtypes ?? '').split(',').filter(Boolean),
    files,
    albums
  }
}

const inList = (ids: number[]): string => ids.map(() => '?').join(',')

export function updateAssets(ids: number[], patch: { favorite?: boolean; hidden?: boolean; deleted?: boolean; rotate?: number }): void {
  if (!ids.length) return
  const db = getDb()
  tx(() => {
    if (patch.favorite !== undefined) db.prepare(`UPDATE assets SET favorite = ? WHERE id IN (${inList(ids)})`).run(patch.favorite ? 1 : 0, ...ids)
    if (patch.hidden !== undefined) db.prepare(`UPDATE assets SET hidden = ? WHERE id IN (${inList(ids)})`).run(patch.hidden ? 1 : 0, ...ids)
    if (patch.deleted !== undefined)
      db.prepare(`UPDATE assets SET deleted_at = ? WHERE id IN (${inList(ids)})`).run(patch.deleted ? Date.now() : null, ...ids)
    if (patch.rotate) db.prepare(`UPDATE assets SET rotation = ((rotation + ?) % 360 + 360) % 360 WHERE id IN (${inList(ids)})`).run(patch.rotate, ...ids)
  })
}

export function setText(id: number, field: 'title' | 'caption' | 'keywords', value: string): void {
  getDb().prepare(`UPDATE assets SET ${field} = ? WHERE id = ?`).run(value || null, id)
}

/** Removes entries from the library index only. Files on disk are never touched. */
export function purgeAssets(ids: number[]): void {
  if (!ids.length) return
  const db = getDb()
  tx(() => {
    db.prepare(`DELETE FROM album_assets WHERE asset_id IN (${inList(ids)})`).run(...ids)
    db.prepare(`DELETE FROM assets WHERE id IN (${inList(ids)})`).run(...ids)
  })
}

export function listAlbums(): unknown[] {
  return getDb()
    .prepare(`SELECT al.id, al.name, al.parent_id AS parentId, al.is_folder AS isFolder, al.created_at AS createdAt,
      (SELECT COUNT(*) FROM album_assets aa JOIN assets a ON a.id = aa.asset_id WHERE aa.album_id = al.id AND a.deleted_at IS NULL) AS count,
      (SELECT a.id FROM album_assets aa JOIN assets a ON a.id = aa.asset_id WHERE aa.album_id = al.id AND a.deleted_at IS NULL
        ORDER BY a.taken_at DESC LIMIT 1) AS coverId
      FROM albums al ORDER BY al.is_folder DESC, al.sort, al.name COLLATE NOCASE`)
    .all()
}

export function createAlbum(name: string, parentId: number | null, isFolder: boolean, assetIds: number[] = []): number {
  const id = Number(
    getDb().prepare('INSERT INTO albums (name, parent_id, is_folder, created_at) VALUES (?, ?, ?, ?)').run(name, parentId, isFolder ? 1 : 0, Date.now()).lastInsertRowid
  )
  if (assetIds.length) addToAlbum(id, assetIds)
  return id
}

export function renameAlbum(id: number, name: string): void {
  getDb().prepare('UPDATE albums SET name = ? WHERE id = ?').run(name, id)
}

export function deleteAlbum(id: number): void {
  const db = getDb()
  tx(() => {
    const kids = db.prepare('SELECT id FROM albums WHERE parent_id = ?').all(id) as { id: number }[]
    for (const k of kids) db.prepare('UPDATE albums SET parent_id = (SELECT parent_id FROM albums WHERE id = ?) WHERE id = ?').run(id, k.id)
    db.prepare('DELETE FROM album_assets WHERE album_id = ?').run(id)
    db.prepare('DELETE FROM albums WHERE id = ?').run(id)
  })
}

export function moveAlbum(id: number, parentId: number | null): void {
  getDb().prepare('UPDATE albums SET parent_id = ? WHERE id = ?').run(parentId, id)
}

export function addToAlbum(albumId: number, ids: number[]): void {
  const st = getDb().prepare('INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?)')
  const now = Date.now()
  tx(() => ids.forEach((id) => st.run(albumId, id, now)))
}

export function removeFromAlbum(albumId: number, ids: number[]): void {
  getDb().prepare(`DELETE FROM album_assets WHERE album_id = ? AND asset_id IN (${inList(ids)})`).run(albumId, ...ids)
}

export function listFolders(): { dir: string; name: string; count: number; coverId: number }[] {
  return getDb()
    .prepare(`SELECT dir, COUNT(*) AS count, MAX(id) AS coverId FROM assets WHERE ${LIVE} GROUP BY dir ORDER BY dir`)
    .all()
    .map((r: any) => ({ ...r, name: basename(r.dir) }))
}

export function listImports(): unknown[] {
  return getDb()
    .prepare(`SELECT i.*, (SELECT COUNT(*) FROM assets a WHERE a.import_id = i.id AND a.deleted_at IS NULL) AS count FROM imports i
      WHERE i.added > 0 ORDER BY i.started_at DESC`)
    .all()
}

export function suggest(q: string): { kind: string; label: string; source: string; count: number }[] {
  const text = q.trim().toLowerCase()
  if (!text) return []
  const db = getDb()
  const out: { kind: string; label: string; source: string; count: number }[] = []
  const count = (src: string): number => listAssets(src).length
  const MEDIA: [string, string][] = [
    ['videos', 'Videos'], ['selfie', 'Selfies'], ['live', 'Live Photos'], ['portrait', 'Portrait'], ['panorama', 'Panoramas'],
    ['screenshot', 'Screenshots'], ['screenrec', 'Screen Recordings'], ['slomo', 'Slo-mo'], ['cinematic', 'Cinematic'],
    ['raw', 'RAW'], ['animated', 'Animated'], ['longexposure', 'Long Exposure'], ['favorites', 'Favourites'], ['edited', 'Edited']
  ]
  for (const [src, label] of MEDIA) {
    if (label.toLowerCase().startsWith(text) || src.startsWith(text)) {
      const n = count(src)
      if (n) out.push({ kind: 'Media Types', label, source: src, count: n })
    }
  }
  const mi = MONTHS.findIndex((m) => text.length >= 3 && m.startsWith(text.split(' ')[0]))
  if (mi >= 0 || /^(19|20)\d{0,2}$/.test(text)) {
    const rows = db
      .prepare(`SELECT strftime('%Y-%m', taken_at / 1000, 'unixepoch', 'localtime') AS ym, COUNT(*) n FROM assets WHERE ${LIVE}
        GROUP BY ym ORDER BY ym DESC`)
      .all() as { ym: string; n: number }[]
    for (const r of rows) {
      const [y, m] = r.ym.split('-')
      const label = `${MONTHS[+m - 1][0].toUpperCase()}${MONTHS[+m - 1].slice(1)} ${y}`
      if ((mi >= 0 && +m - 1 === mi) || (mi < 0 && y.startsWith(text))) out.push({ kind: 'Dates', label, source: `search:${MONTHS[+m - 1]} ${y}`, count: r.n })
      if (out.filter((o) => o.kind === 'Dates').length >= 6) break
    }
  }
  const albums = db.prepare(`SELECT id, name FROM albums WHERE is_folder = 0 AND name LIKE ? LIMIT 5`).all(`%${text}%`) as { id: number; name: string }[]
  for (const a of albums) out.push({ kind: 'Albums', label: a.name, source: `album:${a.id}`, count: count(`album:${a.id}`) })
  const cams = db.prepare(`SELECT model, COUNT(*) n FROM assets WHERE ${LIVE} AND model LIKE ? GROUP BY model ORDER BY n DESC LIMIT 4`).all(`%${text}%`) as { model: string; n: number }[]
  for (const c of cams) out.push({ kind: 'Cameras', label: c.model, source: `search:${c.model}`, count: c.n })
  const files = db.prepare(`SELECT COUNT(*) n FROM assets WHERE ${LIVE} AND name LIKE ?`).get(`%${text}%`) as { n: number }
  if (files.n) out.push({ kind: 'Files', label: `File names containing “${q.trim()}”`, source: `search:${q.trim()}`, count: files.n })
  return out
}
