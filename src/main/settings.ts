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
  confirmDelete: true
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
