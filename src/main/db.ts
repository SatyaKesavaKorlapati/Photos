import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type DB = DatabaseSync

let db: DatabaseSync | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  group_key TEXT NOT NULL UNIQUE,
  dir TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_path TEXT NOT NULL,
  edited_path TEXT,
  live_path TEXT,
  live_edited_path TEXT,
  aae_path TEXT,
  sidecars TEXT NOT NULL DEFAULT '[]',
  size_original INTEGER NOT NULL DEFAULT 0,
  size_total INTEGER NOT NULL DEFAULT 0,
  width INTEGER, height INTEGER, duration REAL,
  taken_at INTEGER NOT NULL DEFAULT 0,
  tz TEXT,
  mtime INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL DEFAULT 0,
  import_id INTEGER,
  make TEXT, model TEXT, lens TEXT, software TEXT,
  iso INTEGER, fnumber REAL, exposure REAL, focal REAL, focal35 REAL, ev REAL, flash INTEGER,
  lat REAL, lon REAL, alt REAL,
  subtypes TEXT NOT NULL DEFAULT '',
  live_style TEXT,
  content_id TEXT,
  edits TEXT,
  quality TEXT,
  tech TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  rotation INTEGER NOT NULL DEFAULT 0,
  title TEXT, caption TEXT, keywords TEXT,
  ai_caption TEXT, ai_tags TEXT,
  meta_done INTEGER NOT NULL DEFAULT 0,
  thumb_done INTEGER NOT NULL DEFAULT 0,
  copied INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_taken ON assets(taken_at);
CREATE INDEX IF NOT EXISTS idx_assets_meta ON assets(meta_done);
CREATE INDEX IF NOT EXISTS idx_assets_thumb ON assets(thumb_done);
CREATE INDEX IF NOT EXISTS idx_assets_dir ON assets(dir);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  added INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER,
  is_folder INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS album_assets (
  album_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, asset_id)
);
`

export function openDb(libraryDir: string): DatabaseSync {
  mkdirSync(libraryDir, { recursive: true })
  db = new DatabaseSync(join(libraryDir, 'photos.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  const cols = new Set((db.prepare('PRAGMA table_info(assets)').all() as { name: string }[]).map((c) => c.name))
  // In-app edits: the recipe, its rendered still/movie, and the Live Photo motion render. Originals are never touched.
  for (const [name, type] of [['user_edits', 'TEXT'], ['user_render', 'TEXT'], ['user_live_render', 'TEXT'], ['user_edit_at', 'INTEGER']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${type}`)
  }
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('database not open')
  return db
}

export function tx<T>(fn: () => T): T {
  const d = getDb()
  d.exec('BEGIN')
  try {
    const r = fn()
    d.exec('COMMIT')
    return r
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}
