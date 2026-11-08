import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, Heart, Info, RotateCcw, Share, MoreHorizontal, Play, Pause, Volume2, Volume1, VolumeX, Maximize, Minimize,
  ChevronDown, Check, PictureInPicture2, Repeat, RotateCcw as Back10, RotateCw as Fwd10, Gauge, Trash2, SlidersHorizontal, FastForward
} from 'lucide-react'
import {
  api, bounceUrl, compatUrl, fullUrl, liveUrl, longExposureUrl, previewUrl, stripUrl, thumbUrl, videoUrl
} from '../api'
import { assetMenu, hide, openEditor, purge, rotate, toggleFavorite, trash } from '../actions'
import { openShare } from './Share'
import { getState, setState, updateSettings, useStore } from '../store'
import type { AssetDetail, GridAsset } from '../types'
import { clamp, formatDayLong, formatDuration, formatTime } from '../util'
import { Slider, Spinner } from './Controls'
import { BounceIcon, LiveIcon, LongExposureIcon, LoopIcon, PortraitIcon } from './Icons'
import { InfoPanel, QualityTags, invalidateDetail, useDetail } from './InfoPanel'
import { openMenu } from './Menu'
import { sourceTitle, TrafficLights } from './TitleBar'

type LiveStyle = 'live' | 'loop' | 'bounce' | 'longexposure' | 'off'

const STYLE_LABEL: Record<LiveStyle, string> = { live: 'Live', loop: 'Loop', bounce: 'Bounce', longexposure: 'Long Exposure', off: 'Live Off' }
const STYLE_ICON = (s: LiveStyle, size = 13) =>
  s === 'loop' ? <LoopIcon size={size} /> : s === 'bounce' ? <BounceIcon size={size} /> : s === 'longexposure' ? <LongExposureIcon size={size} /> : <LiveIcon size={size} off={s === 'off'} />

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

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

/** QuickTime / iOS style transport: skip ±10 s, scrubber with frame preview, speed, volume, loop, PiP, full screen. */
function VideoControls({ a, video, visible, fullscreen, skip: skipBy }: { a: GridAsset; video: HTMLVideoElement | null; visible: boolean; fullscreen: boolean; skip: number }) {
  const [, force] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [volOpen, setVolOpen] = useState(false)
  const scrubRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!video) return
    const tick = () => force((x) => x + 1)
    const evs = ['timeupdate', 'play', 'pause', 'volumechange', 'progress', 'loadedmetadata', 'ratechange', 'enterpictureinpicture', 'leavepictureinpicture']
    evs.forEach((e) => video.addEventListener(e, tick))
    return () => evs.forEach((e) => video.removeEventListener(e, tick))
  }, [video])
  if (!video) return null
  const dur = video.duration || 0
  const pct = dur ? (video.currentTime / dur) * 100 : 0
  const buf = dur && video.buffered.length ? (video.buffered.end(video.buffered.length - 1) / dur) * 100 : 0
  const at = (clientX: number) => {
    const r = scrubRef.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1)
  }
  const skip = (s: number) => (video.currentTime = clamp(video.currentTime + s, 0, dur))
  const VolIcon = video.muted || video.volume === 0 ? VolumeX : video.volume < 0.5 ? Volume1 : Volume2
  const pip = document.pictureInPictureElement === video
  return (
    <div
      className={`vcontrols glass${visible ? '' : ' hidden'}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="vc-row">
        <button title={`Back ${skipBy} seconds (J)`} onClick={() => skip(-skipBy)}><Back10 size={16} /><small>{skipBy}</small></button>
        <button className="pp" title="Play/Pause (Space · hold Space to fast-forward)" onClick={() => (video.paused ? video.play() : video.pause())}>
          {video.paused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
        </button>
        <button title={`Forward ${skipBy} seconds (L)`} onClick={() => skip(skipBy)}><Fwd10 size={16} /><small>{skipBy}</small></button>
        <span className="t">{formatDuration(video.currentTime)}</span>
        <div
          ref={scrubRef}
          className="scrub"
          onMouseMove={(e) => setHover(at(e.clientX))}
          onMouseLeave={() => setHover(null)}
          onMouseDown={(e) => {
            const wasPaused = video.paused
            video.pause()
            video.currentTime = at(e.clientX) * dur
            const move = (ev: MouseEvent) => {
              video.currentTime = at(ev.clientX) * dur
              setHover(at(ev.clientX))
            }
            const up = () => {
              window.removeEventListener('mousemove', move)
              window.removeEventListener('mouseup', up)
              if (!wasPaused) video.play()
            }
            window.addEventListener('mousemove', move)
            window.addEventListener('mouseup', up)
          }}
        >
          <div className="buf" style={{ width: `${buf}%` }} />
          <div className="pos" style={{ width: `${pct}%` }} />
          <div className="knob" style={{ left: `${pct}%` }} />
          {hover !== null && (
            <div className="scrub-tip" style={{ left: `${hover * 100}%` }}>
              {!a.ev && (
                <div className="frame" style={{ backgroundImage: `url("${stripUrl(a.id)}")`, backgroundPositionX: `${(Math.min(13, Math.floor(hover * 14)) / 13) * 100}%` }} />
              )}
              <span>{formatDuration(hover * dur)}</span>
            </div>
          )}
        </div>
        <span className="t">-{formatDuration(Math.max(0, dur - video.currentTime))}</span>
        <button
          className={video.playbackRate !== 1 ? 'on wide' : 'wide'}
          title="Playback Speed"
          onClick={(e) =>
            openMenu(e.currentTarget.getBoundingClientRect(), [
              { header: true, label: 'Playback Speed' },
              ...SPEEDS.map((s) => ({ label: s === 1 ? 'Normal' : `${s}×`, checked: video.playbackRate === s, onClick: () => (video.playbackRate = s) }))
            ], 'right')
          }
        >
          {video.playbackRate !== 1 ? <b>{video.playbackRate}×</b> : <Gauge size={16} />}
        </button>
        <div className="vol" onMouseEnter={() => setVolOpen(true)} onMouseLeave={() => setVolOpen(false)}>
          <button title="Mute (M)" onClick={() => (video.muted = !video.muted)}><VolIcon size={16} /></button>
          <div className={`vol-pop${volOpen ? ' open' : ''}`}>
            <Slider
              title="Volume"
              value={video.muted ? 0 : video.volume}
              onChange={(v) => {
                video.volume = v
                video.muted = v === 0
              }}
            />
          </div>
        </div>
        <button className={video.loop ? 'on' : ''} title="Loop" onClick={() => (video.loop = !video.loop)}><Repeat size={15} /></button>
        <button
          className={pip ? 'on' : ''}
          title="Picture in Picture (P)"
          onClick={() => (pip ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => undefined)}
        >
          <PictureInPicture2 size={16} />
        </button>
        <button title={fullscreen ? 'Exit Full Screen (F)' : 'Full Screen (F)'} onClick={() => api.win.fullscreen()}>
          {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </button>
      </div>
    </div>
  )
}

interface StageProps {
  a: GridAsset
  d: AssetDetail | null
  showOriginal: boolean
  liveStyle: LiveStyle
  chrome: boolean
  fullscreen: boolean
  intro: DOMRect | null
  outro: DOMRect | null
  onTap: () => void
  onActivity: (playing: boolean) => void
  onInfoToggle: () => void
}

function Stage({ a, d, showOriginal, liveStyle, chrome, fullscreen, intro, outro, onTap, onActivity, onInfoToggle }: StageProps) {
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
  const [introDone, setIntroDone] = useState(!intro)
  const holdTimer = useRef<number>(0)
  const tapTimer = useRef<number>(0)
  const liveRef = useRef<HTMLVideoElement>(null)
  const spaceTimer = useRef<number>(0)
  const spaceDown = useRef(false)
  const boost = useRef<{ rate: number; paused: boolean } | null>(null)
  const [boosting, setBoosting] = useState(false)

  const startBoost = () => {
    if (!videoEl || boost.current) return
    boost.current = { rate: videoEl.playbackRate, paused: videoEl.paused }
    videoEl.playbackRate = getState().settings?.holdSpeed ?? 2
    if (videoEl.paused) videoEl.play().catch(() => undefined)
    setBoosting(true)
  }
  const endBoost = () => {
    const b = boost.current
    if (!b) return
    boost.current = null
    setBoosting(false)
    if (!videoEl) return
    videoEl.playbackRate = b.rate
    if (b.paused) videoEl.pause()
  }

  const rot = a.rot
  const natW = d?.user_edits?.out.w || (d?.user_render ? a.w : d?.width) || a.w || 1600
  const natH = d?.user_edits?.out.h || (d?.user_render ? a.h : d?.height) || a.h || 1200
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
  }, [a.id, showOriginal, a.ev])

  useLayoutEffect(() => {
    if (!intro || introDone || !stage.w) return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setIntroDone(true)))
    return () => cancelAnimationFrame(id)
  }, [stage.w])

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
    if (liveStyle === 'longexposure') {
      if (aae === 'longexposure' && !showOriginal) return full ? fullUrl(a.id) : previewUrl(a.id)
      return longExposureUrl(a.id)
    }
    const original = showOriginal || (aae === 'longexposure' && !a.ev)
    return full ? fullUrl(a.id, original) : previewUrl(a.id, original)
  }, [a.id, a.video, a.ev, full, showOriginal, liveStyle, d?.edits?.liveStyle])

  // Switching style or resolution keeps the last decoded still on screen until the new one arrives.
  const [shown, setShown] = useState<{ id: number; src: string } | null>(null)
  useEffect(() => {
    if (shown && shown.src !== stillSrc) setLoaded(false)
  }, [stillSrc])

  const motionSrc = useMemo(() => {
    if (!a.live) return ''
    const aae = d?.edits?.liveStyle
    if (liveStyle === 'bounce') return aae === 'bounce' && d?.live_edited_path ? liveUrl(a.id) : bounceUrl(a.id)
    if (liveStyle === 'loop') return liveUrl(a.id, aae !== 'loop' && !a.ev)
    return liveUrl(a.id, showOriginal)
  }, [a.id, a.live, a.ev, liveStyle, showOriginal, d?.live_edited_path, d?.edits?.liveStyle])

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
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 30) {
        step(e.deltaX > 0 ? 1 : -1)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, zoomAt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      if (getState().menu || getState().sheet) return
      const k = e.key.toLowerCase()
      if (e.key === '=' || e.key === '+') zoomAt(scale * 1.4)
      if (e.key === '-') zoomAt(scale / 1.4)
      if (e.key === '0') zoomAt(1)
      if (a.video && videoEl) {
        const skip = settings?.skipSeconds ?? 10
        // Space: a tap toggles playback on release; holding it plays fast until let go, like YouTube.
        if (e.key === ' ') {
          e.preventDefault()
          // A focused button would also "click" on Space release and toggle playback a second time.
          if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
          if (!e.repeat) {
            window.clearTimeout(spaceTimer.current)
            spaceDown.current = true
            spaceTimer.current = window.setTimeout(() => spaceDown.current && startBoost(), 350)
          }
        }
        if (k === 'k') videoEl.paused ? videoEl.play() : videoEl.pause()
        if (k === 'j') videoEl.currentTime = Math.max(0, videoEl.currentTime - skip)
        if (k === 'l' && !e.ctrlKey && !e.metaKey) videoEl.currentTime = Math.min(videoEl.duration, videoEl.currentTime + skip)
        if (e.shiftKey && e.key === 'ArrowLeft') videoEl.currentTime = Math.max(0, videoEl.currentTime - 5)
        if (e.shiftKey && e.key === 'ArrowRight') videoEl.currentTime = Math.min(videoEl.duration, videoEl.currentTime + 5)
        if (e.key === 'ArrowUp') { e.preventDefault(); videoEl.volume = Math.min(1, videoEl.volume + 0.1); videoEl.muted = false }
        if (e.key === 'ArrowDown') { e.preventDefault(); videoEl.volume = Math.max(0, videoEl.volume - 0.1) }
        if (k === 'm') videoEl.muted = !videoEl.muted
        if (k === 'p') (document.pictureInPictureElement ? document.exitPictureInPicture() : videoEl.requestPictureInPicture()).catch(() => undefined)
      } else if (e.key === ' ' && a.live) {
        e.preventDefault()
        setLivePlaying(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !a.video || !videoEl || !spaceDown.current) return
      e.preventDefault()
      spaceDown.current = false
      window.clearTimeout(spaceTimer.current)
      if (boost.current) endBoost()
      else videoEl.paused ? videoEl.play() : videoEl.pause()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [scale, zoomAt, a.video, a.live, videoEl, settings?.skipSeconds, settings?.holdSpeed])

  // A video starts at the remembered volume, and short clips loop if that's turned on.
  useEffect(() => {
    if (!videoEl || !settings) return
    if (settings.rememberVolume) videoEl.volume = clamp(settings.volume, 0, 1)
    const meta = () => {
      if (settings.loopShortVideos && videoEl.duration && videoEl.duration < 30) videoEl.loop = true
    }
    meta()
    let t = 0
    const vol = () => {
      if (!getState().settings?.rememberVolume || videoEl.muted) return
      window.clearTimeout(t)
      t = window.setTimeout(() => updateSettings({ volume: Math.round(videoEl.volume * 100) / 100 }), 600)
    }
    videoEl.addEventListener('loadedmetadata', meta)
    videoEl.addEventListener('volumechange', vol)
    return () => {
      window.clearTimeout(t)
      videoEl.removeEventListener('loadedmetadata', meta)
      videoEl.removeEventListener('volumechange', vol)
    }
  }, [videoEl])

  useEffect(() => () => endBoost(), [videoEl])

  // Videos hide the controls while playing, like QuickTime; any movement brings them back.
  useEffect(() => {
    if (!videoEl) return
    const on = () => onActivity(!videoEl.paused)
    videoEl.addEventListener('play', on)
    videoEl.addEventListener('pause', on)
    return () => {
      videoEl.removeEventListener('play', on)
      videoEl.removeEventListener('pause', on)
    }
  }, [videoEl])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, t: Date.now() }
    let moved = false
    const move = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 5) {
        moved = true
        if (!boost.current) window.clearTimeout(holdTimer.current)
      }
      if (scale > 1) setPan({ x: start.px + ev.clientX - start.x, y: start.py + ev.clientY - start.y })
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.clearTimeout(holdTimer.current)
      if (boost.current) return endBoost()
      const dx = ev.clientX - start.x
      // A quick horizontal swipe pages between photos, like on iPhone.
      if (scale === 1 && Math.abs(dx) > 80 && Math.abs(ev.clientY - start.y) < 60 && Date.now() - start.t < 600) {
        step(dx < 0 ? 1 : -1)
        return
      }
      if (!moved && ev.detail === 1) {
        window.clearTimeout(tapTimer.current)
        tapTimer.current = window.setTimeout(onTap, 230)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    if (a.live && liveStyle === 'live' && scale === 1) holdTimer.current = window.setTimeout(() => setLivePlaying(true), 260)
    // Touch-and-hold a playing video to fast-forward while held.
    if (a.video && videoEl && !videoEl.paused && scale === 1) holdTimer.current = window.setTimeout(startBoost, 450)
  }

  let intoTransform = ''
  const target = outro ?? (!introDone ? intro : null)
  if (target && stage.w && boxW) {
    const r = ref.current?.getBoundingClientRect()
    const cx = (r?.left ?? 0) + stage.w / 2
    const cy = (r?.top ?? 0) + stage.h / 2
    const s = Math.max(target.width / boxW, target.height / boxH)
    intoTransform = `translate(${target.left + target.width / 2 - cx}px, ${target.top + target.height / 2 - cy}px) scale(${s}) `
  }
  const transform = `${intoTransform}translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${-rot}deg)`
  const animating = !!outro || introDone

  return (
    <div
      ref={ref}
      className={`stage${chrome ? '' : ' no-cursor'}`}
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => {
        window.clearTimeout(tapTimer.current)
        if (a.video) return api.win.fullscreen()
        zoomAt(scale > 1 ? 1 : actual, e.clientX, e.clientY)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu(e, [
          {
            quick: [
              { label: a.fav ? 'Unfavourite' : 'Favourite', icon: <Heart size={17} fill={a.fav ? 'currentColor' : 'none'} />, onClick: () => toggleFavorite([a.id]) },
              { label: 'Share', icon: <Share size={17} />, onClick: () => openShare([a.id], new DOMRect(e.clientX, e.clientY, 0, 0)) },
              { label: 'Info', icon: <Info size={17} />, onClick: onInfoToggle },
              { label: 'Edit', icon: <SlidersHorizontal size={17} />, onClick: () => openEditor(a.id) }
            ]
          },
          ...assetMenu([a.id], { viewer: true })
        ])
      }}
      style={{ cursor: scale > 1 ? 'grab' : undefined }}
    >
      <div
        className={`media${target ? ' framed' : ''}`}
        style={{
          width: boxW,
          height: boxH,
          transform,
          transition: animating && (scale === 1 || outro) ? `transform ${outro ? '.32s' : '.5s'} var(--spring-soft)` : undefined
        }}
      >
        {!a.video && (
          <>
            <img className="layer" src={thumbUrl(a.id)} style={{ filter: loaded ? undefined : 'blur(6px)', opacity: loaded ? 0 : 1 }} draggable={false} />
            {shown?.id === a.id && shown.src !== stillSrc && <img className="layer" src={shown.src} draggable={false} />}
            <img
              className="layer"
              key={stillSrc}
              src={stillSrc}
              style={{ opacity: loaded ? 1 : 0 }}
              onLoad={() => {
                setLoaded(true)
                setShown({ id: a.id, src: stillSrc })
              }}
              draggable={false}
            />
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
            onError={() => {
              if (!videoSrc.includes('compat')) {
                setConverting(true)
                setVideoSrc(compatUrl(a.id))
              }
            }}
          />
        )}
      </div>

      {(a.live || d?.subtypes.includes('portrait')) && (
        <ChipRow a={a} d={d} visible={chrome} liveStyle={liveStyle} showOriginal={showOriginal} onPlayLive={() => setLivePlaying(true)} onStopLive={() => setLivePlaying(false)} livePlaying={showMotion} />
      )}

      {boosting && (
        <div className="boost-badge glass">
          {settings?.holdSpeed ?? 2}× <FastForward size={14} fill="currentColor" />
        </div>
      )}
      {a.video && <VideoControls a={a} video={videoEl} visible={chrome || !!videoEl?.paused} fullscreen={fullscreen} skip={settings?.skipSeconds ?? 10} />}
      {a.video && videoEl?.paused && loaded && !chrome && (
        <button className="big-play glass" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); videoEl.play() }}>
          <Play size={30} fill="currentColor" />
        </button>
      )}
      {(!loaded || converting) && (
        <div className="spinner">
          <Spinner size={16} />
          {converting && 'Preparing video for playback…'}
          {!converting && liveStyle === 'longexposure' && !d?.edits?.liveStyle && 'Rendering Long Exposure…'}
        </div>
      )}
      <button className={`nav-btn l glass${chrome ? '' : ' gone'}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => step(-1)}><ChevronLeft size={20} /></button>
      <button className={`nav-btn r glass${chrome ? '' : ' gone'}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => step(1)}><ChevronRight size={20} /></button>
    </div>
  )
}

function ChipRow({
  a, d, visible, liveStyle, showOriginal, onPlayLive, onStopLive, livePlaying
}: {
  a: GridAsset
  d: AssetDetail | null
  visible: boolean
  liveStyle: LiveStyle
  showOriginal: boolean
  onPlayLive: () => void
  onStopLive: () => void
  livePlaying: boolean
}) {
  const portrait = d?.subtypes.includes('portrait') && !!d.edited_path
  // Newer iPhones keep portraits unblurred and apply depth when shown; offer it when the photo has a depth map.
  const [hasDepth, setHasDepth] = useState(false)
  useEffect(() => {
    setHasDepth(false)
    if (!d || portrait || !d.subtypes.includes('portrait') || d.kind !== 'photo') return
    let live = true
    api.depth(d.id).then((x) => live && setHasDepth(!!x)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [d?.id, portrait])
  const edited = d?.user_edits?.recipe?.portrait
  return (
    <div className={`chip-row${visible ? '' : ' gone'}`} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
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
      {portrait && !showOriginal && (
        <button className="chip" title="Adjust depth (opens Portrait in Edit)" onClick={() => openEditor(a.id, 'portrait')}>
          ƒ{(edited?.aperture ?? d?.edits?.portrait?.aperture ?? 4.5).toFixed(1)}
        </button>
      )}
      {!portrait && hasDepth && (
        <button
          className={`chip${edited?.on && !showOriginal ? ' portrait-on' : ''}`}
          title="Add or adjust the portrait depth effect"
          onClick={() => openEditor(a.id, 'portrait')}
        >
          <PortraitIcon size={13} />
          Portrait{edited?.on ? ` · ƒ${edited.aperture.toFixed(1)}` : ''}
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

function Filmstrip({ ids, index, onPick, visible }: { ids: number[]; index: number; onPick: (i: number) => void; visible: boolean }) {
  const span = 14
  const lo = Math.max(0, index - span)
  const hi = Math.min(ids.length - 1, index + span)
  const list = []
  for (let i = lo; i <= hi; i++) list.push(i)
  return (
    <div className={`filmstrip${visible ? '' : ' gone'}`} onMouseDown={(e) => e.stopPropagation()}>
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
  const fullscreen = useStore((s) => s.fullscreen)
  const origin = useStore((s) => s.viewerOrigin)
  const [showOriginal, setShowOriginal] = useState(false)
  const [holdOriginal, setHoldOriginal] = useState(false)
  const [version, setVersion] = useState(0)
  const [chrome, setChrome] = useState(true)
  const [closing, setClosing] = useState<DOMRect | null>(null)
  const [fading, setFading] = useState(false)
  const idleTimer = useRef<number>(0)
  const playingRef = useRef(false)
  const id = viewer.ids[viewer.index]
  const a = useMemo(() => assets.find((x) => x.id === id), [assets, id])
  const d = useDetail(id ?? null, version + (a?.ev ?? 0))
  const [caption, setCaption] = useState('')
  const baseStyle = (d?.live_style as LiveStyle | null) ?? (a?.live as LiveStyle | null) ?? 'live'
  const [liveStyle, setLiveStyleState] = useState<LiveStyle>('live')
  const [intro] = useState(() => (origin && origin.id === id ? origin.rect : null))

  useEffect(() => {
    setLiveStyleState(liveStyleOverrides.get(id) ?? baseStyle)
  }, [id, baseStyle])
  useEffect(() => {
    setShowOriginal(false)
    setCaption(d?.caption ?? '')
  }, [id, d?.caption])

  const go = useCallback((delta: number) => {
    const s = getState().viewer
    if (!s) return
    const index = clamp(s.index + delta, 0, s.ids.length - 1)
    if (index !== s.index) setState({ viewer: { ...s, index }, selection: new Set([s.ids[index]]), anchor: s.ids[index] })
  }, [])

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
    if (closing || fading) return
    const cell = document.querySelector<HTMLElement>(`.cell[data-id="${id}"]`)
    const r = cell?.getBoundingClientRect()
    const onScreen = r && r.bottom > 60 && r.top < window.innerHeight && r.width > 0
    setState({ selection: new Set([id]), anchor: id, scrollTarget: null })
    if (onScreen) setClosing(r!)
    else setFading(true)
    window.setTimeout(() => setState({ viewer: null, viewerOrigin: null }), onScreen ? 300 : 200)
  }, [id, closing, fading])

  const poke = useCallback(() => {
    window.clearTimeout(idleTimer.current)
    if (playingRef.current) {
      setChrome(true)
      idleTimer.current = window.setTimeout(() => playingRef.current && setChrome(false), 2600)
    }
  }, [])

  const remove = useCallback(async () => {
    const s = getState()
    const ok = s.source === 'deleted' ? await purge([id]) : await trash([id])
    if (!ok) return
    const v = getState().viewer
    if (!v) return
    const next = v.ids.filter((x) => x !== id)
    if (!next.length) return setState({ viewer: null })
    setState({ viewer: { ...v, ids: next, index: Math.min(v.index, next.length - 1) } })
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      if (getState().menu || getState().sheet || getState().editor) return
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      // Esc always returns to the album; the window stays full screen (F / F11 toggle that).
      if (e.key === 'Escape') return close()
      if (e.key === 'ArrowRight' && !e.shiftKey) return go(1)
      if (e.key === 'ArrowLeft' && !e.shiftKey) return go(-1)
      if (k === 'm' && !ctrl && !a?.video && (d?.edited_path || d?.user_render)) setHoldOriginal(true)
      if (e.key === '.') return void toggleFavorite([id])
      if ((ctrl && k === 'e') || (e.key === 'Enter' && !a?.video)) { e.preventDefault(); return openEditor(id) }
      if (ctrl && k === 'i') { e.preventDefault(); return setState({ infoOpen: !getState().infoOpen }) }
      if (ctrl && k === 'r') { e.preventDefault(); return void rotate([id], e.altKey ? 90 : -90) }
      if (ctrl && k === 'l') { e.preventDefault(); return void hide([id], getState().source !== 'hidden') }
      if (e.key === 'Delete' || (ctrl && e.key === 'Backspace')) {
        e.preventDefault()
        return void remove()
      }
      if (k === 'f' && !ctrl) api.win.fullscreen()
      if (k === 'h' && !ctrl) setChrome((c) => !c)
    }
    const onUp = (e: KeyboardEvent) => e.key.toLowerCase() === 'm' && setHoldOriginal(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
    }
  }, [go, close, id, remove, a?.video, d?.edited_path, d?.user_render])

  useEffect(() => () => window.clearTimeout(idleTimer.current), [])

  if (!a) return null
  const original = showOriginal || holdOriginal
  const title = d?.title || formatDayLong(a.t)
  const sub = d?.title ? `${formatDayLong(a.t)} · ${formatTime(a.t)}` : `${formatTime(a.t)}${a.name ? ` · ${a.name}` : ''}`
  const canCompare = !!(d?.edited_path || d?.user_render)

  return (
    <div
      className={`viewer${chrome ? '' : ' immersive'}${closing || fading ? ' closing' : ''}${intro ? ' zoom-in' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={poke}
    >
      <TrafficLights />
      <div className={`viewer-head${chrome ? '' : ' gone'}`} onMouseDown={(e) => e.stopPropagation()}>
        <button className="back-pill glass" onClick={close} title="Back (Esc)">
          <ChevronLeft size={18} />
          {sourceTitle(viewer.source)}
        </button>
        <div className="center glass-text">
          <div className="t">{title}</div>
          <div className="s">{sub}{holdOriginal ? ' · Original' : ''}</div>
        </div>
        <div className="right">
          <div className="tb-group glass">
            <button className={`tb-btn${a.fav ? ' fav-on' : ''}`} title="Favourite (.)" onClick={() => toggleFavorite([a.id])}>
              <Heart size={16} fill={a.fav ? 'currentColor' : 'none'} />
            </button>
            <button className={`tb-btn${infoOpen ? ' on' : ''}`} title="Info (Ctrl+I)" onClick={() => setState({ infoOpen: !infoOpen })}>
              <Info size={16} />
            </button>
            <button className="tb-btn" title="Rotate (Ctrl+R)" onClick={() => rotate([a.id])}>
              <RotateCcw size={16} />
            </button>
            <button className="tb-btn" title="Share" onClick={(e) => openShare([a.id], e.currentTarget)}>
              <Share size={16} />
            </button>
            <button className="tb-btn" title="Delete (Del)" onClick={() => void remove()}>
              <Trash2 size={16} />
            </button>
            <button
              className="tb-btn"
              title="More"
              onClick={(e) =>
                openMenu(e.currentTarget.getBoundingClientRect(), [
                  ...(canCompare
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
                  { label: chrome ? 'Hide Controls' : 'Show Controls', shortcut: 'H', onClick: () => setChrome(!chrome) },
                  { label: fullscreen ? 'Exit Full Screen' : 'Enter Full Screen', shortcut: 'F', onClick: () => api.win.fullscreen() },
                  { separator: true },
                  ...assetMenu([a.id], { viewer: true })
                ], 'right')
              }
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
          <button className="edit-pill glass" title="Edit (Enter)" onClick={() => openEditor(a.id)}>Edit</button>
        </div>
      </div>

      <Stage
        key={`${a.id}`}
        a={a}
        d={d}
        showOriginal={original}
        liveStyle={liveStyle}
        chrome={chrome}
        fullscreen={fullscreen}
        intro={a.id === origin?.id ? intro : null}
        outro={closing}
        onTap={() => setChrome((c) => !c)}
        onActivity={(playing) => {
          playingRef.current = playing
          window.clearTimeout(idleTimer.current)
          if (playing) idleTimer.current = window.setTimeout(() => playingRef.current && setChrome(false), 2200)
          else setChrome(true)
        }}
        onInfoToggle={() => setState({ infoOpen: !infoOpen })}
      />

      <div className={`viewer-foot${chrome ? '' : ' gone'}`} onMouseDown={(e) => e.stopPropagation()}>
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
      {!a.video && (
        <Filmstrip
          ids={viewer.ids}
          index={viewer.index}
          visible={chrome}
          onPick={(i) => setState({ viewer: { ...viewer, index: i }, selection: new Set([viewer.ids[i]]), anchor: viewer.ids[i] })}
        />
      )}
      {infoOpen && chrome && <InfoPanel id={a.id} />}
    </div>
  )
}
