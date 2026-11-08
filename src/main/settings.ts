import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Settings {
  copyOnImport: boolean
  autoplayLive: boolean
  autoplayVideos: boolean
  squareThumbs: boolean
  showLiveBadges: boolean
  showInfoOverlays: boolean
  reduceTransparency: boolean
  appearance: 'dark' | 'light' | 'system'
  sidebarCollapsed: boolean
  zoom: number
  libraryView: 'years' | 'months' | 'days' | 'all'
  hiddenLocked: boolean
  confirmDelete: boolean
  // Sharing
  shareFormat: 'compatible' | 'original'
  shareMaxSize: 'full' | 'large'
  shareVideoQuality: 'original' | '1080' | '720'
  shareIncludeLive: boolean
  shareIncludeMetadata: boolean
  shareConnections?: import('./share').ShareConnection[]
  // Playback
  holdSpeed: number
  skipSeconds: number
  loopShortVideos: boolean
  rememberVolume: boolean
  volume: number
  slideshowSeconds: number
  // Advanced
  reduceMotion: boolean
  backgroundThumbs: boolean
  lastSource: string
  /** Double-click a thumbnail: open the viewer, or jump straight into Edit. */
  doubleClick: 'view' | 'edit'
}

export const DEFAULTS: Settings = {
  copyOnImport: false,
  autoplayLive: true,
  autoplayVideos: true,
  squareThumbs: true,
  showLiveBadges: true,
  showInfoOverlays: true,
  reduceTransparency: false,
  appearance: 'dark',
  sidebarCollapsed: false,
  zoom: 5,
  libraryView: 'all',
  hiddenLocked: true,
  confirmDelete: true,
  shareFormat: 'compatible',
  shareMaxSize: 'full',
  shareVideoQuality: '1080',
  shareIncludeLive: false,
  shareIncludeMetadata: true,
  holdSpeed: 2,
  skipSeconds: 10,
  loopShortVideos: false,
  rememberVolume: true,
  volume: 1,
  slideshowSeconds: 3,
  reduceMotion: false,
  backgroundThumbs: true,
  lastSource: 'library',
  doubleClick: 'view'
}

let file = ''
let current: Settings = { ...DEFAULTS }

export function loadSettings(dir: string): Settings {
  file = join(dir, 'settings.json')
  try {
    current = { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    current = { ...DEFAULTS }
  }
  return current
}

export function getSettings(): Settings {
  return current
}

export function setSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch }
  try {
    writeFileSync(file, JSON.stringify(current, null, 2))
  } catch { /* read-only location */ }
  return current
}

export function resetSettings(): Settings {
  const keep = { lastSource: current.lastSource, shareConnections: current.shareConnections }
  current = { ...DEFAULTS, ...keep }
  try {
    writeFileSync(file, JSON.stringify(current, null, 2))
  } catch { /* ignore */ }
  return current
}
