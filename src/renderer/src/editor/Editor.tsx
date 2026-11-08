import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Wand2, RotateCcw, FlipHorizontal2, FlipVertical2, Undo2, Redo2, Play, Pause, Volume2, VolumeX, ChevronDown, Lock, Unlock, SplitSquareHorizontal
} from 'lucide-react'
import { api, baseUrl, bumpEditVersion, depthUrl, stripUrl } from '../api'
import { confirmSheet, getState, loadAssets, refreshMeta, setState, toast, useStore } from '../store'
import { AdjustSlider, Segmented, Slider, Spinner } from '../components/Controls'
import { invalidateDetail, useDetail } from '../components/InfoPanel'
import { TrafficLights } from '../components/TitleBar'
import { formatDuration } from '../util'
import {
  ADJUST_GROUPS, ASPECTS, FILTERS, PORTRAIT_APERTURES, emptyRecipe, isIdentity, orientedSize, outputSize,
  type AdjustKey, type CropRect, type EditRecipe, type FilterName
} from '../../../shared/edits'
import { autoEnhance, EditRenderer, sourceMap } from './gl'

type Tab = 'adjust' | 'filters' | 'crop' | 'video' | 'portrait'

interface DepthMap { width: number; height: number; focus: number; matte: boolean; px: Uint8ClampedArray }

/** Disparity under a source-uv point, averaged over a small window so a click lands on the surface, not noise. */
function depthAt(m: DepthMap, u: number, v: number): number {
  const cx = Math.round(clamp01(u) * (m.width - 1))
  const cy = Math.round(clamp01(v) * (m.height - 1))
  const r = Math.max(2, Math.round(m.width / 160))
  let sum = 0
  let n = 0
  for (let y = Math.max(0, cy - r); y <= Math.min(m.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(m.width - 1, cx + r); x++) {
      sum += m.px[(y * m.width + x) * 4]
      n++
    }
  }
  return n ? sum / n / 255 : 0.5
}

const same = (a: EditRecipe, b: EditRecipe): boolean => JSON.stringify(a) === JSON.stringify(b)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function useBox(ref: React.RefObject<HTMLElement | null>) {
  const [s, setS] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setS({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setS({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return s
}

/** Crop rectangle with corner/edge handles, rule-of-thirds grid and aspect locking. */
function CropOverlay({
  w, h, crop, ratio, onChange, onCommit
}: {
  w: number
  h: number
  crop: CropRect
  ratio: number | null
  onChange: (c: CropRect) => void
  onCommit: () => void
}) {
  const [active, setActive] = useState(false)
  const start = (e: React.PointerEvent, mode: string) => {
    e.preventDefault()
    e.stopPropagation()
    setActive(true)
    const x0 = e.clientX
    const y0 = e.clientY
    const c0 = { ...crop }
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / w
      const dy = (ev.clientY - y0) / h
      let { x, y, w: cw, h: ch } = c0
      if (mode === 'move') {
        x = Math.max(0, Math.min(1 - cw, c0.x + dx))
        y = Math.max(0, Math.min(1 - ch, c0.y + dy))
      } else {
        if (mode.includes('l')) { x = Math.min(c0.x + c0.w - 0.05, Math.max(0, c0.x + dx)); cw = c0.x + c0.w - x }
        if (mode.includes('r')) cw = Math.max(0.05, Math.min(1 - c0.x, c0.w + dx))
        if (mode.includes('t')) { y = Math.min(c0.y + c0.h - 0.05, Math.max(0, c0.y + dy)); ch = c0.y + c0.h - y }
        if (mode.includes('b')) ch = Math.max(0.05, Math.min(1 - c0.y, c0.h + dy))
        if (ratio) {
          // ratio is in pixels; convert to normalised units of this frame.
          const k = ratio * (h / w)
          const horizontal = mode === 'l' || mode === 'r'
          if (horizontal || (!mode.includes('t') && !mode.includes('b'))) ch = cw / k
          else if (mode === 't' || mode === 'b') cw = ch * k
          else ch = cw / k
          if (y + ch > 1) { ch = 1 - y; cw = ch * k }
          if (x + cw > 1) { cw = 1 - x; ch = cw / k }
          if (mode.includes('t')) y = c0.y + c0.h - ch
          if (mode.includes('l')) x = c0.x + c0.w - cw
          if (mode === 'l' || mode === 'r') y = Math.max(0, Math.min(1 - ch, c0.y + (c0.h - ch) / 2))
          if (mode === 't' || mode === 'b') x = Math.max(0, Math.min(1 - cw, c0.x + (c0.w - cw) / 2))
        }
      }
      onChange({ x: clamp01(x), y: clamp01(y), w: Math.min(cw, 1 - clamp01(x)), h: Math.min(ch, 1 - clamp01(y)) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setActive(false)
      onCommit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className="crop-layer" style={{ width: w, height: h }}>
      <div
        className={`crop-rect${active ? ' active' : ''}`}
        style={{ left: crop.x * w, top: crop.y * h, width: crop.w * w, height: crop.h * h }}
        onPointerDown={(e) => start(e, 'move')}
      >
        <div className="thirds" />
        {['tl', 'tr', 'bl', 'br'].map((m) => <div key={m} className={`ch corner ${m}`} onPointerDown={(e) => start(e, m)} />)}
        {['t', 'b', 'l', 'r'].map((m) => <div key={m} className={`ch edge ${m}`} onPointerDown={(e) => start(e, m)} />)}
      </div>
    </div>
  )
}

function Trimmer({
  id, video, trim, onChange, onCommit
}: {
  id: number
  video: HTMLVideoElement | null
  trim: { start: number; end: number } | null
  onChange: (t: { start: number; end: number } | null) => void
  onCommit: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)
  useEffect(() => {
    if (!video) return
    const tick = () => force((x) => x + 1)
    video.addEventListener('timeupdate', tick)
    video.addEventListener('loadedmetadata', tick)
    return () => {
      video.removeEventListener('timeupdate', tick)
      video.removeEventListener('loadedmetadata', tick)
    }
  }, [video])
  const dur = video?.duration || 0
  if (!video || !dur) return <div className="trimmer loading"><Spinner size={14} /></div>
  const t = trim ?? { start: 0, end: dur }
  const drag = (e: React.PointerEvent, which: 'start' | 'end' | 'head') => {
    e.preventDefault()
    e.stopPropagation()
    const r = ref.current!.getBoundingClientRect()
    const wasPlaying = !video.paused
    video.pause()
    const move = (ev: PointerEvent) => {
      const s = clamp01((ev.clientX - r.left) / r.width) * dur
      if (which === 'head') {
        video.currentTime = Math.max(t.start, Math.min(t.end, s))
        return
      }
      const next = which === 'start' ? { start: Math.min(s, t.end - 0.3), end: t.end } : { start: t.start, end: Math.max(s, t.start + 0.3) }
      t.start = Math.max(0, next.start)
      t.end = Math.min(dur, next.end)
      video.currentTime = which === 'start' ? t.start : t.end
      onChange(t.start < 0.02 && t.end > dur - 0.02 ? null : { ...t })
    }
    move(e.nativeEvent)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (which !== 'head') video.currentTime = t.start
      if (wasPlaying || which !== 'head') video.play().catch(() => undefined)
      onCommit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const pct = (s: number) => `${(s / dur) * 100}%`
  return (
    <div className="trimmer">
      <button className="tb-btn" onClick={() => (video.paused ? video.play() : video.pause())}>
        {video.paused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}
      </button>
      <div ref={ref} className="trim-track" style={{ backgroundImage: `url("${stripUrl(id)}")` }} onPointerDown={(e) => drag(e, 'head')}>
        <div className="trim-dim l" style={{ width: pct(t.start) }} />
        <div className="trim-dim r" style={{ left: pct(t.end) }} />
        <div className={`trim-frame${trim ? ' on' : ''}`} style={{ left: pct(t.start), width: `calc(${pct(t.end - t.start)})` }}>
          <div className="trim-h l" onPointerDown={(e) => drag(e, 'start')} />
          <div className="trim-h r" onPointerDown={(e) => drag(e, 'end')} />
        </div>
        <div className="trim-head" style={{ left: pct(video.currentTime) }} />
      </div>
      <span className="trim-time">{formatDuration(t.end - t.start)}</span>
    </div>
  )
}

export function Editor() {
  const editor = useStore((s) => s.editor)!
  const asset = useStore((s) => s.assets.find((a) => a.id === editor.id))
  const id = editor.id
  const d = useDetail(id)
  const isVideo = asset?.video ?? d?.kind === 'video'
  const [tab, setTab] = useState<Tab>(editor.tab ?? 'adjust')
  const [depth, setDepth] = useState<DepthMap | null>(null)
  const [recipe, setRecipe] = useState<EditRecipe | null>(null)
  const committed = useRef<EditRecipe | null>(null)
  const initial = useRef<EditRecipe | null>(null)
  const [undo, setUndo] = useState<EditRecipe[]>([])
  const [redo, setRedo] = useState<EditRecipe[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [compare, setCompare] = useState(false)
  const [saving, setSaving] = useState<number | null>(null)
  const [aspect, setAspect] = useState('free')
  const [lockSize, setLockSize] = useState(true)
  const [filterThumbs, setFilterThumbs] = useState<Record<string, string>>({})
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ Light: true, Color: true, Detail: false, Vignette: false })
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const stage = useBox(stageRef)
  const rendererRef = useRef<EditRenderer | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  // Initial recipe: the stored in-app edit, with the library rotation folded in as quarter turns.
  useEffect(() => {
    if (!d || recipe) return
    const base = d.user_edits?.recipe ? structuredClone(d.user_edits.recipe) : emptyRecipe()
    const extra = (((-(d.rotation ?? 0) / 90) % 4) + 4) % 4
    base.rot90 = (base.rot90 + extra) % 4
    committed.current = base
    initial.current = structuredClone(base)
    setRecipe(base)
  }, [d])

  // Load the edit base into WebGL.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !d) return
    let r: EditRenderer
    try {
      r = new EditRenderer(canvas)
    } catch (e) {
      setError((e as Error).message)
      return
    }
    rendererRef.current = r
    let cancelled = false
    if (d.kind === 'photo') {
      api.depth(id).then(async (info) => {
        if (cancelled) return
        if (!info) return setTab((t) => (t === 'portrait' ? 'adjust' : t))
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.src = depthUrl(id)
        await img.decode()
        if (cancelled) return
        r.setDepth(img)
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const g = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!
        g.drawImage(img, 0, 0)
        setDepth({ ...info, width: c.width, height: c.height, px: g.getImageData(0, 0, c.width, c.height).data })
      }).catch(() => undefined)
    }
    return () => {
      cancelled = true
      r.dispose()
      rendererRef.current = null
    }
  }, [d?.id])

  // The iPhone's portrait render is the usual base; re-rendering the depth effect needs the unblurred original.
  const iphonePortrait = !!d?.subtypes.includes('portrait') && !!d?.edited_path
  const needsOriginal = !!recipe?.portrait && !!d?.edited_path
  useEffect(() => {
    const r = rendererRef.current
    if (!r || !d || d.kind !== 'photo') return
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = baseUrl(id, needsOriginal)
    img
      .decode()
      .then(() => {
        if (cancelled || rendererRef.current !== r) return
        r.setSource(img, img.naturalWidth, img.naturalHeight)
        imgRef.current = img
        setReady(true)
        drawRef.current()
      })
      .catch(() => !cancelled && setError('This photo could not be opened for editing.'))
    return () => {
      cancelled = true
    }
  }, [d?.id, needsOriginal])

  // Videos stream frames into the same pipeline.
  useEffect(() => {
    const r = rendererRef.current
    if (!video || !r) return
    let handle = 0
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void }
    const frame = () => {
      if (video.videoWidth) {
        r.setSource(video, video.videoWidth, video.videoHeight, false)
        if (!ready) setReady(true)
        drawRef.current()
      }
      handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(frame) : requestAnimationFrame(frame)
    }
    frame()
    return () => (v.cancelVideoFrameCallback ? v.cancelVideoFrameCallback(handle) : cancelAnimationFrame(handle))
  }, [video, rendererRef.current])

  const srcW = rendererRef.current?.srcW || d?.width || 1
  const srcH = rendererRef.current?.srcH || d?.height || 1
  const oriented = recipe ? orientedSize(srcW, srcH, recipe.rot90) : { w: srcW, h: srcH }
  const cropping = tab === 'crop'
  const frame = recipe && !cropping ? { w: oriented.w * recipe.crop.w, h: oriented.h * recipe.crop.h } : oriented
  const pad = cropping ? 56 : 24
  const fit = stage.w && stage.h ? Math.min((stage.w - pad * 2) / frame.w, (stage.h - pad * 2) / frame.h) : 0
  const dispW = Math.max(1, Math.round(frame.w * fit))
  const dispH = Math.max(1, Math.round(frame.h * fit))

  const drawRef = useRef<() => void>(() => undefined)
  drawRef.current = () => {
    const r = rendererRef.current
    if (!r || !recipe || !r.srcW || !dispW) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    // Comparing against the iPhone's portrait render while the base is the original: approximate it with its own settings.
    const before = needsOriginal && iphonePortrait && depth ? { on: true, aperture: d?.edits?.portrait?.aperture ?? 4.5, focus: depth.focus } : null
    const shown = compare && initial.current ? { ...emptyRecipe(), rot90: recipe.rot90, flipH: recipe.flipH, flipV: recipe.flipV, angle: recipe.angle, crop: recipe.crop, portrait: before } : recipe
    r.draw(shown, Math.round(dispW * dpr), Math.round(dispH * dpr), { crop: cropping ? { x: 0, y: 0, w: 1, h: 1 } : undefined })
  }
  useEffect(() => {
    drawRef.current()
  }, [recipe, dispW, dispH, ready, compare, cropping, video, depth])

  const pt = recipe && depth ? recipe.portrait ?? { on: iphonePortrait, aperture: d?.edits?.portrait?.aperture ?? 4.5, focus: depth.focus } : null
  const setPortrait = (patch: Partial<NonNullable<EditRecipe['portrait']>>, commit = true) =>
    recipe && pt && update({ ...recipe, portrait: { ...pt, ...patch } }, commit)
  const [focusMark, setFocusMark] = useState<{ x: number; y: number; k: number } | null>(null)
  const pickFocus = (e: React.PointerEvent) => {
    const r = rendererRef.current
    if (!recipe || !depth || !r || tab !== 'portrait') return
    const box = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - box.left) / box.width
    const y = (e.clientY - box.top) / box.height
    const m = sourceMap(recipe, r.srcW, r.srcH)
    const focus = depthAt(depth, m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5])
    setFocusMark({ x: e.clientX - box.left, y: e.clientY - box.top, k: Date.now() })
    setPortrait({ focus, on: true })
  }

  // Filter previews, rendered once from a small copy of the photo.
  useEffect(() => {
    if (!ready || !recipe || tab !== 'filters' || Object.keys(filterThumbs).length) return
    const src = imgRef.current ?? video
    if (!src) return
    const c = document.createElement('canvas')
    let r: EditRenderer
    try {
      r = new EditRenderer(c)
    } catch {
      return
    }
    const sw = imgRef.current?.naturalWidth ?? video!.videoWidth
    const sh = imgRef.current?.naturalHeight ?? video!.videoHeight
    r.setSource(src, sw, sh)
    const out: Record<string, string> = {}
    const base = { ...recipe, adjust: {}, filter: null, filterAmount: 1 }
    const o = orientedSize(sw, sh, recipe.rot90)
    const k = 150 / Math.max(o.w * recipe.crop.w, o.h * recipe.crop.h)
    const tw = Math.round(o.w * recipe.crop.w * k)
    const th = Math.round(o.h * recipe.crop.h * k)
    for (const f of [null, ...FILTERS.map((x) => x.name)]) {
      r.draw({ ...base, filter: f }, tw, th)
      out[f ?? 'none'] = c.toDataURL('image/jpeg', 0.85)
    }
    r.dispose()
    setFilterThumbs(out)
  }, [ready, tab])

  const update = useCallback((next: EditRecipe, commit = true) => {
    setRecipe(next)
    if (commit && committed.current && !same(committed.current, next)) {
      setUndo((u) => [...u.slice(-60), committed.current!])
      setRedo([])
      committed.current = next
    }
  }, [])
  const commitNow = useCallback(() => {
    setRecipe((cur) => {
      if (cur && committed.current && !same(committed.current, cur)) {
        setUndo((u) => [...u.slice(-60), committed.current!])
        setRedo([])
        committed.current = cur
      }
      return cur
    })
  }, [])
  const doUndo = () => {
    if (!undo.length || !recipe) return
    const prev = undo[undo.length - 1]
    setUndo(undo.slice(0, -1))
    setRedo([...redo, recipe])
    committed.current = prev
    setRecipe(prev)
  }
  const doRedo = () => {
    if (!redo.length || !recipe) return
    const next = redo[redo.length - 1]
    setRedo(redo.slice(0, -1))
    setUndo([...undo, recipe])
    committed.current = next
    setRecipe(next)
  }

  const dirty = recipe && initial.current ? !same(recipe, initial.current) : false

  const close = useCallback(() => setState({ editor: null }), [])
  const cancel = useCallback(async () => {
    if (dirty && !(await confirmSheet({ title: 'Discard Changes?', message: 'Your edits to this item will be lost.', confirm: 'Discard Changes', danger: true, icon: <Undo2 size={22} /> }))) return
    close()
  }, [dirty, close])

  const save = useCallback(async () => {
    const r = rendererRef.current
    if (!recipe || !r || saving !== null) return
    if (!dirty) return close()
    setSaving(0)
    try {
      const out = outputSize(recipe, r.srcW, r.srcH)
      if (d?.kind === 'photo') {
        if (out.w * out.h > 160e6) throw new Error('The output size is too large.')
        const raw = isIdentity(recipe) ? null : await r.renderFull(recipe, out.w, out.h, (p) => setSaving(p * 0.6))
        setSaving(0.65)
        if (raw) await api.saveEdit(id, recipe, raw, out)
        else await api.revertEdit(id)
      } else {
        const off = api.on('edit:progress', (p) => p.id === id && setSaving(p.p))
        try {
          await api.saveEdit(id, recipe, null, out)
        } finally {
          off()
        }
      }
      bumpEditVersion(id)
      invalidateDetail(id)
      await loadAssets()
      refreshMeta()
      toast(isIdentity(recipe) ? 'Reverted to original' : 'Edits saved · original untouched')
      close()
    } catch (e) {
      setSaving(null)
      toast(`Couldn’t save: ${(e as Error).message.split('\n')[0]}`)
    }
  }, [recipe, saving, dirty, d?.kind, id, close])

  const revert = useCallback(async () => {
    const ok = await confirmSheet({
      title: 'Revert to Original?',
      message: 'All edits made in Photos are removed. The original file was never modified.',
      confirm: 'Revert to Original',
      danger: true,
      icon: <RotateCcw size={22} />
    })
    if (!ok) return
    await api.revertEdit(id)
    bumpEditVersion(id)
    invalidateDetail(id)
    await loadAssets()
    toast('Reverted to original')
    close()
  }, [id, close])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || getState().sheet || getState().menu) return
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return void cancel() }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); return void save() }
      if (ctrl && k === 'z') { e.preventDefault(); return e.shiftKey ? doRedo() : doUndo() }
      if (ctrl && k === 'y') { e.preventDefault(); return doRedo() }
      if (ctrl && k === 'r' && recipe) { e.preventDefault(); return update({ ...recipe, rot90: (recipe.rot90 + (e.altKey ? 1 : 3)) % 4, crop: { x: 0, y: 0, w: 1, h: 1 } }) }
      if (k === 'm' && !ctrl) return setCompare(true)
      if (ctrl) return
      if (k === 'a') setTab('adjust')
      if (k === 'f') setTab('filters')
      if (k === 'c') setTab('crop')
      if (k === 'v' && isVideo) setTab('video')
      if (k === 'p' && depth) setTab('portrait')
      if (k === 'e') runAuto()
    }
    const onUp = (e: KeyboardEvent) => e.key.toLowerCase() === 'm' && setCompare(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onUp)
    }
  })

  const autoValues = useMemo(() => (ready && rendererRef.current && !video ? autoEnhance(rendererRef.current.sample()) : null), [ready])
  const autoOn = !!(recipe && autoValues && Object.entries(autoValues).every(([k, v]) => recipe.adjust[k as AdjustKey] === v))
  const runAuto = () => {
    if (!recipe) return
    const vals = autoValues ?? (rendererRef.current ? autoEnhance(rendererRef.current.sample()) : {})
    if (autoOn) {
      const adjust = { ...recipe.adjust }
      for (const k of Object.keys(vals)) delete adjust[k as AdjustKey]
      update({ ...recipe, adjust })
    } else update({ ...recipe, adjust: { ...recipe.adjust, ...vals } })
  }

  const ratioOf = (id: string): number | null => {
    const a = ASPECTS.find((x) => x.id === id)
    if (!a || a.ratio === null) return null
    return a.ratio === 'original' ? oriented.w / oriented.h : a.ratio
  }
  const applyAspect = (aid: string) => {
    setAspect(aid)
    const ratio = ratioOf(aid)
    if (!recipe || !ratio) return
    // Largest centred rectangle with this pixel ratio.
    let w = 1
    let h = (oriented.w / ratio) / oriented.h
    if (h > 1) {
      h = 1
      w = (oriented.h * ratio) / oriented.w
    }
    update({ ...recipe, crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h }, size: recipe.size ? fitSize(recipe.size.w, ratio) : null })
  }
  const fitSize = (w: number, ratio: number) => ({ w: Math.round(w), h: Math.max(1, Math.round(w / ratio)) })
  const cropAspect = recipe ? (oriented.w * recipe.crop.w) / (oriented.h * recipe.crop.h) : 1
  const natural = recipe ? { w: Math.round(oriented.w * recipe.crop.w), h: Math.round(oriented.h * recipe.crop.h) } : { w: 0, h: 0 }

  const setAdj = (k: AdjustKey, v: number, commit = false) => recipe && update({ ...recipe, adjust: { ...recipe.adjust, [k]: v } }, commit)
  const groupActive = (title: string) => !!recipe && ADJUST_GROUPS.find((g) => g.title === title)!.keys.some((k) => (recipe.adjust[k.key] ?? 0) !== 0)
  const resetGroup = (title: string) => {
    if (!recipe) return
    const adjust = { ...recipe.adjust }
    for (const k of ADJUST_GROUPS.find((g) => g.title === title)!.keys) delete adjust[k.key]
    update({ ...recipe, adjust })
  }

  const hasEdit = !!d?.user_render
  const tabs: { value: Tab; label: string }[] = [
    { value: 'adjust', label: 'Adjust' },
    { value: 'filters', label: 'Filters' },
    { value: 'crop', label: 'Crop' },
    ...(depth ? [{ value: 'portrait' as Tab, label: 'Portrait' }] : []),
    ...(isVideo ? [{ value: 'video' as Tab, label: 'Video' }] : [])
  ]
  const apIndex = pt ? PORTRAIT_APERTURES.reduce((best, f, i) => (Math.abs(f - pt.aperture) < Math.abs(PORTRAIT_APERTURES[best] - pt.aperture) ? i : best), 0) : 0

  return (
    <div className="editor" onMouseDown={(e) => e.stopPropagation()}>
      <TrafficLights />
      <div className="ed-top">
        <div className="ed-left">
          <button className="btn ed-cancel" onClick={cancel}>Cancel</button>
          {hasEdit && <button className="btn ed-revert" onClick={revert}>Revert to Original</button>}
          <div className="tb-group glass">
            <button className="tb-btn" title="Undo (Ctrl+Z)" disabled={!undo.length} onClick={doUndo}><Undo2 size={15} /></button>
            <button className="tb-btn" title="Redo (Ctrl+Shift+Z)" disabled={!redo.length} onClick={doRedo}><Redo2 size={15} /></button>
          </div>
        </div>
        <Segmented<Tab> className="glass ed-tabs" value={tab} onChange={setTab} options={tabs} />
        <div className="ed-right">
          <button
            className={`tb-btn glass compare${compare ? ' on' : ''}`}
            title="Hold to compare with the original (M)"
            onPointerDown={() => setCompare(true)}
            onPointerUp={() => setCompare(false)}
            onPointerLeave={() => setCompare(false)}
          >
            <SplitSquareHorizontal size={15} />
          </button>
          {!isVideo && (
            <button className={`tb-btn glass auto${autoOn ? ' on' : ''}`} title="Auto Enhance (E)" onClick={runAuto}>
              <Wand2 size={15} />
              <span>Auto</span>
            </button>
          )}
          <button className="btn ed-done" disabled={!recipe || saving !== null} onClick={save}>Done</button>
        </div>
      </div>

      <div className="ed-main">
        <div ref={stageRef} className="ed-stage">
          <div
            className={`ed-canvas-wrap${tab === 'portrait' && depth ? ' focus-pick' : ''}`}
            style={{ width: dispW, height: dispH }}
            onPointerDown={pickFocus}
          >
            <canvas ref={canvasRef} style={{ width: dispW, height: dispH, opacity: ready ? 1 : 0 }} />
            {tab === 'portrait' && focusMark && <div key={focusMark.k} className="focus-mark" style={{ left: focusMark.x, top: focusMark.y }} />}
            {cropping && recipe && ready && (
              <CropOverlay
                w={dispW}
                h={dispH}
                crop={recipe.crop}
                ratio={ratioOf(aspect)}
                onChange={(c) => update({ ...recipe, crop: c, size: recipe.size && lockSize ? fitSize(recipe.size.w, (oriented.w * c.w) / (oriented.h * c.h)) : recipe.size }, false)}
                onCommit={commitNow}
              />
            )}
            {compare && <div className="ed-badge">Original</div>}
          </div>
          {!ready && !error && <div className="ed-loading"><Spinner size={20} /><span>Opening full-resolution original…</span></div>}
          {error && <div className="ed-loading">{error}</div>}
          {isVideo && d && (
            <video
              ref={setVideo}
              className="ed-video-src"
              src={baseUrl(id)}
              crossOrigin="anonymous"
              autoPlay
              loop
              playsInline
              muted={recipe?.mute}
              onTimeUpdate={(e) => {
                const v = e.currentTarget
                const t = recipe?.trim
                if (t && (v.currentTime > t.end || v.currentTime < t.start - 0.05)) v.currentTime = t.start
              }}
            />
          )}
          {saving !== null && (
            <div className="ed-saving glass-strong">
              <Spinner size={16} />
              <span>{isVideo ? 'Rendering video…' : 'Saving full-resolution edit…'}</span>
              <div className="progress"><div style={{ width: `${Math.round(saving * 100)}%` }} /></div>
            </div>
          )}
        </div>

        <aside className="ed-side glass">
          {recipe && tab === 'adjust' && (
            <div className="ed-panel">
              {ADJUST_GROUPS.map((g) => (
                <div key={g.title} className="ed-group">
                  <div className="ed-gh" onClick={() => setOpenGroups((o) => ({ ...o, [g.title]: !o[g.title] }))}>
                    <ChevronDown size={13} className={openGroups[g.title] ? '' : 'closed'} />
                    <b>{g.title}</b>
                    {groupActive(g.title) && (
                      <button className="ed-reset" onClick={(e) => { e.stopPropagation(); resetGroup(g.title) }}>Reset</button>
                    )}
                  </div>
                  {openGroups[g.title] &&
                    g.keys.map((k) => (
                      <AdjustSlider
                        key={k.key}
                        label={k.label}
                        min={k.min}
                        value={recipe.adjust[k.key] ?? 0}
                        onChange={(v) => setAdj(k.key, v)}
                        onCommit={commitNow}
                      />
                    ))}
                </div>
              ))}
            </div>
          )}

          {recipe && tab === 'filters' && (
            <div className="ed-panel">
              <div className="filter-grid">
                {[{ name: null as FilterName | null, label: 'Original' }, ...FILTERS].map((f) => (
                  <button key={f.name ?? 'none'} className={`filter-tile${recipe.filter === f.name ? ' on' : ''}`} onClick={() => update({ ...recipe, filter: f.name, filterAmount: 1 })}>
                    <div className="ft-img">{filterThumbs[f.name ?? 'none'] ? <img src={filterThumbs[f.name ?? 'none']} /> : <Spinner size={12} />}</div>
                    <span>{f.label}</span>
                  </button>
                ))}
              </div>
              {recipe.filter && (
                <AdjustSlider
                  label={`${FILTERS.find((f) => f.name === recipe.filter)?.label} Intensity`}
                  min={0}
                  value={recipe.filterAmount}
                  onChange={(v) => update({ ...recipe, filterAmount: v }, false)}
                  onCommit={commitNow}
                />
              )}
            </div>
          )}

          {recipe && tab === 'crop' && (
            <div className="ed-panel">
              <div className="ed-row-btns">
                <button className="tb-btn" title="Rotate 90° anticlockwise (Ctrl+R)" onClick={() => update({ ...recipe, rot90: (recipe.rot90 + 3) % 4, crop: { x: 0, y: 0, w: 1, h: 1 }, size: null })}>
                  <RotateCcw size={16} /> Rotate
                </button>
                <button className="tb-btn" title="Flip horizontal" onClick={() => update({ ...recipe, flipH: !recipe.flipH, crop: { ...recipe.crop, x: 1 - recipe.crop.x - recipe.crop.w } })}>
                  <FlipHorizontal2 size={16} /> Flip
                </button>
                <button className="tb-btn" title="Flip vertical" onClick={() => update({ ...recipe, flipV: !recipe.flipV, crop: { ...recipe.crop, y: 1 - recipe.crop.y - recipe.crop.h } })}>
                  <FlipVertical2 size={16} />
                </button>
              </div>
              <div className="ed-sub">Straighten</div>
              <div className="straighten">
                <Slider
                  min={-45}
                  max={45}
                  step={0.1}
                  reset={0}
                  value={recipe.angle}
                  onChange={(v) => update({ ...recipe, angle: Math.abs(v) < 0.3 ? 0 : v }, false)}
                  onCommit={commitNow}
                />
                <span>{recipe.angle.toFixed(1)}°</span>
              </div>
              <div className="ed-sub">Aspect</div>
              <div className="aspect-grid">
                {ASPECTS.map((a) => (
                  <button key={a.id} className={`aspect${aspect === a.id ? ' on' : ''}`} onClick={() => applyAspect(a.id)}>{a.label}</button>
                ))}
              </div>
              <div className="ed-sub">Size</div>
              <div className="size-row">
                <input
                  type="number"
                  className="text-input"
                  value={recipe.size?.w ?? natural.w}
                  min={16}
                  onChange={(e) => {
                    const w = Math.max(16, Number(e.target.value) || natural.w)
                    update({ ...recipe, size: { w, h: lockSize ? Math.round(w / cropAspect) : recipe.size?.h ?? natural.h } })
                  }}
                />
                <button className="tb-btn" title={lockSize ? 'Proportions locked' : 'Proportions unlocked'} onClick={() => setLockSize(!lockSize)}>
                  {lockSize ? <Lock size={13} /> : <Unlock size={13} />}
                </button>
                <input
                  type="number"
                  className="text-input"
                  value={recipe.size?.h ?? natural.h}
                  min={16}
                  onChange={(e) => {
                    const h = Math.max(16, Number(e.target.value) || natural.h)
                    update({ ...recipe, size: { h, w: lockSize ? Math.round(h * cropAspect) : recipe.size?.w ?? natural.w } })
                  }}
                />
              </div>
              <div className="aspect-grid">
                {[
                  { label: 'Original', v: null as number | null },
                  { label: '4K', v: 3840 },
                  { label: '2K', v: 2048 },
                  { label: '1080p', v: 1920 },
                  { label: '50%', v: -0.5 },
                  { label: '25%', v: -0.25 }
                ].map((p) => (
                  <button
                    key={p.label}
                    className={`aspect${(p.v === null && !recipe.size) ? ' on' : ''}`}
                    onClick={() => {
                      if (p.v === null) return update({ ...recipe, size: null })
                      const long = p.v < 0 ? Math.max(natural.w, natural.h) * -p.v : Math.min(p.v, Math.max(natural.w, natural.h))
                      const w = cropAspect >= 1 ? long : long * cropAspect
                      update({ ...recipe, size: { w: Math.round(w), h: Math.round(w / cropAspect) } })
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="ed-note">
                Output {(recipe.size?.w ?? natural.w).toLocaleString()} × {(recipe.size?.h ?? natural.h).toLocaleString()} px
              </div>
              <button
                className="btn"
                style={{ marginTop: 14, width: '100%' }}
                onClick={() => {
                  setAspect('free')
                  update({ ...recipe, crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, flipH: false, flipV: false, size: null, rot90: initial.current?.rot90 ?? 0 })
                }}
              >
                Reset Crop & Rotation
              </button>
            </div>
          )}

          {recipe && tab === 'portrait' && pt && (
            <div className="ed-panel">
              <div className="pt-head">
                <button className={`pt-pill${pt.on ? ' on' : ''}`} onClick={() => setPortrait({ on: !pt.on })}>Portrait</button>
              </div>
              <div className={`pt-dial${pt.on ? '' : ' off'}`}>
                <span className="pt-f">ƒ{pt.aperture < 10 ? pt.aperture.toFixed(1) : pt.aperture.toFixed(0)}</span>
                <span className="pt-label">Depth</span>
              </div>
              <Slider
                className="pt-slider"
                min={0}
                max={PORTRAIT_APERTURES.length - 1}
                step={1}
                value={apIndex}
                reset={PORTRAIT_APERTURES.indexOf(4.5)}
                onChange={(i) => setPortrait({ aperture: PORTRAIT_APERTURES[i], on: true }, false)}
                onCommit={commitNow}
              />
              <div className="pt-ticks">
                {PORTRAIT_APERTURES.map((f, i) => (
                  <span key={f} className={i === apIndex ? 'on' : [0, 4, 8, 11, 17].includes(i) ? 'major' : ''}>{[0, 4, 8, 11, 17].includes(i) ? f : ''}</span>
                ))}
              </div>
              <div className="pt-ends"><span>More blur</span><span>Less blur</span></div>
              <div className="ed-note" style={{ marginTop: 16 }}>
                Click the photo to choose what stays in focus. The effect is rendered from the original and its depth
                map{depth?.matte ? ' and person matte' : ''}; the original file is never changed.
              </div>
              {recipe.portrait && (
                <button className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => update({ ...recipe, portrait: null })}>
                  {iphonePortrait ? 'Restore iPhone Portrait' : 'Reset Portrait'}
                </button>
              )}
            </div>
          )}

          {recipe && tab === 'video' && (
            <div className="ed-panel">
              <div className="ed-sub">Sound</div>
              <button className={`btn${recipe.mute ? ' primary' : ''}`} style={{ width: '100%' }} onClick={() => update({ ...recipe, mute: !recipe.mute })}>
                {recipe.mute ? <><VolumeX size={14} style={{ verticalAlign: -2 }} /> Muted</> : <><Volume2 size={14} style={{ verticalAlign: -2 }} /> Sound On</>}
              </button>
              <div className="ed-sub">Length</div>
              <div className="ed-note">
                Drag the yellow handles under the video to trim it.{' '}
                {recipe.trim ? `Keeping ${formatDuration(recipe.trim.end - recipe.trim.start)} of ${formatDuration(video?.duration ?? 0)}.` : 'Showing the full clip.'}
              </div>
              {recipe.trim && <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={() => update({ ...recipe, trim: null })}>Reset Trim</button>}
              <div className="ed-note" style={{ marginTop: 14 }}>
                Adjustments, filters and crop apply to the video too. Saving renders a new movie; the original stays untouched.
              </div>
            </div>
          )}
        </aside>
      </div>

      {isVideo && recipe && (
        <div className="ed-bottom">
          <Trimmer
            id={id}
            video={video}
            trim={recipe.trim}
            onChange={(t) => update({ ...recipe, trim: t }, false)}
            onCommit={commitNow}
          />
          <button className="tb-btn glass" onClick={() => video && (video.muted = !video.muted)} title="Preview sound">
            {video?.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        </div>
      )}
    </div>
  )
}
