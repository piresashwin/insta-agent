import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CanvasDoc,
  CanvasLayer,
  CanvasScrim,
  Post,
  PostFormat,
  PostSlide,
} from '@instagram-agent/shared'
import { FORMAT_EXPORT, TEXT_COLORS, defaultCanvasDoc } from '../lib/canvas-doc'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Separator } from './ui/separator'
import { cn } from '../lib/utils'
import { bakeSlidePng, blobToBase64 } from '../lib/canvas-export'

type Props = {
  post: Post
  slides: PostSlide[]
  busy: boolean
  onSaveSlideCanvas: (slideId: number, canvasJson: string) => Promise<void>
  onSavePostCanvas: (canvasJson: string) => Promise<void>
  onAddSlide: () => Promise<void>
  onRemoveSlide: (slideId: number) => Promise<void>
  onFetchPexelsForSlide: (slideId: number) => Promise<void>
  onFetchAiForSlide: (slideId: number) => Promise<void>
  onApproveMedia: (payload: {
    canvas_json: string
    slides: Array<{ position: number; png_base64: string; canvas_json: string }>
  }) => Promise<void>
}

function parseDoc(
  raw: string | null | undefined,
  format: PostFormat,
  hook?: string | null
): CanvasDoc {
  if (!raw) return defaultCanvasDoc(format, hook)
  try {
    const parsed = JSON.parse(raw) as CanvasDoc
    const base = defaultCanvasDoc(format, hook)
    return {
      ...base,
      ...parsed,
      background: { ...base.background, ...(parsed.background || {}) },
      layers: parsed.layers?.length ? parsed.layers : base.layers,
    }
  } catch {
    return defaultCanvasDoc(format, hook)
  }
}

function ToolLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </p>
  )
}

export function PostCanvasEditor({
  post,
  slides,
  busy,
  onSaveSlideCanvas,
  onSavePostCanvas,
  onAddSlide,
  onRemoveSlide,
  onFetchPexelsForSlide,
  onFetchAiForSlide,
  onApproveMedia,
}: Props) {
  const format = (
    post.format === 'reel' || post.format === 'carousel' || post.format === 'feed'
      ? post.format
      : 'feed'
  ) as PostFormat
  const exportFormat: PostFormat =
    format === 'reel' ? 'reel' : format === 'carousel' ? 'carousel' : 'feed'
  const aspect = FORMAT_EXPORT[exportFormat].aspect

  const [activeIdx, setActiveIdx] = useState(0)
  const safeIdx = slides.length === 0 ? 0 : Math.min(activeIdx, slides.length - 1)
  const active = slides[safeIdx] || slides[0]
  const [doc, setDoc] = useState<CanvasDoc>(() =>
    parseDoc(active?.canvas_json, format, post.hook)
  )
  const [selectedId, setSelectedId] = useState<string | null>('hook')
  const [approving, setApproving] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameH, setFrameH] = useState(400)
  const dragRef = useRef<{
    id: string
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)

  useEffect(() => {
    if (activeIdx !== safeIdx) setActiveIdx(safeIdx)
  }, [activeIdx, safeIdx])

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setFrameH(el.clientHeight || 400))
    ro.observe(el)
    setFrameH(el.clientHeight || 400)
    return () => ro.disconnect()
  }, [safeIdx, format])

  useEffect(() => {
    if (!active) return
    // Per-slide canvas only — never fall back to post.canvas_json (another slide's doc).
    const next = parseDoc(active.canvas_json, format, post.hook)
    setDoc(next)
    setSelectedId(next.layers[0]?.id ?? null)
  }, [active?.id, active?.canvas_json, post.hook, format])

  const selected = doc.layers.find((l) => l.id === selectedId) || null

  const scheduleSave = useCallback(
    (next: CanvasDoc) => {
      if (!active) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const json = JSON.stringify(next)
        void onSaveSlideCanvas(active.id, json)
        void onSavePostCanvas(json)
      }, 400)
    },
    [active, onSaveSlideCanvas, onSavePostCanvas]
  )

  function patchDoc(updater: (d: CanvasDoc) => CanvasDoc) {
    setDoc((prev) => {
      const next = updater(prev)
      scheduleSave(next)
      return next
    })
  }

  function patchLayer(id: string, patch: Partial<CanvasLayer>) {
    patchDoc((d) => ({
      ...d,
      layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }))
  }

  function deleteSelected() {
    if (!selected) return
    patchDoc((d) => ({
      ...d,
      layers: d.layers.filter((l) => l.id !== selected.id),
    }))
    setSelectedId(null)
  }

  function placePreset(where: 'top' | 'middle' | 'bottom') {
    if (!selected) return
    const y = where === 'top' ? 0.08 : where === 'middle' ? 0.42 : 0.72
    patchLayer(selected.id, { x: 0.08, y, w: 0.84, align: 'center' })
  }

  function onPointerDown(e: React.PointerEvent, layer: CanvasLayer) {
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(layer.id)
    if (!frameRef.current) return
    dragRef.current = {
      id: layer.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: layer.x,
      origY: layer.y,
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    const frame = frameRef.current
    if (!drag || !frame) return
    const rect = frame.getBoundingClientRect()
    const dx = (e.clientX - drag.startX) / rect.width
    const dy = (e.clientY - drag.startY) / rect.height
    patchLayer(drag.id, {
      x: Math.max(0, Math.min(0.95, drag.origX + dx)),
      y: Math.max(0, Math.min(0.95, drag.origY + dy)),
    })
  }

  function onPointerUp() {
    dragRef.current = null
  }

  const canApprove = useMemo(() => {
    if (slides.length === 0) return false
    if (format === 'carousel' && slides.length < 2) return false
    return slides.every((s) => !!s.source_image_url)
  }, [slides, format])

  async function handleFetch(provider: 'pexels' | 'openai') {
    if (!active) return
    setLocalError(null)
    setFetching(true)
    try {
      if (provider === 'openai') await onFetchAiForSlide(active.id)
      else await onFetchPexelsForSlide(active.id)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Fetch image failed')
    } finally {
      setFetching(false)
    }
  }

  async function handleApprove() {
    if (!canApprove) {
      setLocalError(
        format === 'carousel' && slides.length < 2
          ? 'Carousel needs at least 2 slides with images'
          : 'Every slide needs a source image before approve'
      )
      return
    }
    setLocalError(null)
    setApproving(true)
    try {
      const baked: Array<{ position: number; png_base64: string; canvas_json: string }> = []
      for (const slide of slides) {
        const slideDoc =
          slide.id === active?.id ? doc : parseDoc(slide.canvas_json, format, post.hook)
        if (!slide.source_image_url) {
          throw new Error(`Slide ${slide.position + 1} missing source image`)
        }
        const blob = await bakeSlidePng(slide.source_image_url, slideDoc, exportFormat)
        const b64 = await blobToBase64(blob)
        baked.push({
          position: slide.position,
          png_base64: b64,
          canvas_json: JSON.stringify(slideDoc),
        })
      }
      await onApproveMedia({
        canvas_json: JSON.stringify(doc),
        slides: baked,
      })
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Approve media failed')
    } finally {
      setApproving(false)
    }
  }

  // Carousel: never fall back to post-level image (that belongs to slide 0 / cover).
  const sourceUrl =
    active?.source_image_url ||
    (format === 'carousel' ? null : post.source_image_url || post.image_url)
  const displayUrl = sourceUrl
    ? `${sourceUrl}${sourceUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(
        active?.updated_at || post.updated_at || sourceUrl
      )}`
    : null
  const fit = doc.background?.fit || 'cover'
  const scrim = (doc.scrim || 'none') as CanvasScrim
  const locked = post.status === 'staged'
  const slidesWithSource = slides.filter((s) => !!s.source_image_url).length

  return (
    <div className="mt-4 overflow-hidden rounded-sm border border-border bg-card">
      {/* Compose chrome */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-rule">
            Compose
          </span>
          <Badge className="bg-muted text-muted-foreground uppercase tracking-wide">
            {format}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Drag text on the proof · tools on the right
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            disabled={busy || fetching || !active}
            onClick={() => void handleFetch('openai')}
          >
            {fetching ? 'Generating…' : 'AI image'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || fetching || !active}
            onClick={() => void handleFetch('pexels')}
          >
            {displayUrl ? 'Pexels image' : 'Fetch Pexels'}
          </Button>
          <Button
            size="sm"
            disabled={busy || approving || locked}
            title={!canApprove ? 'Need source image on every slide' : undefined}
            onClick={() => void handleApprove()}
          >
            {approving ? 'Baking & uploading…' : locked ? 'Media approved' : 'Approve media'}
          </Button>
        </div>
      </div>

      {localError && (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-red-50 px-3 py-2 text-sm text-destructive"
        >
          {localError}
        </div>
      )}

      {!canApprove && !locked && (
        <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          {format === 'carousel'
            ? `${slidesWithSource}/${slides.length} slides have images — fetch per slide or use Generate in the dialog to fill all.`
            : 'Fetch an image first — approve bakes the proof and stages it for publish.'}
        </div>
      )}

      {format === 'carousel' && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-2">
          <ToolLabel>Slides</ToolLabel>
          {slides.map((s, i) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => setActiveIdx(i)}
              title={s.source_image_url ? `Slide ${i + 1}` : `Slide ${i + 1} — needs image`}
              className={cn(
                'relative flex h-9 w-9 items-center justify-center rounded-sm border text-xs font-semibold tabular-nums',
                i === safeIdx
                  ? 'border-rule bg-card text-foreground'
                  : 'border-border bg-card/60 text-muted-foreground hover:border-rule/50'
              )}
            >
              {i + 1}
              <span
                className={cn(
                  'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-card',
                  s.source_image_url ? 'bg-ok' : 'bg-amber-500'
                )}
              />
            </button>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || slides.length >= 10}
            onClick={() => void onAddSlide()}
          >
            Add
          </Button>
          {slides.length > 2 && active && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onRemoveSlide(active.id)}
            >
              Remove
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_280px]">
        {/* Stage */}
        <div className="flex flex-col items-center justify-center gap-3 bg-[#e8eef4] px-4 py-6">
          <div
            ref={frameRef}
            className="relative w-full max-w-[320px] overflow-hidden border border-rule/40 bg-black shadow-[0_8px_24px_rgba(21,25,30,0.12)]"
            style={{ aspectRatio: aspect }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={() => setSelectedId(null)}
          >
            {displayUrl ? (
              <img
                key={displayUrl}
                src={displayUrl}
                alt=""
                className={cn(
                  'absolute inset-0 h-full w-full',
                  fit === 'contain' ? 'object-contain' : 'object-cover'
                )}
                style={{
                  objectPosition: `${(doc.background?.focusX ?? 0.5) * 100}% ${(doc.background?.focusY ?? 0.5) * 100}%`,
                }}
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-xs text-white/70">No image on this proof</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  <Button size="sm" disabled={busy || !active} onClick={() => void handleFetch('openai')}>
                    AI image
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !active}
                    onClick={() => void handleFetch('pexels')}
                  >
                    Pexels
                  </Button>
                </div>
              </div>
            )}
            {scrim === 'full' && <div className="pointer-events-none absolute inset-0 bg-black/35" />}
            {scrim === 'bottom' && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black/65 to-transparent" />
            )}
            {doc.safeZone && (
              <div className="pointer-events-none absolute inset-[6%] border border-dashed border-white/30" />
            )}
            {doc.layers.map((layer) => (
              <div
                key={layer.id}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => onPointerDown(e, layer)}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'absolute cursor-grab touch-none select-none active:cursor-grabbing',
                  selectedId === layer.id && 'outline outline-1 outline-offset-1 outline-rule'
                )}
                style={{
                  left: `${layer.x * 100}%`,
                  top: `${layer.y * 100}%`,
                  width: `${layer.w * 100}%`,
                  color: layer.color,
                  fontWeight: layer.weight,
                  fontSize: Math.max(10, layer.fontSize * frameH),
                  textAlign: layer.align,
                  textShadow: layer.shadow ? '0 1px 3px rgba(0,0,0,0.7)' : undefined,
                  lineHeight: 1.2,
                }}
              >
                <span className="block text-[length:inherit] leading-[inherit]">
                  {layer.text || ' '}
                </span>
              </div>
            ))}
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            {FORMAT_EXPORT[exportFormat].width}×{FORMAT_EXPORT[exportFormat].height}
            {locked ? ' · staged' : ''}
          </p>
        </div>

        {/* Tools rail */}
        <aside className="flex flex-col gap-4 border-t border-border p-3 lg:border-l lg:border-t-0">
          <section className="space-y-2">
            <ToolLabel>Image</ToolLabel>
            <div className="flex flex-wrap gap-1">
              {(['cover', 'contain'] as const).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant={fit === f ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() =>
                    patchDoc((d) => ({
                      ...d,
                      background: { ...d.background, fit: f },
                    }))
                  }
                >
                  {f}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {(['none', 'bottom', 'full'] as CanvasScrim[]).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={scrim === s ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => patchDoc((d) => ({ ...d, scrim: s }))}
                >
                  Scrim {s}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => patchDoc((d) => ({ ...d, safeZone: !d.safeZone }))}
            >
              Safe zone {doc.safeZone ? 'on' : 'off'}
            </Button>
            <label className="block space-y-1">
              <span className="text-[10px] text-muted-foreground">Focus X</span>
              <Input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={doc.background?.focusX ?? 0.5}
                disabled={busy}
                onChange={(e) =>
                  patchDoc((d) => ({
                    ...d,
                    background: { ...d.background, focusX: Number(e.target.value) },
                  }))
                }
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-muted-foreground">Focus Y</span>
              <Input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={doc.background?.focusY ?? 0.5}
                disabled={busy}
                onChange={(e) =>
                  patchDoc((d) => ({
                    ...d,
                    background: { ...d.background, focusY: Number(e.target.value) },
                  }))
                }
              />
            </label>
          </section>

          <Separator />

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <ToolLabel>Layers</ToolLabel>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const id = `text-${Date.now()}`
                  patchDoc((d) => ({
                    ...d,
                    layers: [
                      ...d.layers,
                      {
                        id,
                        type: 'text',
                        text: 'New text',
                        x: 0.1,
                        y: 0.2,
                        w: 0.8,
                        fontSize: 0.035,
                        align: 'center',
                        color: '#ffffff',
                        weight: 600,
                        shadow: true,
                      },
                    ],
                  }))
                  setSelectedId(id)
                }}
              >
                Add
              </Button>
            </div>
            <ul className="max-h-28 space-y-1 overflow-y-auto">
              {doc.layers.length === 0 && (
                <li className="text-xs text-muted-foreground">No text layers</li>
              )}
              {doc.layers.map((layer) => (
                <li key={layer.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setSelectedId(layer.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm border px-2 py-1.5 text-left text-xs',
                      selectedId === layer.id
                        ? 'border-rule bg-rule/5 text-foreground'
                        : 'border-transparent bg-muted/50 text-muted-foreground hover:border-border'
                    )}
                  >
                    <Badge className="bg-card text-[9px] uppercase text-muted-foreground">
                      {layer.type}
                    </Badge>
                    <span className="line-clamp-1 flex-1">{layer.text || '(empty)'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <Separator />

          <section className="space-y-2">
            <ToolLabel>Selected text</ToolLabel>
            {!selected ? (
              <p className="text-xs text-muted-foreground">Click a layer on the proof or in the list.</p>
            ) : (
              <>
                <Input
                  value={selected.text}
                  disabled={busy}
                  onChange={(e) => patchLayer(selected.id, { text: e.target.value })}
                  placeholder="Layer text"
                />
                <div className="flex flex-wrap gap-1">
                  {(['top', 'middle', 'bottom'] as const).map((p) => (
                    <Button
                      key={p}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => placePreset(p)}
                    >
                      {p}
                    </Button>
                  ))}
                  <Button size="sm" variant="outline" disabled={busy} onClick={deleteSelected}>
                    Delete
                  </Button>
                </div>
                <label className="block space-y-1">
                  <span className="text-[10px] text-muted-foreground">Size</span>
                  <Input
                    type="range"
                    min={0.02}
                    max={0.1}
                    step={0.005}
                    value={selected.fontSize}
                    disabled={busy}
                    onChange={(e) =>
                      patchLayer(selected.id, { fontSize: Number(e.target.value) || 0.045 })
                    }
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-muted-foreground">Width</span>
                  <Input
                    type="range"
                    min={0.3}
                    max={0.95}
                    step={0.05}
                    value={selected.w}
                    disabled={busy}
                    onChange={(e) => patchLayer(selected.id, { w: Number(e.target.value) })}
                  />
                </label>
                <div className="flex flex-wrap gap-1">
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <Button
                      key={a}
                      size="sm"
                      variant={selected.align === a ? 'default' : 'outline'}
                      disabled={busy}
                      onClick={() => patchLayer(selected.id, { align: a })}
                    >
                      {a}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1">
                  {([400, 600, 700] as const).map((w) => (
                    <Button
                      key={w}
                      size="sm"
                      variant={selected.weight === w ? 'default' : 'outline'}
                      disabled={busy}
                      onClick={() => patchLayer(selected.id, { weight: w })}
                    >
                      {w === 400 ? 'Reg' : w === 600 ? 'Semi' : 'Bold'}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant={selected.shadow ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => patchLayer(selected.id, { shadow: !selected.shadow })}
                  >
                    Shadow
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      title={c}
                      disabled={busy}
                      onClick={() => patchLayer(selected.id, { color: c })}
                      className={cn(
                        'h-6 w-6 rounded-sm border border-border',
                        selected.color === c && 'outline outline-2 outline-rule outline-offset-1'
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </>
            )}
          </section>

          {locked && post.image_url && (
            <p className="break-all font-mono text-[10px] text-muted-foreground">
              Staged · {post.image_url}
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
