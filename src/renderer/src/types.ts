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
  ev: number
}

export type PhotoFormat = 'jpeg' | 'png' | 'tiff' | 'heic' | 'avif' | 'webp'
export type VideoFormat = 'original' | 'h264' | 'hevc' | 'mov' | 'webm' | 'gif'

export interface ExportOptions {
  unmodified: boolean
  photoFormat: PhotoFormat
  quality: number
  size: 'full' | 'large' | 'medium' | 'small' | 'custom'
  maxDim?: number
  colorProfile: 'p3' | 'srgb'
  includeMetadata: boolean
  videoFormat: VideoFormat
  videoQuality: 'original' | '2160' | '1080' | '720' | '480'
  includeLive: boolean
  fileName: 'file' | 'title' | 'sequential'
  prefix?: string
  subfolder: 'none' | 'day'
}

export interface ExportProgress { done: number; total: number; current?: string; files: number; bytes: number; skipped?: string[]; dir?: string }

export interface Album {
  id: number
  name: string
  parentId: number | null
  isFolder: number
  createdAt: number
  count: number
  coverId: number | null
}

export interface FolderEntry {
  dir: string
  name: string
  count: number
  coverId: number
}

export interface ImportEntry {
  id: number
  source: string
  mode: string
  started_at: number
  finished_at: number | null
  added: number
  count: number
}

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

export interface ThumbProgress {
  total: number
  done: number
  running: boolean
}

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
  libraryView: LibraryView
  hiddenLocked: boolean
  confirmDelete: boolean
  shareFormat: 'compatible' | 'original'
  shareMaxSize: 'full' | 'large'
  shareVideoQuality: 'original' | '1080' | '720'
  shareIncludeLive: boolean
  shareIncludeMetadata: boolean
  shareConnections?: ShareConnection[]
  holdSpeed: number
  skipSeconds: number
  loopShortVideos: boolean
  rememberVolume: boolean
  volume: number
  slideshowSeconds: number
  reduceMotion: boolean
  backgroundThumbs: boolean
}

export type ConnectionKind = 'system' | 'blip' | 'whatsapp' | 'clipboard' | 'app' | 'folder'
export interface ShareConnection { id: string; kind: ConnectionKind; name: string; enabled: boolean; path?: string; args?: string }
export interface ShareDestination {
  id: string
  connection: string
  kind: ConnectionKind
  title: string
  subtitle?: string
  icon?: string
  peer?: string
  person?: boolean
}

export type LibraryView = 'years' | 'months' | 'days' | 'all'
export type ShowFilter = 'all' | 'favorites' | 'edited' | 'photos' | 'videos'

export interface EditSummary {
  editor?: string
  timestamp?: string
  items: { id: string; label: string; detail?: string }[]
  portrait?: { aperture?: number; lighting?: string; strength?: number }
  liveStyle?: 'loop' | 'bounce' | 'longexposure'
  trim?: { start: number; end: number }
  muted?: boolean
}

export interface AssetFile {
  role: string
  path: string
  name: string
  ext: string
  size: number
  mtime: number
  missing: boolean
}

export interface AssetDetail {
  id: number
  name: string
  dir: string
  kind: 'photo' | 'video'
  original_path: string
  edited_path: string | null
  live_path: string | null
  live_edited_path: string | null
  aae_path: string | null
  width: number | null
  height: number | null
  duration: number | null
  taken_at: number
  tz: string | null
  imported_at: number
  make: string | null
  model: string | null
  lens: string | null
  software: string | null
  iso: number | null
  fnumber: number | null
  exposure: number | null
  focal: number | null
  focal35: number | null
  ev: number | null
  flash: number | null
  lat: number | null
  lon: number | null
  alt: number | null
  subtypes: string[]
  live_style: string | null
  content_id: string | null
  edits: EditSummary | null
  user_edits: { recipe: import('../../shared/edits').EditRecipe; out: { w: number; h: number }; at: number } | null
  user_render: string | null
  quality: string[]
  tech: {
    format?: string
    fileFormat?: string
    megapixels?: number
    hdr?: boolean
    hdrHeadroom?: number
    lensShort?: string
    contentIdMatch?: boolean
    video?: { codec?: string; profile?: string; width?: number; height?: number; fps?: number; bitrate?: number; hdr?: string; audio?: string }
    live?: { codec?: string; width?: number; height?: number; fps?: number; duration?: number }
  }
  favorite: number
  hidden: number
  deleted_at: number | null
  rotation: number
  title: string | null
  caption: string | null
  keywords: string | null
  size_total: number
  size_original: number
  copied: number
  sha256: string | null
  files: AssetFile[]
  albums: { id: number; name: string }[]
}

export interface Suggestion {
  kind: string
  label: string
  source: string
  count: number
}
