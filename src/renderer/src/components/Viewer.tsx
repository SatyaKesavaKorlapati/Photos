import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, Heart, Info, RotateCcw, Share, MoreHorizontal, Play, Pause, Volume2, VolumeX, Maximize, ChevronDown, Check
} from 'lucide-react'
import {
  bounceUrl, compatUrl, fullUrl, liveUrl, longExposureUrl, previewUrl, thumbUrl, videoUrl
} from '../api'
import { assetMenu, exportAssets, hide, purge, rotate, toggleFavorite, trash } from '../actions'
import { getState, setState, useStore } from '../store'
import type { AssetDetail, GridAsset } from '../types'
import { clamp, formatDayLong, formatDuration, formatTime } from '../util'
import { Spinner } from './Controls'
import { BounceIcon, LiveIcon, LongExposureIcon, LoopIcon, PortraitIcon } from './Icons'
import { InfoPanel, QualityTags, invalidateDetail, useDetail } from './InfoPanel'
import { openMenu } from './Menu'
import { sourceTitle } from './TitleBar'

type LiveStyle = 'live' | 'loop' | 'bounce' | 'longexposure' | 'off'

const STYLE_LABEL: Record<LiveStyle, string> = { live: 'Live', loop: 'Loop', bounce: 'Bounce', longexposure: 'Long Exposure', off: 'Live Off' }
const STYLE_ICON = (s: LiveStyle, size = 13) =>
  s === 'loop' ? <LoopIcon size={size} /> : s === 'bounce' ? <BounceIcon size={size} /> : s === 'longexposure' ? <LongExposureIcon size={size} /> : <LiveIcon size={size} off={s === 'off'} />

function useStageSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return size
}

function VideoControls({ video, visible }: { video: HTMLVideoElement | null; visible: boolean }) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!video) return
    const tick = () => force((x) => x + 1)
    const evs = ['timeupdate', 'play', 'pause', 'volumechange', 'progress', 'loadedmetadata']
    evs.forEach((e) => video.addEventListener(e, tick))
    return () => evs.forEach((e) => video.removeEventListener(e, tick))
  }, [video])
  if (!video) return null
  const dur = video.duration || 0
  const pct = dur ? (video.currentTime / dur) * 100 : 0
  const buf = dur && video.buffered.length ? (video.buffered.end(video.buffered.length - 1) / dur) * 100 : 0
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    video.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * dur
  }
  return (
    <div className={`vcontrols glass${visible ? '' : ' hidden'}`} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button onClick={() => (video.paused ? video.play() : video.pause())}>{video.paused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}</button>
      <span>{formatDuration(video.currentTime)}</span>
      <div
        className="scrub"
        onMouseDown={(e) => {
          seek(e)
          const el = e.currentTarget
          const move = (ev: MouseEvent) => {
            const r = el.getBoundingClientRect()
            video.currentTime = clamp((ev.clientX - r.left) / r.width, 0, 1) * dur
          }
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      >
        <div className="buf" style={{ width: `${buf}%` }} />
        <div style={{ width: `${pct}%` }} />
      </div>
      <span>-{formatDuration(Math.max(0, dur - video.currentTime))}</span>
      <button onClick={() => (video.muted = !video.muted)}>{video.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
      <button onClick={() => video.requestFullscreen?.()}><Maximize size={15} /></button>
    </div>
  )
}

function Stage({ a, d, showOriginal, liveStyle, onInfoToggle }: { a: GridAsset; d: AssetDetail | null; showOriginal: boolean; liveStyle: LiveStyle; onInfoToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const stage = useStageSize(ref)
  const settings = useStore((s) => s.settings)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [loaded, setLoaded] = useState(false)
  const [full, setFull] = useState(false)
  const [livePlaying, setLivePlaying] = useState(false)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [videoSrc, setVideoSrc] = useState<string>('')
  const [converting, setConverting] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimer = useRef<number>(0)
  const holdTimer = useRef<number>(0)
  const liveRef = useRef<HTMLVideoElement>(null)

  const rot = a.rot
  const natW = d?.width || a.w || 1600
  const natH = d?.height || a.h || 1200
  const [w0, h0] = rot % 180 ? [natH, natW] : [natW, natH]
  const fit = stage.w && stage.h ? Math.min(stage.w / w0, stage.h / h0, a.video ? 10 : 1e9) : 1
  const boxW = (rot % 180 ? h0 : w0) * fit
  const boxH = (rot % 180 ? w0 : h0) * fit
  const actual = 1 / fit

  useEffect(() => {
    setScale(1)
    setPan({ x: 0, y: 0 })
    setLoaded(false)
    setFull(false)
    setLivePlaying(false)
    setConverting(false)
    setVideoSrc(a.video ? videoUrl(a.id, showOriginal) : '')
  }, [a.id, showOriginal])

  // Like iOS: a Live Photo plays its motion once when you arrive on it.
  useEffect(() => {
    if (!a.live || liveStyle !== 'live' || !settings?.autoplayLive) return
    const t = window.setTimeout(() => setLivePlaying(true), 450)
    return () => window.clearTimeout(t)
  }, [a.id, liveStyle])

  useEffect(() => {
    if (scale > 1.05 && !full && !a.video) setFull(true)
  }, [scale])

  const stillSrc = useMemo(() => {
    if (a.video) return ''
    const aae = d?.edits?.liveStyle
    if (liveStyle === 'longexposure') return aae === 'longexposure' && !showOriginal ? (full ? fullUrl(a.id) : previewUrl(a.id)) : longExposureUrl(a.id)
    const original = showOriginal || aae === 'longexposure'
    return full ? fullUrl(a.id, original) : previewUrl(a.id, original)
  }, [a.id, a.video, full, showOriginal, liveStyle, d?.edits?.liveStyle])

  const motionSrc = useMemo(() => {
    if (!a.live) return ''
    const aae = d?.edits?.liveStyle
    if (liveStyle === 'bounce') return aae === 'bounce' && d?.live_edited_path ? liveUrl(a.id) : bounceUrl(a.id)
    if (liveStyle === 'loop') return liveUrl(a.id, aae !== 'loop')
    return liveUrl(a.id, showOriginal)
  }, [a.id, a.live, liveStyle, showOriginal, d?.live_edited_path, d?.edits?.liveStyle])

  const loops = liveStyle === 'loop' || liveStyle === 'bounce'
  const showMotion = !!a.live && liveStyle !== 'off' && liveStyle !== 'longexposure' && (loops || livePlaying)

  useEffect(() => {
    if (!showMotion || !liveRef.current) return
    liveRef.current.currentTime = 0
    liveRef.current.play().catch(() => undefined)
  }, [showMotion, motionSrc])

  const zoomAt = useCallback(
    (next: number, cx?: number, cy?: number) => {
      const s = clamp(next, 1, Math.max(actual * 2, 2))
      if (s === 1) {
        setScale(1)
        setPan({ x: 0, y: 0 })
        return
      }
      const r = ref.current?.getBoundingClientRect()
      if (r && cx !== undefined && cy !== undefined) {
        const ox = cx - r.left - r.width / 2 - pan.x
        const oy = cy - r.top - r.height / 2 - pan.y
        const k = s / scale
        setPan({ x: pan.x - ox * (k - 1), y: pan.y - oy * (k - 1) })
      }
      setScale(s)
    },
    [actual, scale, pan]
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomAt(scale * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
      } else if (scale > 1) {
        e.preventDefault()
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, zoomAt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === '=' || e.key === '+') zoomAt(scale * 1.4)
      if (e.key === '-') zoomAt(scale / 1.4)
      if (e.key === '0') zoomAt(1)
      if (e.key === ' ' && a.video && videoEl) {
        e.preventDefault()
        videoEl.paused ? videoEl.play() : videoEl.pause()
      } else if (e.key === ' ' && a.live) {
        e.preventDefault()
        setLivePlaying(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scale, zoomAt, a.video, a.live, videoEl])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (scale > 1) {
      const start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
      const move = (ev: MouseEvent) => setPan({ x: start.px + ev.clientX - start.x, y: start.py + ev.clientY - start.y })
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      return
    }
    if (a.live && liveStyle === 'live') {
      holdTimer.current = window.setTimeout(() => setLivePlaying(true), 180)
      const up = () => {
        window.clearTimeout(holdTimer.current)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mouseup', up)
    }
  }

  const onMove = () => {
    setControlsVisible(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2200)
  }

  const transform = `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${-rot}deg)`

  return (
    <div
      ref={ref}
      className="stage"
      onMouseDown={onMouseDown}
      onMouseMove={onMove}
      onDoubleClick={(e) => {
        if (a.video) return
        zoomAt(scale > 1 ? 1 : actual, e.clientX, e.clientY)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu(e, assetMenu([a.id], { onInfo: onInfoToggle, viewer: true }))
      }}
      style={{ cursor: scale > 1 ? 'grab' : 'default' }}
    >
      <div className="media" style={{ width: boxW, height: boxH, transform, transition: scale === 1 ? 'transform .35s var(--ease)' : undefined }}>
        {!a.video && (
          <>
            <img className="layer" src={thumbUrl(a.id)} style={{ filter: 'blur(8px)', transform: 'scale(1.02)', opacity: loaded ? 0 : 1 }} draggable={false} />
            <img className="layer" key={stillSrc} src={stillSrc} style={{ opacity: loaded ? 1 : 0 }} onLoad={() => setLoaded(true)} draggable={false} />
            {a.live && motionSrc && (
              <video
                ref={liveRef}
                className="layer"
                src={motionSrc}
                muted={loops || !livePlaying}
                playsInline
                loop={loops}
                preload="auto"
                style={{ opacity: showMotion ? 1 : 0 }}
                onEnded={() => setLivePlaying(false)}
                onError={(e) => {
                  const v = e.currentTarget
                  if (!v.src.includes('compat')) v.src = compatUrl(a.id, 'live')
                }}
              />
            )}
          </>
        )}
        {a.video && videoSrc && (
          <video
            ref={setVideoEl}
            className="layer"
            src={videoSrc}
            poster={previewUrl(a.id)}
            autoPlay={settings?.autoplayVideos ?? true}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              if (settings?.autoplayVideos ?? true) e.currentTarget.play().catch(() => undefined)
            }}
            onLoadedData={() => {
              setLoaded(true)
              setConverting(false)
            }}
            onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
            onError={() => {
              if (!videoSrc.includes('compat')) {
                setConverting(true)
                setVideoSrc(compatUrl(a.id))
              }
            }}
          />
        )}
      </div>

      {(a.live || d?.subtypes.includes('portrait')) && <ChipRow a={a} d={d} liveStyle={liveStyle} showOriginal={showOriginal} onPlayLive={() => setLivePlaying(true)} onStopLive={() => setLivePlaying(false)} livePlaying={showMotion} />}

      {a.video && <VideoControls video={videoEl} visible={controlsVisible || !!videoEl?.paused} />}
      {(!loaded || converting) && (
        <div className="spinner" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)', fontSize: 12 }}>
          <Spinner size={16} />
          {converting && 'Preparing video for playback…'}
        </div>
      )}
      <button className="nav-btn l glass" onMouseDown={(e) => e.stopPropagation()} onClick={() => step(-1)}><ChevronLeft size={20} /></button>
      <button className="nav-btn r glass" onMouseDown={(e) => e.stopPropagation()} onClick={() => step(1)}><ChevronRight size={20} /></button>
    </div>
  )
}

function ChipRow({
  a, d, liveStyle, showOriginal, onPlayLive, onStopLive, livePlaying
}: {
  a: GridAsset
  d: AssetDetail | null
  liveStyle: LiveStyle
  showOriginal: boolean
  onPlayLive: () => void
  onStopLive: () => void
  livePlaying: boolean
}) {
  const portrait = d?.subtypes.includes('portrait') && !!d.edited_path
  return (
    <div className="chip-row" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {a.live && (
        <button
          className={`chip${livePlaying && liveStyle === 'live' ? ' live-active' : ''}`}
          onMouseEnter={() => liveStyle === 'live' && onPlayLive()}
          onMouseLeave={() => liveStyle === 'live' && onStopLive()}
          onClick={(e) => {
            const styles: LiveStyle[] = ['live', 'loop', 'bounce', 'longexposure', 'off']
            openMenu(
              e.currentTarget.getBoundingClientRect(),
              styles.map((s) => ({
                label: STYLE_LABEL[s],
                icon: STYLE_ICON(s, 15),
                checked: s === liveStyle,
                onClick: () => setLiveStyle(a.id, s)
              }))
            )
          }}
        >
          {STYLE_ICON(liveStyle)}
          {STYLE_LABEL[liveStyle].toUpperCase()}
          <ChevronDown size={11} />
        </button>
      )}
      {portrait && (
        <button
          className={`chip${showOriginal ? '' : ' portrait-on'}`}
          title={showOriginal ? 'Turn Portrait on' : 'Turn Portrait off (show original)'}
          onClick={() => togglePortrait()}
        >
          <PortraitIcon size={13} />
          Portrait
          {d?.edits?.portrait?.lighting && !showOriginal ? <span style={{ opacity: 0.7, fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>· {d.edits.portrait.lighting}</span> : null}
        </button>
      )}
    </div>
  )
}

// Viewer-local state shared with ChipRow through tiny module-level setters.
let setLiveStyleImpl: (id: number, s: LiveStyle) => void = () => undefined
let togglePortraitImpl: () => void = () => undefined
let stepImpl: (d: number) => void = () => undefined
const setLiveStyle = (id: number, s: LiveStyle) => setLiveStyleImpl(id, s)
const togglePortrait = () => togglePortraitImpl()
const step = (d: number) => stepImpl(d)

const liveStyleOverrides = new Map<number, LiveStyle>()

function Filmstrip({ ids, index, onPick }: { ids: number[]; index: number; onPick: (i: number) => void }) {
  const span = 12
  const lo = Math.max(0, index - span)
  const hi = Math.min(ids.length - 1, index + span)
  const list = []
  for (let i = lo; i <= hi; i++) list.push(i)
  return (
    <div className="filmstrip">
      {list.map((i) => (
        <button key={ids[i]} className={i === index ? 'cur' : ''} onClick={() => onPick(i)}>
          <img src={thumbUrl(ids[i])} loading="lazy" draggable={false} />
        </button>
      ))}
    </div>
  )
}

export function Viewer() {
  const viewer = useStore((s) => s.viewer)!
  const assets = useStore((s) => s.assets)
  const infoOpen = useStore((s) => s.infoOpen)
  const [showOriginal, setShowOriginal] = useState(false)
  const [holdOriginal, setHoldOriginal] = useState(false)
  const [version, setVersion] = useState(0)
  const id = viewer.ids[viewer.index]
  const a = useMemo(() => assets.find((x) => x.id === id), [assets, id])
  const d = useDetail(id ?? null, version)
  const [caption, setCaption] = useState('')
  const baseStyle = (d?.live_style as LiveStyle | null) ?? (a?.live as LiveStyle | null) ?? 'live'
  const [liveStyle, setLiveStyleState] = useState<LiveStyle>('live')

  useEffect(() => {
    setLiveStyleState(liveStyleOverrides.get(id) ?? baseStyle)
  }, [id, baseStyle])
  useEffect(() => {
    setShowOriginal(false)
    setCaption(d?.caption ?? '')
  }, [id, d?.caption])

  const go = useCallback(
    (delta: number) => {
      const s = getState().viewer
      if (!s) return
      const index = clamp(s.index + delta, 0, s.ids.length - 1)
      if (index !== s.index) setState({ viewer: { ...s, index }, selection: new Set([s.ids[index]]), anchor: s.ids[index] })
    },
    []
  )

  setLiveStyleImpl = (aid, s) => {
    liveStyleOverrides.set(aid, s)
    setLiveStyleState(s)
  }
  togglePortraitImpl = () => setShowOriginal((v) => !v)
  stepImpl = go

  // Prefetch neighbours so arrowing feels instant.
  useEffect(() => {
    for (const k of [1, -1, 2]) {
      const nid = viewer.ids[viewer.index + k]
      if (nid !== undefined) {
        const img = new Image()
        img.src = previewUrl(nid)
      }
    }
  }, [viewer.index])

  const close = useCallback(() => {
    const s = getState()
    setState({ viewer: null, selection: new Set([id]), anchor: id, scrollTarget: null })
    void s
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      if (getState().menu || getState().sheet) return
      const ctrl = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') return close()
      if (e.key === 'ArrowRight') return go(1)
      if (e.key === 'ArrowLeft') return go(-1)
      if (e.key.toLowerCase() === 'm' && !ctrl && d?.edited_path) setHoldOriginal(true)
      if (e.key === '.') return void toggleFavorite([id])
      if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); return setState({ infoOpen: !getState().infoOpen }) }
      if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); return void rotate([id], e.altKey ? 90 : -90) }
      if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); return void hide([id], getState().source !== 'hidden') }
      if (e.key === 'Delete' || (ctrl && e.key === 'Backspace')) {
        e.preventDefault()
        const next = viewer.ids.filter((x) => x !== id)
        if (getState().source === 'deleted') return void purge([id])
        trash([id])
        if (!next.length) return setState({ viewer: null })
        setState({ viewer: { ...viewer, ids: next, index: Math.min(viewer.index, next.length - 1) } })
      }
      if (e.key.toLowerCase() === 'f' && !ctrl) window.api.win.fullscreen()
    }
    const onUp = (e: KeyboardEvent) => e.key.toLowerCase() === 'm' && setHoldOriginal(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
    }
  }, [go, close, id, viewer, d?.edited_path])

  if (!a) return null
  const original = showOriginal || holdOriginal
  const title = d?.title || formatDayLong(a.t)
  const sub = d?.title ? `${formatDayLong(a.t)} · ${formatTime(a.t)}` : `${formatTime(a.t)}${a.name ? ` · ${a.name}` : ''}`

  return (
    <div className="viewer" onMouseDown={(e) => e.stopPropagation()}>
      <div className="viewer-head">
        <button className="back-pill glass" onClick={close}>
          <ChevronLeft size={18} />
          {sourceTitle(viewer.source)}
        </button>
        <div className="center">
          <div className="t">{title}</div>
          <div className="s">{sub}{holdOriginal ? ' · Original' : ''}</div>
        </div>
        <div className="right">
          <div className="tb-group glass">
            <button className={`tb-btn${a.fav ? ' fav-on' : ''}`} title="Favourite (.)" onClick={() => toggleFavorite([a.id])}>
              <Heart size={16} fill={a.fav ? 'currentColor' : 'none'} />
            </button>
            <button className={`tb-btn${infoOpen ? ' on' : ''}`} title="Info" onClick={() => setState({ infoOpen: !infoOpen })}>
              <Info size={16} />
            </button>
            <button className="tb-btn" title="Rotate" onClick={() => rotate([a.id])}>
              <RotateCcw size={16} />
            </button>
            <button
              className="tb-btn"
              title="Share"
              onClick={(e) =>
                openMenu(e.currentTarget.getBoundingClientRect(), [
                  { label: 'Export…', onClick: () => exportAssets([a.id], 'current') },
                  { label: 'Export Unmodified Original…', onClick: () => exportAssets([a.id], 'original') },
                  { separator: true },
                  ...assetMenu([a.id]).filter((m) => m.label === 'Copy' || m.label?.startsWith('Show in') || m.label === 'Open With Default App')
                ], 'right')
              }
            >
              <Share size={16} />
            </button>
            <button
              className="tb-btn"
              title="More"
              onClick={(e) =>
                openMenu(e.currentTarget.getBoundingClientRect(), [
                  ...(d?.edited_path
                    ? [
                        {
                          label: showOriginal ? 'Show Edited Version' : 'Show Original',
                          shortcut: 'M',
                          icon: <Check size={14} style={{ opacity: showOriginal ? 1 : 0 }} />,
                          onClick: () => setShowOriginal(!showOriginal)
                        },
                        { separator: true }
                      ]
                    : []),
                  ...assetMenu([a.id], { onInfo: () => setState({ infoOpen: true }) })
                ], 'right')
              }
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>
      </div>

      <Stage a={a} d={d} showOriginal={original} liveStyle={liveStyle} onInfoToggle={() => setState({ infoOpen: !infoOpen })} />

      <div className="viewer-foot">
        <div className="meta">
          <div className="date">{formatDayLong(a.t)} · {formatTime(a.t)}</div>
          <textarea
            rows={1}
            placeholder="Add a caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onBlur={() => {
              if (caption !== (d?.caption ?? '')) {
                window.api.setText(a.id, 'caption', caption).then(() => {
                  invalidateDetail(a.id)
                  setVersion((v) => v + 1)
                })
              }
            }}
          />
        </div>
        {d && <div className="quality"><QualityTags d={d} /></div>}
      </div>
      <Filmstrip ids={viewer.ids} index={viewer.index} onPick={(i) => setState({ viewer: { ...viewer, index: i }, selection: new Set([viewer.ids[i]]) })} />
      {infoOpen && <InfoPanel id={a.id} />}
    </div>
  )
}
