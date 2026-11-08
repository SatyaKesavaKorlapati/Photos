import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Images, Sparkles, Heart, Clock, Video, UserRound, Camera, MonitorPlay, Film, Copy, EyeOff, Trash2, ChevronDown, Plus,
  Folder, FolderOpen, Download, Settings2, Timer, Sun, LayoutGrid, Lock
} from 'lucide-react'
import { api } from '../api'
import { addToAlbum, albumMenu, draggedIds, promptNewAlbum } from '../actions'
import { getState, navigate, refreshAll, setState, useStore } from '../store'
import type { Album } from '../types'
import { Spinner } from './Controls'
import {
  BounceIcon, BurstIcon, CinematicIcon, LiveIcon, LongExposureIcon, LoopIcon, PanoramaIcon, PortraitIcon, RawIcon, SidebarIcon, SlomoIcon
} from './Icons'
import { openMenu } from './Menu'

const MEDIA_TYPES: { src: string; label: string; icon: ReactNode }[] = [
  { src: 'videos', label: 'Videos', icon: <Video size={16} /> },
  { src: 'selfie', label: 'Selfies', icon: <UserRound size={16} /> },
  { src: 'live', label: 'Live Photos', icon: <LiveIcon size={16} /> },
  { src: 'portrait', label: 'Portrait', icon: <PortraitIcon size={16} /> },
  { src: 'panorama', label: 'Panoramas', icon: <PanoramaIcon size={16} /> },
  { src: 'timelapse', label: 'Time-lapse', icon: <Timer size={16} /> },
  { src: 'slomo', label: 'Slo-mo', icon: <SlomoIcon size={16} /> },
  { src: 'cinematic', label: 'Cinematic', icon: <CinematicIcon size={16} /> },
  { src: 'loop', label: 'Loop', icon: <LoopIcon size={16} /> },
  { src: 'bounce', label: 'Bounce', icon: <BounceIcon size={16} /> },
  { src: 'longexposure', label: 'Long Exposure', icon: <LongExposureIcon size={16} /> },
  { src: 'burst', label: 'Bursts', icon: <BurstIcon size={16} /> },
  { src: 'screenshot', label: 'Screenshots', icon: <Camera size={16} /> },
  { src: 'screenrec', label: 'Screen Recordings', icon: <MonitorPlay size={16} /> },
  { src: 'animated', label: 'Animated', icon: <Film size={16} /> },
  { src: 'raw', label: 'RAW', icon: <RawIcon size={16} /> },
  { src: 'hdr', label: 'HDR', icon: <Sun size={16} /> }
]

function Item({
  src, label, icon, count, indent, onContext, dropAlbum
}: {
  src: string
  label: ReactNode
  icon: ReactNode
  count?: number
  indent?: number
  onContext?: (e: React.MouseEvent) => void
  dropAlbum?: number
}) {
  const active = useStore((s) => s.source === src)
  const [drop, setDrop] = useState(false)
  return (
    <button
      className={`sb-item${active ? ' active' : ''}${drop ? ' drop' : ''}`}
      style={indent ? { paddingLeft: 10 + indent * 16 } : undefined}
      onClick={() => navigate(src)}
      onContextMenu={onContext}
      onDragOver={(e) => {
        if (dropAlbum === undefined || !draggedIds()) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setDrop(true)
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false)
        const ids = draggedIds()
        if (dropAlbum === undefined || !ids) return
        e.preventDefault()
        e.stopPropagation()
        if (ids.length) addToAlbum(dropAlbum, ids)
      }}
    >
      <span className="ico">{icon}</span>
      <span className="label">{label}</span>
      {count !== undefined && count > 0 && <span className="count">{count.toLocaleString()}</span>}
    </button>
  )
}

function Section({ title, children, defaultOpen = true, onAdd }: { title: string; children: ReactNode; defaultOpen?: boolean; onAdd?: (e: React.MouseEvent) => void }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="sb-section">
      <div className={`sb-heading${open ? '' : ' collapsed'}`} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {onAdd && (
            <button className="add" onClick={(e) => { e.stopPropagation(); onAdd(e) }} title="New">
              <Plus size={14} />
            </button>
          )}
          <ChevronDown className="chev" size={13} />
        </span>
      </div>
      {open && children}
    </div>
  )
}

function AlbumTree({ albums, parent, depth }: { albums: Album[]; parent: number | null; depth: number }) {
  const [renaming, setRenaming] = useState<number | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<number>>(new Set())
  const kids = albums.filter((a) => (a.parentId ?? null) === parent)
  return (
    <>
      {kids.map((a) =>
        renaming === a.id ? (
          <div key={a.id} className="sb-item" style={{ paddingLeft: 10 + depth * 16 }}>
            <span className="ico">{a.isFolder ? <Folder size={16} /> : <Images size={16} />}</span>
            <input
              autoFocus
              defaultValue={a.name}
              onBlur={async (e) => {
                setRenaming(null)
                if (e.target.value.trim() && e.target.value !== a.name) {
                  await api.renameAlbum(a.id, e.target.value.trim())
                  refreshAll()
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          </div>
        ) : a.isFolder ? (
          <div key={a.id}>
            <button
              className="sb-item"
              style={{ paddingLeft: 10 + depth * 16 }}
              onClick={() => {
                const n = new Set(openFolders)
                n.has(a.id) ? n.delete(a.id) : n.add(a.id)
                setOpenFolders(n)
              }}
              onDoubleClick={() => {
                setState({ albumParent: a.id })
                navigate('albums')
              }}
              onContextMenu={(e) => { e.preventDefault(); openMenu(e, albumMenu(a.id, true, () => setRenaming(a.id))) }}
            >
              <span className="ico">{openFolders.has(a.id) ? <FolderOpen size={16} /> : <Folder size={16} />}</span>
              <span className="label">{a.name}</span>
              <ChevronDown size={12} style={{ opacity: 0.5, transform: openFolders.has(a.id) ? '' : 'rotate(-90deg)', transition: 'transform .2s' }} />
            </button>
            {openFolders.has(a.id) && <AlbumTree albums={albums} parent={a.id} depth={depth + 1} />}
          </div>
        ) : (
          <Item
            key={a.id}
            src={`album:${a.id}`}
            label={a.name}
            icon={<Images size={16} />}
            count={a.count}
            indent={depth}
            dropAlbum={a.id}
            onContext={(e) => { e.preventDefault(); openMenu(e, albumMenu(a.id, false, () => setRenaming(a.id))) }}
          />
        )
      )}
    </>
  )
}

function StatusFooter() {
  const imp = useStore((s) => s.importProgress)
  const th = useStore((s) => s.thumbProgress)
  const counts = useStore((s) => s.counts)
  let text = `${(counts.library ?? 0).toLocaleString()} items`
  let pct: number | null = null
  let busy = false
  if (imp && imp.phase !== 'done' && imp.phase !== 'error') {
    busy = true
    const phase = { scanning: 'Looking for photos…', copying: 'Copying', adding: 'Adding to library', reading: 'Reading metadata' }[imp.phase as string] ?? ''
    text = imp.phase === 'scanning' ? `${phase} ${imp.done.toLocaleString()} files` : `${phase} ${imp.done.toLocaleString()} of ${imp.total.toLocaleString()}`
    pct = imp.total ? imp.done / imp.total : null
  } else if (th?.running && th.total > th.done) {
    busy = true
    text = `Processing ${th.done.toLocaleString()} of ${th.total.toLocaleString()}`
    pct = th.total ? th.done / th.total : null
  } else if ((counts.pendingThumbs ?? 0) > 0 && th?.running) {
    busy = true
    text = 'Updating library…'
  }
  return (
    <div className="sb-footer">
      {busy ? <Spinner size={14} /> : <Images size={14} style={{ color: 'var(--text-3)' }} />}
      <div className="grow">
        <div>{busy ? text : `${text} · Up to date`}</div>
        {busy && pct !== null && (
          <div className="bar"><div style={{ width: `${Math.round(pct * 100)}%` }} /></div>
        )}
      </div>
      <button className="tb-btn" title="Settings" onClick={() => setState({ sheet: { kind: 'settings' } })}>
        <Settings2 size={15} />
      </button>
    </div>
  )
}

export function Sidebar({ peek = false, onLeave }: { peek?: boolean; onLeave?: () => void }) {
  const counts = useStore((s) => s.counts)
  const albums = useStore((s) => s.albums)
  const folders = useStore((s) => s.folders)
  return (
    <aside className={`sidebar glass${peek ? ' peek' : ''}`} onMouseLeave={onLeave}>
      <div className="sidebar-top drag">
        <div style={{ width: 76 }} />
        <button
          className="tb-btn no-drag"
          title={peek ? 'Keep Sidebar Open' : 'Hide Sidebar'}
          onClick={() => setState({ sidebarCollapsed: !peek, sidebarPeek: false })}
        >
          <SidebarIcon />
        </button>
      </div>
      <div className="sidebar-scroll">
        <div>
          <Item src="library" label="Library" icon={<Images size={16} />} count={counts.library} />
          <Item src="memories" label="Memories" icon={<Sparkles size={16} />} />
          <Item src="favorites" label="Favourites" icon={<Heart size={16} />} count={counts.favorites} />
          <Item src="recent" label="Recently Saved" icon={<Clock size={16} />} count={counts.recent} />
        </div>

        <Section title="Media Types">
          {MEDIA_TYPES.filter((m) => (counts[m.src] ?? 0) > 0).map((m) => (
            <Item key={m.src} src={m.src} label={m.label} icon={m.icon} count={counts[m.src]} />
          ))}
        </Section>

        <Section title="Utilities">
          <Item src="imports" label="Imports" icon={<Download size={16} />} />
          <Item src="duplicates" label="Duplicates" icon={<Copy size={16} />} count={counts.duplicates} />
          <Item
            src="hidden"
            label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Hidden{getState().settings?.hiddenLocked && <Lock size={11} style={{ opacity: 0.5 }} />}</span>}
            icon={<EyeOff size={16} />}
            count={getState().settings?.hiddenLocked ? undefined : counts.hidden}
          />
          <Item src="deleted" label="Recently Deleted" icon={<Trash2 size={16} />} count={counts.deleted} />
        </Section>

        <Section
          title="Albums"
          onAdd={(e) =>
            openMenu(e, [
              { label: 'New Album', icon: <Images size={14} />, onClick: () => promptNewAlbum() },
              { label: 'New Folder', icon: <Folder size={14} />, onClick: () => promptNewAlbum([], true) }
            ])
          }
        >
          <Item src="albums" label="All Albums" icon={<LayoutGrid size={16} />} />
          <AlbumTree albums={albums} parent={null} depth={0} />
        </Section>

        {folders.length > 0 && (
          <Section title="Folders on Disk" defaultOpen={false}>
            {folders.map((f) => (
              <Item key={f.dir} src={`folder:${f.dir}`} label={f.name} icon={<Folder size={16} />} count={f.count} />
            ))}
          </Section>
        )}
      </div>
      <StatusFooter />
    </aside>
  )
}

/** With the sidebar hidden, touching the window's left edge slides it in over the content. */
export function SidebarPeek() {
  const peek = useStore((s) => s.sidebarPeek)
  const busy = useStore((s) => !!s.menu || !!s.sheet)
  const timer = useRef<number>(0)
  const hiding = useRef(false)
  const cancel = () => {
    window.clearTimeout(timer.current)
    hiding.current = false
  }
  const show = () => {
    cancel()
    timer.current = window.setTimeout(() => setState({ sidebarPeek: true }), 120)
  }
  const hide = () => {
    if (hiding.current || getState().menu || getState().sheet) return
    window.clearTimeout(timer.current)
    hiding.current = true
    timer.current = window.setTimeout(() => {
      hiding.current = false
      setState({ sidebarPeek: false })
    }, 280)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const wrap = useRef<HTMLDivElement>(null)
  // mouseleave alone misses a pointer that never entered the panel (it slid in underneath it), so track position too.
  useEffect(() => {
    if (!peek) return
    const on = (e: PointerEvent) => {
      const right = wrap.current?.getBoundingClientRect().right ?? 0
      if (e.clientX > right + 16) hide()
      else if (e.clientX <= right) cancel()
    }
    window.addEventListener('pointermove', on, { passive: true })
    return () => window.removeEventListener('pointermove', on)
  }, [peek])
  return (
    <>
      <div className="edge-zone" onMouseEnter={show} onMouseLeave={() => !peek && cancel()} />
      {peek && (
        <div className="peek-wrap" ref={wrap} onMouseEnter={cancel}>
          <Sidebar peek onLeave={() => !busy && hide()} />
        </div>
      )}
    </>
  )
}
