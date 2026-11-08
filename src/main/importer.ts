import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { getDb, tx } from './db'
import { extractMeta, type AssetRowForMeta } from './meta'
import { groupFiles, walk, withCompanions, type AssetGroup, type ScannedFile } from './scan'

export interface ImportProgress {
  importId: number
  phase: 'scanning' | 'copying' | 'adding' | 'reading' | 'done' | 'error'
  done: number
  total: number
  current?: string
  added: number
  skipped: number
  orphans: number
  bytesDone?: number
  bytesTotal?: number
  error?: string
}

type Emit = (p: ImportProgress) => void

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject)
  })
  return h.digest('hex')
}

/** Byte-for-byte copy, timestamps preserved, verified by size and SHA-256. */
async function verifiedCopy(src: string, dest: string): Promise<string> {
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
  const s = await stat(src)
  await utimes(dest, s.atime, s.mtime)
  const [a, b] = await Promise.all([sha256(src), sha256(dest)])
  if (a !== b || (await stat(dest)).size !== s.size) throw new Error(`copy verification failed for ${basename(src)}`)
  return a
}

const filesOf = (g: AssetGroup): ScannedFile[] =>
  [g.original, g.edited, g.live, g.liveEdited, g.aae, ...g.sidecars].filter(Boolean) as ScannedFile[]

let running: Promise<void> | null = null

export function isImporting(): boolean {
  return running !== null
}

export async function runImport(
  sources: { folders?: string[]; files?: string[] },
  opts: { copy: boolean; libraryDir: string },
  emit: Emit
): Promise<number> {
  const db = getDb()
  const label = [...(sources.folders ?? []), ...(sources.files ?? []).slice(0, 1)].join('; ') || 'Import'
  const importId = Number(
    db.prepare('INSERT INTO imports (source, mode, started_at) VALUES (?, ?, ?)').run(label, opts.copy ? 'copy' : 'reference', Date.now()).lastInsertRowid
  )
  const state: ImportProgress = { importId, phase: 'scanning', done: 0, total: 0, added: 0, skipped: 0, orphans: 0 }
  const send = (patch: Partial<ImportProgress>): void => {
    Object.assign(state, patch)
    emit({ ...state })
  }

  const job = (async () => {
    try {
      const scanned: ScannedFile[] = []
      let lastEmit = 0
      for (const folder of sources.folders ?? []) {
        await walk(folder, scanned, (d) => {
          if (Date.now() - lastEmit > 150) {
            lastEmit = Date.now()
            send({ current: d, done: scanned.length })
          }
        })
      }
      if (sources.files?.length) scanned.push(...(await withCompanions(sources.files)))
      const seen = new Set<string>()
      const unique = scanned.filter((f) => (seen.has(f.path.toLowerCase()) ? false : (seen.add(f.path.toLowerCase()), true)))
      const { groups, orphans } = groupFiles(unique)
      send({ orphans: orphans.length, total: groups.length, done: 0 })

      const existing = new Set(
        (db.prepare('SELECT original_path FROM assets').all() as { original_path: string }[]).map((r) => r.original_path.toLowerCase())
      )
      const fresh = groups.filter((g) => !existing.has(g.original.path.toLowerCase()))
      const skipped = groups.length - fresh.length

      const hashes = new Map<AssetGroup, string>()
      if (opts.copy && fresh.length) {
        const bytesTotal = fresh.reduce((n, g) => n + filesOf(g).reduce((m, f) => m + f.size, 0), 0)
        let bytesDone = 0
        send({ phase: 'copying', total: fresh.length, done: 0, bytesTotal, bytesDone: 0 })
        const destRoot = join(opts.libraryDir, 'Originals', String(importId))
        const baseOf = (p: string): string => {
          const root = (sources.folders ?? []).find((f) => p.toLowerCase().startsWith(f.toLowerCase()))
          return root ? relative(dirname(root), p) : basename(p)
        }
        for (let i = 0; i < fresh.length; i++) {
          const g = fresh[i]
          const remap = new Map<string, string>()
          for (const f of filesOf(g)) {
            const dest = join(destRoot, baseOf(f.path))
            const h = await verifiedCopy(f.path, dest)
            if (f === g.original) hashes.set(g, h)
            remap.set(f.path, dest)
            bytesDone += f.size
          }
          const swap = (f?: ScannedFile): ScannedFile | undefined => (f ? { ...f, path: remap.get(f.path) ?? f.path } : f)
          g.original = swap(g.original)!
          g.edited = swap(g.edited)
          g.live = swap(g.live)
          g.liveEdited = swap(g.liveEdited)
          g.aae = swap(g.aae)
          g.sidecars = g.sidecars.map((f) => swap(f)!)
          g.dir = dirname(g.original.path)
          g.key = `${g.dir.toLowerCase()}|${g.key.split('|')[1]}`
          send({ done: i + 1, bytesDone, current: g.name })
        }
      }

      send({ phase: 'adding', total: fresh.length, done: 0, skipped })
      const ins = db.prepare(`INSERT OR IGNORE INTO assets
        (group_key, dir, name, kind, original_path, edited_path, live_path, live_edited_path, aae_path, sidecars,
         size_original, size_total, taken_at, mtime, imported_at, import_id, copied, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      let added = 0
      const now = Date.now()
      for (let i = 0; i < fresh.length; i += 500) {
        tx(() => {
          for (const g of fresh.slice(i, i + 500)) {
            const total = filesOf(g).reduce((n, f) => n + f.size, 0)
            const r = ins.run(
              g.key, g.dir, g.name, g.kind, g.original.path, g.edited?.path ?? null, g.live?.path ?? null, g.liveEdited?.path ?? null,
              g.aae?.path ?? null, JSON.stringify(g.sidecars.map((f) => f.path)), g.original.size, total, g.original.mtime,
              g.original.mtime, now, importId, opts.copy ? 1 : 0, hashes.get(g) ?? null
            )
            if (r.changes) added++
          }
        })
        send({ done: Math.min(fresh.length, i + 500), added })
      }
      db.prepare('UPDATE imports SET added = ?, skipped = ? WHERE id = ?').run(added, skipped, importId)

      await processMetadata((done, total, current) => send({ phase: 'reading', done, total, current }))
      db.prepare('UPDATE imports SET finished_at = ? WHERE id = ?').run(Date.now(), importId)
      send({ phase: 'done', current: undefined })
    } catch (e) {
      send({ phase: 'error', error: (e as Error).message })
    }
  })()
  running = job.finally(() => (running = null))
  return importId
}

let metaRunning: Promise<void> | null = null

/** Reads EXIF / QuickTime / AAE for every asset not yet processed. Safe to call repeatedly. */
export function processMetadata(onProgress?: (done: number, total: number, current?: string) => void): Promise<void> {
  if (metaRunning) return metaRunning
  metaRunning = (async () => {
    const db = getDb()
    const upd = db.prepare(`UPDATE assets SET width=?, height=?, duration=?, taken_at=?, tz=?, make=?, model=?, lens=?, software=?,
      iso=?, fnumber=?, exposure=?, focal=?, focal35=?, ev=?, flash=?, lat=?, lon=?, alt=?, subtypes=?, live_style=?, content_id=?,
      edits=?, quality=?, tech=?, meta_done=1 WHERE id=?`)
    const splitStmt = db.prepare('UPDATE assets SET live_path = NULL, live_edited_path = NULL WHERE id = ?')
    const insVideo = db.prepare(`INSERT OR IGNORE INTO assets (group_key, dir, name, kind, original_path, edited_path, sidecars,
      size_original, size_total, taken_at, mtime, imported_at, import_id, copied)
      SELECT group_key || '|video', dir, ?, 'video', ?, ?, '[]', 0, 0, taken_at, mtime, imported_at, import_id, copied FROM assets WHERE id = ?`)
    const n = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null)
    for (;;) {
    const rows = db
      .prepare('SELECT id, kind, dir, original_path, edited_path, live_path, live_edited_path, aae_path, mtime FROM assets WHERE meta_done = 0')
      .all() as unknown as AssetRowForMeta[]
    if (!rows.length) break
    let done = 0
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < rows.length) {
        const row = rows[i++]
        try {
          const m = await extractMeta(row)
          if (m.splitLive && row.live_path) {
            splitStmt.run(row.id)
            insVideo.run(basename(row.live_path), row.live_path, row.live_edited_path, row.id)
          }
          upd.run(
            n(m.width), n(m.height), n(m.duration), m.taken_at, m.tz ?? null, m.make ?? null, m.model ?? null, m.lens ?? null,
            m.software ?? null, n(m.iso), n(m.fnumber), n(m.exposure), n(m.focal), n(m.focal35), n(m.ev), n(m.flash), n(m.lat), n(m.lon),
            n(m.alt), m.subtypes.join(','), m.live_style ?? null, m.content_id ?? null, m.edits ? JSON.stringify(m.edits) : null,
            JSON.stringify(m.quality), JSON.stringify(m.tech), row.id
          )
        } catch {
          db.prepare('UPDATE assets SET meta_done = 2 WHERE id = ?').run(row.id)
        }
        done++
        if (done % 10 === 0 || done === rows.length) onProgress?.(done, rows.length, basename(row.original_path))
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
    }
  })().finally(() => {
    metaRunning = null
  })
  return metaRunning
}

export function waitForImport(): Promise<void> {
  return running ?? Promise.resolve()
}
