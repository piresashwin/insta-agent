import { useState, useRef, useCallback, useEffect } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Stage, Layer, Text, Rect, Ellipse, Transformer, Image as KonvaImage, Line } from 'react-konva'
import type Konva from 'konva'
import { toast } from 'sonner'
import {
  Type, ImageIcon, Square, Sparkles, ChevronLeft,
  Plus, Trash2, Eye, EyeOff, Lock, Unlock, Undo2, Redo2,
  Layers, Send, Copy, ArrowUp, ArrowDown, LayoutTemplate, Palette, Upload as UploadIcon, Grid3X3, Crop,
  Loader2, Wand2, Bot,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { getPost, getPostScene, savePostScene, createPost, listBrandProfiles, studioAction, agentRun, getRun, getJob, getBudget } from '../api'
import {
  defaultSceneDoc, parseSceneJson, newLayerId, newPageId,
  SCENE_ASPECTS, resolveToken, safeZones,
  snapLayer, reorder, duplicateLayer, buildTemplate, reorderPages, duplicatePage,
  createHistory, pushHistory, undoHistory, redoHistory,
  historyCurrent, canUndo as historyCanUndo, canRedo as historyCanRedo,
  type HistoryState,
  type SceneDoc, type ScenePage, type SceneLayer,
  type SceneTextLayer, type SceneShapeLayer, type SceneImageLayer,
  type BrandTokens, type TemplateId, type SnapGuide,
  type PostFormat,
} from '@instagram-agent/shared'
import { BrandKitPanel } from '../components/studio/BrandKitPanel'
import { TemplatePicker } from '../components/studio/TemplatePicker'
import { UploadPanel } from '../components/studio/UploadPanel'
import { Inspector } from '../components/studio/Inspector'
import { FeedView } from '../components/studio/FeedView'
import { ReelTimeline } from '../components/studio/ReelTimeline'
import { tokensFromIdentity, parseVisualIdentity } from '../components/studio/brandTokens'

// ─── History — thin React wrapper over shared scene/editor history helpers ────

function useHistory(initial: SceneDoc) {
  const [history, setHistory] = useState<HistoryState>(() => createHistory(initial))

  const push = useCallback((next: SceneDoc) => {
    setHistory((h) => pushHistory(h, next))
  }, [])

  const reset = useCallback((next: SceneDoc) => {
    setHistory(createHistory(next))
  }, [])

  const undo = useCallback(() => setHistory((h) => undoHistory(h)), [])
  const redo = useCallback(() => setHistory((h) => redoHistory(h)), [])

  return {
    doc: historyCurrent(history),
    push,
    reset,
    undo,
    redo,
    canUndo: historyCanUndo(history),
    canRedo: historyCanRedo(history),
  }
}

/** Manual HTMLImageElement loader — no use-image dep; Konva Image needs a real element. */
function useHtmlImage(url?: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!url) {
      setImg(null)
      return
    }
    const el = new window.Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => setImg(el)
    el.onerror = () => setImg(null)
    el.src = url
  }, [url])
  return img
}

// ─── Layer nodes ──────────────────────────────────────────────────────────────

function TextLayerNode({
  layer, scale, tokens, onSelect, onDragMove, onDragEnd, onTransformEnd,
}: {
  layer: SceneTextLayer
  scale: number
  tokens: BrandTokens
  onSelect: (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void
  onDragMove: (x: number, y: number) => { x: number; y: number }
  onDragEnd: (x: number, y: number) => void
  onTransformEnd: (attrs: Partial<SceneTextLayer>) => void
}) {
  const ref = useRef<Konva.Text>(null)
  return (
    <Text
      ref={ref}
      id={layer.id}
      name={layer.id}
      x={layer.x * scale}
      y={layer.y * scale}
      width={layer.w * scale}
      text={layer.text}
      fontSize={(layer.fontSize ?? 48) * scale}
      fontFamily={resolveToken(layer.fontFamily ?? 'token:heading', tokens) || 'DM Sans'}
      fontStyle={layer.fontWeight === 700 ? 'bold' : layer.fontWeight === 600 ? '600' : 'normal'}
      fill={resolveToken(layer.color, tokens)}
      align={layer.align ?? 'center'}
      opacity={layer.visible === false ? 0.3 : (layer.opacity ?? 1)}
      draggable={!layer.lock}
      onClick={onSelect}
      onTap={onSelect}
      onDragMove={(e) => {
        const snapped = onDragMove(e.target.x() / scale, e.target.y() / scale)
        e.target.position({ x: snapped.x * scale, y: snapped.y * scale })
      }}
      onDragEnd={(e) => onDragEnd(e.target.x() / scale, e.target.y() / scale)}
      onTransformEnd={() => {
        const node = ref.current
        if (!node) return
        onTransformEnd({
          x: node.x() / scale,
          y: node.y() / scale,
          w: (node.width() * node.scaleX()) / scale,
          fontSize: (layer.fontSize ?? 48) * node.scaleY(),
        })
        node.scaleX(1)
        node.scaleY(1)
      }}
    />
  )
}

function ShapeLayerNode({
  layer, scale, tokens, onSelect, onDragMove, onDragEnd,
}: {
  layer: SceneShapeLayer
  scale: number
  tokens: BrandTokens
  onSelect: (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void
  onDragMove: (x: number, y: number) => { x: number; y: number }
  onDragEnd: (x: number, y: number) => void
}) {
  const fill = layer.fill ? resolveToken(layer.fill, tokens) : 'rgba(0,0,0,0.4)'
  const props = {
    id: layer.id,
    name: layer.id,
    opacity: layer.visible === false ? 0.3 : (layer.opacity ?? 1),
    fill,
    stroke: layer.stroke ? resolveToken(layer.stroke, tokens) : undefined,
    strokeWidth: layer.strokeWidth,
    draggable: !layer.lock,
    onClick: onSelect,
    onTap: onSelect,
    onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => {
      const snapped = onDragMove(e.target.x() / scale, e.target.y() / scale)
      e.target.position({ x: snapped.x * scale, y: snapped.y * scale })
    },
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onDragEnd(e.target.x() / scale, e.target.y() / scale),
  }
  if (layer.shape === 'ellipse') {
    return (
      <Ellipse
        {...props}
        radiusX={(layer.w / 2) * scale}
        radiusY={(layer.h / 2) * scale}
        x={(layer.x + layer.w / 2) * scale}
        y={(layer.y + layer.h / 2) * scale}
      />
    )
  }
  return (
    <Rect
      {...props}
      x={layer.x * scale}
      y={layer.y * scale}
      width={layer.w * scale}
      height={layer.h * scale}
      cornerRadius={layer.cornerRadius}
    />
  )
}

function ImageLayerNode({
  layer, scale, onSelect, onDragMove, onDragEnd,
}: {
  layer: SceneImageLayer
  scale: number
  onSelect: (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void
  onDragMove: (x: number, y: number) => { x: number; y: number }
  onDragEnd: (x: number, y: number) => void
}) {
  const img = useHtmlImage(layer.url)
  if (!img) {
    return (
      <Rect
        id={layer.id}
        name={layer.id}
        x={layer.x * scale}
        y={layer.y * scale}
        width={layer.w * scale}
        height={layer.h * scale}
        fill="#374151"
        draggable={!layer.lock}
        onClick={onSelect}
        onTap={onSelect}
      />
    )
  }
  return (
    <KonvaImage
      id={layer.id}
      name={layer.id}
      image={img}
      x={layer.x * scale}
      y={layer.y * scale}
      width={layer.w * scale}
      height={layer.h * scale}
      opacity={layer.visible === false ? 0.3 : (layer.opacity ?? 1)}
      cornerRadius={layer.cornerRadius}
      draggable={!layer.lock}
      onClick={onSelect}
      onTap={onSelect}
      onDragMove={(e) => {
        const snapped = onDragMove(e.target.x() / scale, e.target.y() / scale)
        e.target.position({ x: snapped.x * scale, y: snapped.y * scale })
      }}
      onDragEnd={(e) => onDragEnd(e.target.x() / scale, e.target.y() / scale)}
    />
  )
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

function SceneCanvas({
  doc, pageIndex, selectedIds, onSelectLayer, onLayerDragEnd, onLayerTransformEnd, guides, showSafeZones,
}: {
  doc: SceneDoc
  pageIndex: number
  selectedIds: string[]
  onSelectLayer: (id: string | null, additive: boolean) => void
  onLayerDragEnd: (layerId: string, x: number, y: number) => void
  onLayerTransformEnd: (layerId: string, attrs: Partial<SceneTextLayer>) => void
  guides: SnapGuide[]
  showSafeZones?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const transformerRef = useRef<Konva.Transformer>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [containerW, setContainerW] = useState(400)
  const [liveGuides, setLiveGuides] = useState<SnapGuide[]>([])

  const page = doc.pages[pageIndex]
  const { w: docW, h: docH } = doc.size
  const scale = containerW / docW
  const stageH = docH * scale

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerW(el.offsetWidth))
    ro.observe(el)
    setContainerW(el.offsetWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const tr = transformerRef.current
    const stage = stageRef.current
    // Guard against refs that aren't real Konva nodes (e.g. a test environment
    // stubbing react-konva with plain DOM elements) as well as normal ref timing.
    if (!tr || !stage || typeof tr.nodes !== 'function' || typeof stage.findOne !== 'function') return
    const nodes = selectedIds
      .map((id) => stage.findOne(`#${CSS.escape(id)}`))
      .filter(Boolean) as Konva.Node[]
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  }, [selectedIds, page?.layers])

  if (!page) return null

  const bg = page.background
  const showGuides = liveGuides.length ? liveGuides : guides

  function snapDuringDrag(layerId: string, x: number, y: number) {
    const layer = page.layers.find((l) => l.id === layerId)
    if (!layer) return { x, y }
    const others = page.layers.filter((l) => l.id !== layerId)
    const result = snapLayer({ ...layer, x, y }, others, 12)
    setLiveGuides(result.guides)
    return { x: result.x, y: result.y }
  }

  return (
    <div ref={containerRef} className="w-full" style={{ aspectRatio: SCENE_ASPECTS[doc.format] }} data-testid="scene-canvas">
      <Stage
        ref={stageRef}
        width={containerW}
        height={stageH}
        onClick={(e) => {
          if (e.target === e.target.getStage()) onSelectLayer(null, false)
        }}
      >
        <Layer>
          {bg.kind === 'color' && (
            <Rect x={0} y={0} width={containerW} height={stageH} fill={resolveToken(bg.color, doc.tokens)} listening={false} />
          )}

          {page.layers.map((layer) => {
            const onSelect = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
              const additive = !!(e.evt && ('shiftKey' in e.evt) && e.evt.shiftKey)
              onSelectLayer(layer.id, additive)
            }
            const onDragMove = (x: number, y: number) => snapDuringDrag(layer.id, x, y)
            const onDragEnd = (x: number, y: number) => {
              const snapped = snapDuringDrag(layer.id, x, y)
              setLiveGuides([])
              onLayerDragEnd(layer.id, snapped.x, snapped.y)
            }

            if (layer.type === 'text') {
              return (
                <TextLayerNode
                  key={layer.id}
                  layer={layer}
                  scale={scale}
                  tokens={doc.tokens}
                  onSelect={onSelect}
                  onDragMove={onDragMove}
                  onDragEnd={onDragEnd}
                  onTransformEnd={(attrs) => onLayerTransformEnd(layer.id, attrs)}
                />
              )
            }
            if (layer.type === 'shape') {
              return (
                <ShapeLayerNode
                  key={layer.id}
                  layer={layer}
                  scale={scale}
                  tokens={doc.tokens}
                  onSelect={onSelect}
                  onDragMove={onDragMove}
                  onDragEnd={onDragEnd}
                />
              )
            }
            if (layer.type === 'image') {
              return (
                <ImageLayerNode
                  key={layer.id}
                  layer={layer}
                  scale={scale}
                  onSelect={onSelect}
                  onDragMove={onDragMove}
                  onDragEnd={onDragEnd}
                />
              )
            }
            return null
          })}

          {showGuides.map((g, i) => (
            <Line
              key={`${g.orientation}-${g.at}-${i}`}
              points={
                g.orientation === 'v'
                  ? [g.at * scale, 0, g.at * scale, stageH]
                  : [0, g.at * scale, containerW, g.at * scale]
              }
              stroke="#38bdf8"
              strokeWidth={1}
              dash={[4, 4]}
              listening={false}
            />
          ))}

          {showSafeZones && (() => {
            const zones = safeZones(doc.format, doc.size)
            return (
              <>
                {zones.unsafe.map((r, i) => (
                  <Rect
                    key={`unsafe-${i}`}
                    x={r.x * scale}
                    y={r.y * scale}
                    width={r.w * scale}
                    height={r.h * scale}
                    fill="rgba(239,68,68,0.12)"
                    listening={false}
                  />
                ))}
                <Rect
                  x={zones.safeContent.x * scale}
                  y={zones.safeContent.y * scale}
                  width={zones.safeContent.w * scale}
                  height={zones.safeContent.h * scale}
                  stroke="rgba(56,189,248,0.8)"
                  strokeWidth={1}
                  dash={[6, 4]}
                  listening={false}
                />
              </>
            )
          })()}

          <Transformer ref={transformerRef} boundBoxFunc={(_old, neo) => neo} />
        </Layer>
      </Stage>
    </div>
  )
}

// ─── Side panels ──────────────────────────────────────────────────────────────

type ToolTab = 'layers' | 'text' | 'shapes' | 'media' | 'brand' | 'templates' | 'ai'

function ToolRail({ active, onChange }: { active: ToolTab; onChange: (t: ToolTab) => void }) {
  const items: Array<{ key: ToolTab; icon: React.ReactNode; label: string }> = [
    { key: 'layers', icon: <Layers size={18} />, label: 'Layers' },
    { key: 'text', icon: <Type size={18} />, label: 'Text' },
    { key: 'shapes', icon: <Square size={18} />, label: 'Shapes' },
    { key: 'media', icon: <UploadIcon size={18} />, label: 'Media' },
    { key: 'brand', icon: <Palette size={18} />, label: 'Brand' },
    { key: 'templates', icon: <LayoutTemplate size={18} />, label: 'Temps' },
    { key: 'ai', icon: <Sparkles size={18} />, label: 'AI' },
  ]
  return (
    <div className="flex flex-col gap-0.5 w-14 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] py-3 px-1">
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onChange(item.key)}
          title={item.label}
          className={`flex flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] py-2 text-[10px] transition-colors ${
            active === item.key
              ? 'bg-[var(--active)] text-[var(--accent)]'
              : 'text-[var(--muted)] hover:bg-[var(--raised)]'
          }`}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

function LayerPanel({
  page, selectedIds, onSelect, onToggleVisible, onToggleLock, onDelete, onReorder,
}: {
  page: ScenePage
  selectedIds: string[]
  onSelect: (id: string, additive: boolean) => void
  onToggleVisible: (id: string) => void
  onToggleLock: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (id: string, dir: 'up' | 'down') => void
}) {
  const layers = [...page.layers].reverse()

  return (
    <div className="flex flex-col gap-0 overflow-y-auto" data-testid="layer-panel">
      {layers.length === 0 && (
        <p className="text-xs text-[var(--muted)] px-3 py-4 text-center">No layers yet.</p>
      )}
      {layers.map((layer) => {
        const isSelected = selectedIds.includes(layer.id)
        const icon = layer.type === 'text' ? <Type size={12} /> : layer.type === 'shape' ? <Square size={12} /> : <ImageIcon size={12} />
        const label = layer.name ?? (layer.type === 'text' ? (layer as SceneTextLayer).text.slice(0, 20) : layer.type)
        return (
          <div
            key={layer.id}
            data-testid={`layer-row-${layer.id}`}
            className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer border-b border-[var(--rule)] ${isSelected ? 'bg-[var(--active)]' : 'hover:bg-[var(--raised)]'}`}
            onClick={(e) => onSelect(layer.id, e.shiftKey)}
          >
            <span className="text-[var(--muted)]">{icon}</span>
            <span className="flex-1 text-xs truncate text-[var(--text)]">{label}</span>
            <button className="text-[var(--muted)] hover:text-[var(--text)]" onClick={(e) => { e.stopPropagation(); onReorder(layer.id, 'up') }} title="Bring forward">
              <ArrowUp size={11} />
            </button>
            <button className="text-[var(--muted)] hover:text-[var(--text)]" onClick={(e) => { e.stopPropagation(); onReorder(layer.id, 'down') }} title="Send backward">
              <ArrowDown size={11} />
            </button>
            <button className="text-[var(--muted)] hover:text-[var(--text)]" onClick={(e) => { e.stopPropagation(); onToggleVisible(layer.id) }}>
              {layer.visible === false ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
            <button className="text-[var(--muted)] hover:text-[var(--text)]" onClick={(e) => { e.stopPropagation(); onToggleLock(layer.id) }}>
              {layer.lock ? <Lock size={11} /> : <Unlock size={11} />}
            </button>
            <button className="text-[var(--muted)] hover:text-[var(--negative)] ml-1" onClick={(e) => { e.stopPropagation(); onDelete(layer.id) }}>
              <Trash2 size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function AddTextPanel({ onAdd, tokens }: { onAdd: (text: string, fontSize: number, color: string) => void; tokens: BrandTokens }) {
  const [text, setText] = useState('Your text here')
  const [size, setSize] = useState(72)
  const defaultColor = tokens.colors.primary ? 'token:primary' : '#ffffff'
  const [color, setColor] = useState(defaultColor)
  return (
    <div className="p-3 space-y-3">
      <div>
        <label className="block text-xs text-[var(--muted)] mb-1">Text</label>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full h-8 px-2 text-sm border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1">Size</label>
          <input
            type="number"
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-full h-8 px-2 text-sm border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1">Color</label>
          <select
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-full h-8 px-2 text-sm border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
          >
            {Object.keys(tokens.colors).map((n) => (
              <option key={n} value={`token:${n}`}>{n}</option>
            ))}
            <option value="#ffffff">White</option>
          </select>
        </div>
      </div>
      <Button size="sm" className="w-full" onClick={() => onAdd(text, size, color)}>
        Add text layer
      </Button>
    </div>
  )
}

function AddShapePanel({ onAdd }: { onAdd: (shape: 'rect' | 'ellipse', fill: string) => void }) {
  return (
    <div className="p-3 space-y-3">
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" variant="outline" onClick={() => onAdd('rect', 'token:primary')}>Rectangle</Button>
        <Button size="sm" className="flex-1" variant="outline" onClick={() => onAdd('ellipse', 'token:accent')}>Ellipse</Button>
      </div>
    </div>
  )
}

function PageStrip({
  doc, currentPage, onSelect, onAdd, onDelete, onDuplicate, onReorder,
}: {
  doc: SceneDoc
  currentPage: number
  onSelect: (i: number) => void
  onAdd: () => void
  onDelete: (i: number) => void
  onDuplicate: (i: number) => void
  onReorder: (from: number, to: number) => void
}) {
  if (doc.format !== 'carousel') return null
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
      {doc.pages.map((page, i) => (
        <div
          key={page.id}
          className="relative flex-shrink-0 group"
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/plain', String(i))}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const from = Number(e.dataTransfer.getData('text/plain'))
            if (!Number.isNaN(from)) onReorder(from, i)
          }}
        >
          <div
            className={`w-10 h-12 rounded border-2 cursor-pointer transition-colors ${
              i === currentPage ? 'border-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--muted)]'
            }`}
            style={{ background: page.background.kind === 'color' ? resolveToken(page.background.color, doc.tokens) : '#1a1a2e' }}
            onClick={() => onSelect(i)}
          >
            <span className="absolute inset-0 flex items-center justify-center text-white text-[10px] font-semibold">{i + 1}</span>
          </div>
          <div className="absolute -top-1.5 -right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {doc.pages.length < 10 && (
              <button
                title="Duplicate page"
                className="w-4 h-4 rounded-full bg-[var(--accent)] text-white flex items-center justify-center"
                onClick={(e) => { e.stopPropagation(); onDuplicate(i) }}
              >
                <Copy size={9} />
              </button>
            )}
            {doc.pages.length > 1 && (
              <button
                title="Delete page"
                className="w-4 h-4 rounded-full bg-[var(--negative)] text-white flex items-center justify-center"
                onClick={(e) => { e.stopPropagation(); onDelete(i) }}
              >
                <span className="text-[8px]">×</span>
              </button>
            )}
          </div>
        </div>
      ))}
      {doc.pages.length < 10 && (
        <button
          onClick={onAdd}
          className="flex-shrink-0 w-10 h-12 rounded border-2 border-dashed border-[var(--border)] flex items-center justify-center text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  )
}

type EntryTab = 'start' | 'brief' | 'fully-ai'

function EntryPicker({
  onBlank,
  onTemplate,
  onBrief,
  onFullyAI,
  busy,
}: {
  onBlank: (format: PostFormat) => void
  onTemplate: (format: PostFormat, id: TemplateId) => void
  onBrief: (format: PostFormat, brief: string) => void
  onFullyAI: (format: PostFormat, brief: string) => void
  busy?: boolean
}) {
  const [format, setFormat] = useState<PostFormat>('feed')
  const [tab, setTab] = useState<EntryTab>('start')
  const [brief, setBrief] = useState('')

  const TABS: Array<{ key: EntryTab; label: string; icon: React.ReactNode }> = [
    { key: 'start', label: 'From scratch', icon: <LayoutTemplate size={13} /> },
    { key: 'brief', label: 'From a brief', icon: <Wand2 size={13} /> },
    { key: 'fully-ai', label: 'Fully AI', icon: <Bot size={13} /> },
  ]

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-6" data-testid="entry-picker">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-[var(--text)] mb-2">Creative Studio</h1>
        <p className="text-sm text-[var(--muted)]">From scratch, a brief, or fully AI.</p>
      </div>

      <div className="flex gap-2">
        {(['feed', 'carousel', 'reel'] as PostFormat[]).map((fmt) => (
          <button
            key={fmt}
            onClick={() => setFormat(fmt)}
            className={`px-3 py-1.5 rounded-[var(--radius-control)] text-sm capitalize border ${
              format === fmt ? 'border-[var(--accent)] bg-[var(--active)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--muted)]'
            }`}
          >
            {fmt}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`entry-tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-control)] text-xs font-medium border transition-colors ${
              tab === t.key
                ? 'border-[var(--accent)] bg-[var(--active)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'start' && (
        <div className="flex flex-col gap-3 w-full max-w-md">
          <Button className="w-full" onClick={() => onBlank(format)}>Blank {format}</Button>
          <div className="border border-[var(--border)] rounded-[var(--radius-card)] overflow-hidden">
            <TemplatePicker format={format} onPick={(id) => onTemplate(format, id)} />
          </div>
        </div>
      )}

      {tab === 'brief' && (
        <div className="flex flex-col gap-2 w-full max-w-md">
          <p className="text-xs text-[var(--muted)]">
            Describe the hook and any supporting points — auto-layout builds a starting scene.
          </p>
          <textarea
            data-testid="brief-input"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. Grind finer if your espresso tastes sour"
            className="w-full h-20 px-2.5 py-2 text-sm border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)] resize-none"
          />
          <Button
            className="w-full gap-2"
            disabled={!brief.trim() || busy}
            onClick={() => onBrief(format, brief.trim())}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {busy ? 'Building…' : 'Build from brief'}
          </Button>
        </div>
      )}

      {tab === 'fully-ai' && (
        <div className="flex flex-col gap-2 w-full max-w-md">
          <p className="text-xs text-[var(--muted)]">
            Give the agent a topic — it researches, writes and composes a full draft, then opens here to tweak.
          </p>
          <textarea
            data-testid="fully-ai-input"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. Why cold brew tastes different in winter"
            className="w-full h-20 px-2.5 py-2 text-sm border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)] resize-none"
          />
          <Button
            className="w-full gap-2"
            disabled={!brief.trim() || busy}
            onClick={() => onFullyAI(format, brief.trim())}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
            {busy ? 'Starting…' : 'Run fully AI'}
          </Button>
        </div>
      )}
    </div>
  )
}

function GeneratingScreen({ runId }: { runId: number }) {
  const { data } = useQuery({
    queryKey: ['run', runId],
    queryFn: () => getRun(runId),
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? 1500 : false),
  })
  const status = data?.run.status ?? 'running'
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center" data-testid="generating-screen">
      <Loader2 size={28} className="animate-spin text-[var(--accent)]" />
      <div>
        <p className="text-sm font-medium text-[var(--text)]">
          {status === 'failed' ? 'The run failed' : status === 'needs_human' ? 'Needs a look' : 'Writing your post…'}
        </p>
        <p className="text-xs text-[var(--muted)] mt-1">
          {status === 'failed'
            ? data?.run.error || 'Something went wrong — open the post to review.'
            : 'Research → plan → caption → media. This usually takes under a minute.'}
        </p>
      </div>
    </div>
  )
}

// ─── Main editor ──────────────────────────────────────────────────────────────

function StudioEditor({
  postId,
  format,
  initialDoc,
}: {
  postId: number | null
  format: PostFormat
  initialDoc?: SceneDoc
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data: sceneData } = useQuery({
    queryKey: ['scene', postId],
    queryFn: () => getPostScene(postId!),
    enabled: postId !== null && !initialDoc,
  })

  const { data: brandsData } = useQuery({
    queryKey: ['brands'],
    queryFn: listBrandProfiles,
  })

  const { data: postData } = useQuery({
    queryKey: ['post', postId],
    queryFn: () => getPost(postId!),
    enabled: postId !== null,
  })

  const { data: budgetData } = useQuery({
    queryKey: ['budget'],
    queryFn: getBudget,
    staleTime: 30_000,
  })
  const budgetBlocked = !!budgetData?.at_capacity || (budgetData != null && budgetData.remaining < 0.02)
  const budgetBlockReason = budgetBlocked
    ? budgetData?.at_capacity
      ? 'Monthly budget cap reached'
      : `Only $${budgetData?.remaining.toFixed(2) ?? '0'} left this month`
    : null

  const brand = brandsData?.brands.find((b) => b.id === postData?.post.brand_profile_id) ?? brandsData?.brands[0]
  const identity = parseVisualIdentity(brand?.visual_identity)
  const brandTokens = tokensFromIdentity(identity)

  const seed = initialDoc
    ?? (sceneData
      ? parseSceneJson(sceneData.scene_json ?? sceneData.canvas_json, (sceneData.format as PostFormat) || format)
      : defaultSceneDoc(format, brandTokens))

  const { doc, push, reset, undo, redo, canUndo, canRedo } = useHistory(seed)

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [currentPage, setCurrentPage] = useState(0)
  const [toolTab, setToolTab] = useState<ToolTab>('layers')
  const [isDirty, setIsDirty] = useState(false)
  const [showFeed, setShowFeed] = useState(false)
  const [showSafeZones, setShowSafeZones] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const clipboardRef = useRef<SceneLayer[] | null>(null)

  useEffect(() => {
    if (initialDoc) {
      reset({ ...initialDoc, tokens: { ...brandTokens, ...initialDoc.tokens } })
      setIsDirty(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (sceneData && !initialDoc) {
      const loaded = parseSceneJson(sceneData.scene_json ?? sceneData.canvas_json, (sceneData.format as PostFormat) || format)
      reset({
        ...loaded,
        tokens: {
          colors: { ...brandTokens.colors, ...loaded.tokens.colors },
          fonts: { ...brandTokens.fonts, ...loaded.tokens.fonts },
        },
      })
      setIsDirty(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneData])

  const page = doc.pages[currentPage] ?? doc.pages[0]

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!postId) return
      await savePostScene(postId, JSON.stringify(doc))
    },
    onSuccess: () => {
      setIsDirty(false)
      toast.success('Scene saved')
      void qc.invalidateQueries({ queryKey: ['scene', postId] })
    },
    onError: () => toast.error('Failed to save'),
  })

  function updateDoc(next: SceneDoc) {
    push(next)
    setIsDirty(true)
  }

  function updatePage(pageIndex: number, pagePatch: Partial<ScenePage>) {
    updateDoc({
      ...doc,
      pages: doc.pages.map((p, i) => (i === pageIndex ? { ...p, ...pagePatch } : p)),
    })
  }

  function updateLayer(layerId: string, patch: Partial<SceneLayer>) {
    updatePage(currentPage, {
      layers: page.layers.map((l) => (l.id === layerId ? { ...l, ...patch } as SceneLayer : l)),
    })
  }

  function addLayer(layer: SceneLayer) {
    updatePage(currentPage, { layers: [...page.layers, layer] })
    setSelectedIds([layer.id])
  }

  function deleteSelected() {
    if (!selectedIds.length) return
    updatePage(currentPage, { layers: page.layers.filter((l) => !selectedIds.includes(l.id)) })
    setSelectedIds([])
  }

  function duplicateSelected() {
    if (!selectedIds.length) return
    const sources = page.layers.filter((l) => selectedIds.includes(l.id))
    if (!sources.length) return
    const dups = sources.map((l) => duplicateLayer(l))
    updatePage(currentPage, { layers: [...page.layers, ...dups] })
    setSelectedIds(dups.map((d) => d.id))
  }

  function copySelected() {
    const sources = page.layers.filter((l) => selectedIds.includes(l.id))
    if (sources.length) clipboardRef.current = sources
  }

  function pasteClipboard() {
    if (!clipboardRef.current?.length) return
    const dups = clipboardRef.current.map((l) => duplicateLayer(l))
    updatePage(currentPage, { layers: [...page.layers, ...dups] })
    setSelectedIds(dups.map((d) => d.id))
  }

  function selectLayer(id: string | null, additive: boolean) {
    if (!id) {
      setSelectedIds([])
      return
    }
    if (additive) {
      setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    } else {
      setSelectedIds([id])
    }
  }

  function addTextLayer(text: string, fontSize: number, color: string) {
    const { w, h } = doc.size
    addLayer({
      id: newLayerId(),
      type: 'text',
      name: 'Text',
      x: Math.round(w * 0.1),
      y: Math.round(h * 0.4),
      w: Math.round(w * 0.8),
      h: Math.round(h * 0.15),
      text,
      fontSize,
      color,
      align: 'center',
      fontWeight: 700,
      fontFamily: 'token:heading',
    })
    setToolTab('layers')
  }

  function addShapeLayer(shape: 'rect' | 'ellipse', fill: string) {
    const { w, h } = doc.size
    addLayer({
      id: newLayerId(),
      type: 'shape',
      name: shape === 'rect' ? 'Rectangle' : 'Ellipse',
      shape,
      x: Math.round(w * 0.2),
      y: Math.round(h * 0.2),
      w: Math.round(w * 0.6),
      h: Math.round(h * 0.6),
      fill,
    })
    setToolTab('layers')
  }

  function addImageLayer(url: string, assetId?: string) {
    const { w, h } = doc.size
    addLayer({
      id: newLayerId(),
      type: 'image',
      name: 'Image',
      x: Math.round(w * 0.15),
      y: Math.round(h * 0.2),
      w: Math.round(w * 0.7),
      h: Math.round(h * 0.5),
      url,
      assetId,
      fit: 'cover',
    })
    setToolTab('layers')
  }

  function applyTemplate(id: TemplateId) {
    const next = buildTemplate(id, doc.format, brandTokens)
    updateDoc(next)
    setCurrentPage(0)
    setSelectedIds([])
    setToolTab('layers')
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (meta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
      if (meta && e.key === 'd') { e.preventDefault(); duplicateSelected() }
      if (meta && e.key === 'c') { copySelected() }
      if (meta && e.key === 'v') { pasteClipboard() }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        deleteSelected()
      }
      if (meta && e.key === ']') {
        e.preventDefault()
        if (selectedIds[0]) updatePage(currentPage, { layers: reorder(page.layers, selectedIds[0], 'up') })
      }
      if (meta && e.key === '[') {
        e.preventDefault()
        if (selectedIds[0]) updatePage(currentPage, { layers: reorder(page.layers, selectedIds[0], 'down') })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const selectedLayer = page.layers.find((l) => l.id === selectedIds[0]) ?? null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        <button
          onClick={() => navigate({ to: '/inbox' })}
          className="text-[var(--muted)] hover:text-[var(--text)] transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-sm font-medium text-[var(--text)]">
          {postId ? `Post #${postId}` : `New ${format}`}
        </span>
        <div className="flex-1" />

        <button
          data-testid="undo-btn"
          disabled={!canUndo}
          onClick={undo}
          className="p-1.5 rounded text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-30 transition-colors"
          title="Undo"
        >
          <Undo2 size={15} />
        </button>
        <button
          disabled={!canRedo}
          onClick={redo}
          className="p-1.5 rounded text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-30 transition-colors"
          title="Redo"
        >
          <Redo2 size={15} />
        </button>
        <button
          onClick={duplicateSelected}
          disabled={!selectedIds.length}
          className="p-1.5 rounded text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-30 transition-colors"
          title="Duplicate"
        >
          <Copy size={15} />
        </button>
        <button
          onClick={() => setShowFeed((v) => !v)}
          className={`p-1.5 rounded transition-colors ${showFeed ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}
          title="Feed preview"
        >
          <Grid3X3 size={15} />
        </button>
        <button
          data-testid="guides-toggle"
          onClick={() => setShowSafeZones((v) => !v)}
          className={`p-1.5 rounded transition-colors ${showSafeZones ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}
          title="Safe-zone guides"
        >
          <Crop size={15} />
        </button>

        {postId && (
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !isDirty}
            className="gap-1.5"
          >
            <Send size={13} />
            {saveMutation.isPending ? 'Saving…' : isDirty ? 'Save' : 'Saved'}
          </Button>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex border-r border-[var(--border)] shrink-0" style={{ width: 280 }}>
          <ToolRail active={toolTab} onChange={setToolTab} />
          <div className="flex-1 overflow-y-auto bg-[var(--surface)]">
            {toolTab === 'layers' && (
              <LayerPanel
                page={page}
                selectedIds={selectedIds}
                onSelect={selectLayer}
                onToggleVisible={(id) => updateLayer(id, { visible: !(page.layers.find((l) => l.id === id)?.visible ?? true) })}
                onToggleLock={(id) => updateLayer(id, { lock: !(page.layers.find((l) => l.id === id)?.lock ?? false) })}
                onDelete={(id) => {
                  updatePage(currentPage, { layers: page.layers.filter((l) => l.id !== id) })
                  setSelectedIds((ids) => ids.filter((x) => x !== id))
                }}
                onReorder={(id, dir) => updatePage(currentPage, { layers: reorder(page.layers, id, dir) })}
              />
            )}
            {toolTab === 'text' && <AddTextPanel onAdd={addTextLayer} tokens={doc.tokens} />}
            {toolTab === 'shapes' && <AddShapePanel onAdd={addShapeLayer} />}
            {toolTab === 'media' && (
              <UploadPanel
                brandId={brand?.id}
                postId={postId}
                onPick={(asset) => addImageLayer(asset.url, String(asset.id))}
              />
            )}
            {toolTab === 'brand' && (
              <BrandKitPanel
                tokens={doc.tokens}
                logoUrl={identity?.logo_url}
                onApplyColor={(ref) => {
                  if (selectedLayer?.type === 'text') updateLayer(selectedLayer.id, { color: ref } as Partial<SceneTextLayer>)
                  else if (selectedLayer?.type === 'shape') updateLayer(selectedLayer.id, { fill: ref } as Partial<SceneShapeLayer>)
                }}
                onApplyFont={(ref) => {
                  if (selectedLayer?.type === 'text') updateLayer(selectedLayer.id, { fontFamily: ref } as Partial<SceneTextLayer>)
                }}
                onApplyLogo={(url) => addImageLayer(url)}
              />
            )}
            {toolTab === 'templates' && (
              <TemplatePicker format={doc.format} onPick={applyTemplate} />
            )}
            {toolTab === 'ai' && (
              <div className="p-4 space-y-2">
                <p className="text-xs text-[var(--muted)] mb-2">
                  {aiBusy ? 'Generating…' : 'AI actions run with a cost label.'}
                </p>
                {budgetBlocked && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="studio-budget-block">
                    {budgetBlockReason}
                  </p>
                )}
                {(
                  [
                    ['generate-background', 'Generate background', '~$0.02', true],
                    ['variations', '4 variations', '~$0.08', true],
                    ['replace-from-stock', 'Replace from stock', 'free', false],
                    ['rewrite-text', 'Rewrite text', '$0', false],
                    ['punch-up-text', 'Punch-up text', '$0', false],
                    ['alternate-hooks', 'Alternate hooks', '~$0.01', true],
                    ['auto-layout', 'Auto-layout from brief', '$0', false],
                  ] as const
                ).map(([action, label, cost, paid]) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="outline"
                    className="w-full justify-start gap-2"
                    data-testid={`studio-ai-${action}`}
                    title={paid && budgetBlocked ? budgetBlockReason ?? undefined : undefined}
                    disabled={!postId || aiBusy || (paid && budgetBlocked)}
                    onClick={() => {
                      if (!postId) return
                      setAiBusy(true)
                      void (async () => {
                        try {
                          const r = await studioAction(postId, action)
                          let final = r
                          if (r.job_id) {
                            toast.message(`${label}…`, { description: 'Job queued' })
                            for (let i = 0; i < 90; i++) {
                              await new Promise((res) => setTimeout(res, 1000))
                              const { job } = await getJob(r.job_id!)
                              if (job.status === 'done') {
                                const result = (job.result ??
                                  (job.result_json
                                    ? JSON.parse(job.result_json)
                                    : null)) as typeof r | null
                                if (result) final = { ...r, ...result }
                                break
                              }
                              if (job.status === 'failed') {
                                throw new Error(job.error || 'Generation failed')
                              }
                            }
                          }
                          if (final.scene_json) {
                            try {
                              updateDoc(JSON.parse(final.scene_json))
                            } catch { /* ignore */ }
                          }
                          if (
                            action === 'variations' &&
                            final.assets?.length &&
                            !final.scene_json
                          ) {
                            for (const a of final.assets.slice(0, 4)) {
                              if (a.url && !a.url.startsWith('prompt://')) {
                                addImageLayer(a.url)
                              }
                            }
                          }
                          if (final.hooks?.length) {
                            toast.message('Hooks', { description: final.hooks.join(' · ') })
                          } else {
                            toast.success(`${label} · ${final.costLabel}`)
                          }
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : 'Action failed')
                        } finally {
                          setAiBusy(false)
                        }
                      })()
                    }}
                  >
                    {aiBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}{' '}
                    {label} · {cost}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-[var(--raised)] flex flex-col items-center justify-center p-6 gap-4 min-w-0">
          <div
            className="shadow-lg rounded-[var(--radius-media)] overflow-hidden w-full"
            style={{ maxWidth: 420 }}
          >
            <SceneCanvas
              doc={doc}
              pageIndex={currentPage}
              selectedIds={selectedIds}
              onSelectLayer={selectLayer}
              onLayerDragEnd={(id, x, y) => updateLayer(id, { x, y })}
              onLayerTransformEnd={(id, attrs) => updateLayer(id, attrs as Partial<SceneLayer>)}
              guides={[]}
              showSafeZones={showSafeZones}
            />
          </div>
          <p className="text-[11px] text-[var(--muted)]">
            {doc.size.w} × {doc.size.h}px · {doc.format} · Shift+click multi-select · ⌘D duplicate
          </p>
        </div>

        <div
          className="shrink-0 border-l border-[var(--border)] bg-[var(--surface)] overflow-y-auto"
          style={{ width: 220 }}
        >
          <div className="px-3 py-2 border-b border-[var(--rule)]">
            <p className="text-xs font-semibold text-[var(--text)]">Inspector</p>
          </div>
          <Inspector
            layer={selectedLayer}
            doc={doc}
            tokens={doc.tokens}
            onUpdate={(id, patch) => updateLayer(id, patch)}
          />
          {showFeed && <FeedView doc={doc} pageIndex={currentPage} />}
        </div>
      </div>

      {doc.format === 'reel' && (
        <ReelTimeline
          doc={doc}
          onChangeTimeline={(patch) => {
            updateDoc({
              ...doc,
              timeline: {
                durationSec: patch.durationSec ?? doc.timeline?.durationSec ?? 8,
                coverFrameSec: patch.coverFrameSec ?? doc.timeline?.coverFrameSec ?? 0,
              },
            })
          }}
          onChangeLayerTiming={(layerId, startSec, endSec) => {
            updatePage(0, {
              layers: page.layers.map((l) =>
                l.id === layerId ? { ...l, startSec, endSec } : l,
              ),
            })
          }}
        />
      )}

      <PageStrip
        doc={doc}
        currentPage={currentPage}
        onSelect={setCurrentPage}
        onAdd={() => {
          updateDoc({
            ...doc,
            pages: [...doc.pages, { id: newPageId(), background: { kind: 'color', color: 'token:background' }, layers: [] }],
          })
          setCurrentPage(doc.pages.length)
        }}
        onDelete={(i) => {
          if (doc.pages.length <= 1) return
          updateDoc({ ...doc, pages: doc.pages.filter((_, idx) => idx !== i) })
          setCurrentPage(Math.min(i, doc.pages.length - 2))
        }}
        onDuplicate={(i) => {
          if (doc.pages.length >= 10) return
          const dup = duplicatePage(doc.pages[i])
          const pages = doc.pages.slice()
          pages.splice(i + 1, 0, dup)
          updateDoc({ ...doc, pages })
          setCurrentPage(i + 1)
        }}
        onReorder={(from, to) => {
          const pages = reorderPages(doc.pages, from, to)
          if (pages === doc.pages) return
          updateDoc({ ...doc, pages })
          setCurrentPage(to)
        }}
      />
    </div>
  )
}

// ─── Root screen ──────────────────────────────────────────────────────────────

export function StudioScreen() {
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { postId?: string }
  const qc = useQueryClient()

  const rawPostId = params.postId && params.postId !== 'new' ? Number(params.postId) : null

  const [mode, setMode] = useState<
    | { kind: 'entry' }
    | { kind: 'edit'; postId: number | null; format: PostFormat; seed?: SceneDoc }
    | { kind: 'generating'; postId: number; runId: number; format: PostFormat }
  >(rawPostId ? { kind: 'edit', postId: rawPostId, format: 'feed' } : { kind: 'entry' })

  const { data: postData } = useQuery({
    queryKey: ['post', rawPostId],
    queryFn: () => getPost(rawPostId!),
    enabled: rawPostId !== null,
  })

  const { data: brandsData } = useQuery({
    queryKey: ['brands'],
    queryFn: listBrandProfiles,
  })

  useEffect(() => {
    // Skip while a fully-AI run is in flight for this post — otherwise the post
    // query resolving (the post exists as soon as it's created) would jump the
    // screen back to 'edit' before the agent run has produced anything to show.
    if (postData && rawPostId && mode.kind !== 'generating') {
      setMode({ kind: 'edit', postId: rawPostId, format: (postData.post.format as PostFormat) ?? 'feed' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postData, rawPostId])

  const createMutation = useMutation({
    mutationFn: async (opts: { format: PostFormat; templateId?: TemplateId }) => {
      const brand = brandsData?.brands[0]
      const tokens = tokensFromIdentity(parseVisualIdentity(brand?.visual_identity))
      const resp = await createPost(`New ${opts.format}`, {
        format: opts.format,
        brand_profile_id: brand?.id,
      })
      const seed = opts.templateId
        ? buildTemplate(opts.templateId, opts.format, tokens)
        : defaultSceneDoc(opts.format, tokens)
      await savePostScene(resp.post.id, JSON.stringify(seed))
      return { resp, seed, format: opts.format }
    },
    onSuccess: ({ resp, seed, format }) => {
      void qc.invalidateQueries({ queryKey: ['posts'] })
      setMode({ kind: 'edit', postId: resp.post.id, format, seed })
      navigate({ to: '/studio/$postId', params: { postId: String(resp.post.id) } })
    },
    onError: () => toast.error('Failed to create post'),
  })

  // AI-assisted: create a post, then build a starting scene from the brief via auto-layout.
  const briefMutation = useMutation({
    mutationFn: async (opts: { format: PostFormat; brief: string }) => {
      const brand = brandsData?.brands[0]
      const resp = await createPost(opts.brief.slice(0, 80), {
        format: opts.format,
        brand_profile_id: brand?.id,
      })
      const action = await studioAction(resp.post.id, 'auto-layout', { text: opts.brief })
      const seed = action.scene_json ? (JSON.parse(action.scene_json) as SceneDoc) : undefined
      return { resp, seed, format: opts.format }
    },
    onSuccess: ({ resp, seed, format }) => {
      void qc.invalidateQueries({ queryKey: ['posts'] })
      setMode({ kind: 'edit', postId: resp.post.id, format, seed })
      navigate({ to: '/studio/$postId', params: { postId: String(resp.post.id) } })
    },
    onError: () => toast.error('Failed to build from brief'),
  })

  // Fully AI: create a post with the brief as its topic, enqueue the agent run,
  // then show a generating screen until the run finishes — then open the result.
  const fullyAIMutation = useMutation({
    mutationFn: async (opts: { format: PostFormat; brief: string }) => {
      const brand = brandsData?.brands[0]
      const resp = await createPost(opts.brief, {
        format: opts.format,
        brand_profile_id: brand?.id,
      })
      const run = await agentRun(resp.post.id)
      return { postId: resp.post.id, runId: run.run_id, format: opts.format }
    },
    onSuccess: ({ postId, runId, format }) => {
      void qc.invalidateQueries({ queryKey: ['posts'] })
      setMode({ kind: 'generating', postId, runId, format })
      navigate({ to: '/studio/$postId', params: { postId: String(postId) } })
    },
    onError: () => toast.error('Failed to start the agent run'),
  })

  const generatingRunId = mode.kind === 'generating' ? mode.runId : null

  const { data: generatingRun } = useQuery({
    queryKey: ['run', generatingRunId],
    queryFn: () => getRun(generatingRunId!),
    enabled: generatingRunId !== null,
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? 1500 : false),
  })

  useEffect(() => {
    if (mode.kind !== 'generating' || !generatingRun) return
    if (generatingRun.run.status === 'succeeded') {
      void qc.invalidateQueries({ queryKey: ['scene', mode.postId] })
      setMode({ kind: 'edit', postId: mode.postId, format: mode.format })
    }
    // On failure, stay on the generating screen with the error shown —
    // the operator can still navigate to Inbox to inspect/retry the run.
  }, [mode, generatingRun, qc])

  if (mode.kind === 'entry') {
    const busy = createMutation.isPending || briefMutation.isPending || fullyAIMutation.isPending
    return (
      <div className="h-full" style={{ background: 'var(--ground)' }}>
        <EntryPicker
          busy={busy}
          onBlank={(fmt) => createMutation.mutate({ format: fmt })}
          onTemplate={(fmt, id) => createMutation.mutate({ format: fmt, templateId: id })}
          onBrief={(fmt, brief) => briefMutation.mutate({ format: fmt, brief })}
          onFullyAI={(fmt, brief) => fullyAIMutation.mutate({ format: fmt, brief })}
        />
      </div>
    )
  }

  if (mode.kind === 'generating') {
    return (
      <div className="h-full" style={{ background: 'var(--ground)' }}>
        <GeneratingScreen runId={mode.runId} />
      </div>
    )
  }

  return (
    <div className="h-full" style={{ background: 'var(--ground)' }}>
      <StudioEditor postId={mode.postId} format={mode.format} initialDoc={mode.seed} />
    </div>
  )
}
