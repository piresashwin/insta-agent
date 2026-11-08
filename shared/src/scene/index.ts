/**
 * Scene schema v2 — the canonical representation for all creative assets.
 * v1 CanvasDoc (text layers only) is auto-upgraded via upgradeCanvasDoc().
 */

import type { PostFormat, CanvasDoc, CanvasLayer, PromptVars } from '../index'
import {
  SceneDocSchema,
  type BrandTokens,
  type SceneBackground,
  type SceneDoc,
  type SceneLayer,
  type ScenePage,
  type SceneShapeLayer,
  type SceneTextLayer,
} from './schema'

export {
  BrandTokensSchema,
  SceneBackgroundSchema,
  SceneDocSchema,
  SceneLayerSchema,
  ScenePageSchema,
  SceneTimelineSchema,
  SceneTextLayerSchema,
  SceneImageLayerSchema,
  SceneShapeLayerSchema,
  SceneDocParseError,
  parseSceneDoc,
  parseSceneDocJson,
  type BrandTokens,
  type SceneBackground,
  type SceneDoc,
  type SceneDocParseIssue,
  type SceneGroupLayer,
  type SceneImageLayer,
  type SceneLayer,
  type SceneLayerBase,
  type ScenePage,
  type SceneShapeLayer,
  type SceneTextLayer,
  type SceneTimeline,
} from './schema'

export { REEL_SAFE, safeZones, type SafeRect, type SafeZones } from './safe-zones'

export {
  resolveToken,
  resolveColor,
  fitText,
  type FitTextInput,
  type FitTextMeasure,
  type FitTextResult,
} from './resolve'

export {
  snapLayer,
  reorder,
  duplicateLayer,
  reorderPages,
  duplicatePage,
  applyScenePatch,
  createHistory,
  historyCurrent,
  pushHistory,
  undoHistory,
  redoHistory,
  canUndo,
  canRedo,
  offBrandColors,
  type SnapGuide,
  type SnapResult,
  type ReorderDir,
  type ScenePatch,
  type HistoryState,
  type OffBrandHit,
} from './editor'

export {
  TEMPLATE_CATALOG,
  buildTemplate,
  listTemplates,
  type TemplateId,
  type TemplateMeta,
} from './templates'

export function emptyTokens(): BrandTokens {
  return { colors: {}, fonts: {} }
}

// ── Size presets ──────────────────────────────────────────────────────────────

export const SCENE_SIZES: Record<PostFormat, { w: number; h: number }> = {
  feed:     { w: 1080, h: 1350 },
  reel:     { w: 1080, h: 1920 },
  carousel: { w: 1080, h: 1350 },
}

export const SCENE_ASPECTS: Record<PostFormat, string> = {
  feed:     '4 / 5',
  reel:     '9 / 16',
  carousel: '4 / 5',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function newPageId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export function newLayerId(): string {
  return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export function defaultSceneDoc(format: PostFormat, tokens?: BrandTokens): SceneDoc {
  const size = SCENE_SIZES[format]
  return {
    version: 2,
    format,
    size,
    tokens: tokens ?? emptyTokens(),
    pages: [
      {
        id: newPageId(),
        background: { kind: 'color', color: '#1a1a2e' },
        layers: [],
      },
    ],
    ...(format === 'reel' ? { timeline: { durationSec: 8, coverFrameSec: 0 } } : {}),
  }
}

// ── v1 → v2 upgrade ───────────────────────────────────────────────────────────

function layerFromV1(l: CanvasLayer, size: { w: number; h: number }): SceneTextLayer {
  return {
    id: l.id,
    type: 'text',
    name: l.type === 'hook' ? 'Hook' : 'Text',
    x: Math.round(l.x * size.w),
    y: 0,
    w: Math.round(l.w * size.w),
    h: Math.round(size.h * 0.15),
    text: l.text,
    fontSize: l.fontSize,
    fontFamily: l.fontFamily ?? null,
    fontWeight: l.weight,
    color: l.color,
    align: l.align,
    shadow: l.shadow,
    startSec: l.startSec ?? null,
    endSec: l.endSec ?? null,
    enterAnim: l.enterAnim ?? null,
    exitAnim: l.exitAnim ?? null,
    animMs: l.animMs ?? null,
  }
}

function imageBackground(url: string, fit: 'cover' | 'contain' = 'cover'): SceneBackground {
  // Until assets are registered, store the URL in assetId (resolved by later render path).
  return {
    kind: 'image',
    assetId: url,
    fit: fit === 'contain' ? 'contain' : 'cover',
    focusX: 0.5,
    focusY: 0.5,
  }
}

function upgradeV1Canvas(doc: CanvasDoc, imageUrl?: string | null): SceneDoc {
  const size = SCENE_SIZES[doc.format]
  const layers: SceneLayer[] = doc.layers.map((l) => layerFromV1(l, size))

  if (doc.scrim && doc.scrim !== 'none') {
    const scrimLayer: SceneShapeLayer = {
      id: newLayerId(),
      name: 'Scrim',
      type: 'shape',
      shape: 'rect',
      x: 0,
      y: doc.scrim === 'bottom' ? Math.round(size.h * 0.55) : 0,
      w: size.w,
      h: doc.scrim === 'bottom' ? Math.round(size.h * 0.45) : size.h,
      fill: 'rgba(0,0,0,0.45)',
      scrim: doc.scrim,
    }
    layers.unshift(scrimLayer)
  }

  const background: SceneBackground = imageUrl
    ? imageBackground(imageUrl, doc.background?.fit)
    : { kind: 'color', color: '#1a1a2e' }

  return {
    version: 2,
    format: doc.format,
    size,
    tokens: emptyTokens(),
    pages: [
      {
        id: newPageId(),
        background,
        layers,
      },
    ],
    ...(doc.format === 'reel' ? { timeline: { durationSec: 8, coverFrameSec: 0 } } : {}),
  }
}

function isSceneDocShaped(value: unknown): value is SceneDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 2
  )
}

/** Upgrade a v1 CanvasDoc (or its JSON string) to SceneDoc v2. Idempotent for v2 docs. */
export function upgradeCanvasDoc(src: CanvasDoc | SceneDoc | string | Record<string, unknown>): SceneDoc {
  const doc: unknown = typeof src === 'string' ? JSON.parse(src) : src

  if (isSceneDocShaped(doc)) {
    const parsed = SceneDocSchema.safeParse(doc)
    if (parsed.success) return parsed.data
    // Malformed v2 — fall through to best-effort default using format if present.
    const format = (doc as SceneDoc).format
    if (format === 'feed' || format === 'reel' || format === 'carousel') {
      return defaultSceneDoc(format)
    }
    return defaultSceneDoc('feed')
  }

  return upgradeV1Canvas(doc as CanvasDoc)
}

export type UpgradePostSlide = {
  position: number
  canvas_json: string | null
  source_image_url?: string | null
  text?: string | null
}

export type UpgradePostInput = {
  format: PostFormat | string | null
  canvas_json?: string | null
  source_image_url?: string | null
  image_url?: string | null
  hook?: string | null
  slides?: UpgradePostSlide[]
  /** Fallback when canvas_json and slides are both empty — the compiled format-template inputs. */
  prompt_vars?: string | null
}

function parsePromptVarsOrNull(raw: string | null | undefined): PromptVars | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as { format?: string }
    if (parsed.format === 'feed' || parsed.format === 'carousel' || parsed.format === 'reel') {
      return parsed as PromptVars
    }
    return null
  } catch {
    return null
  }
}

/** Build a SceneDoc from compiled prompt_vars (used when there is no canvas_json or slides to upgrade). */
function fromPromptVars(vars: PromptVars, imageUrl: string | null): SceneDoc {
  const background: SceneBackground = imageUrl
    ? imageBackground(imageUrl)
    : { kind: 'color', color: '#1a1a2e' }

  if (vars.format === 'carousel') {
    const pages: ScenePage[] = vars.slides.map((slide) => ({
      id: newPageId(),
      background,
      layers: slide.on_image_text ? [seedHookLayer('carousel', slide.on_image_text)] : [],
    }))
    return {
      version: 2,
      format: 'carousel',
      size: SCENE_SIZES.carousel,
      tokens: emptyTokens(),
      pages: pages.length ? pages : [{ id: newPageId(), background, layers: [] }],
    }
  }

  if (vars.format === 'reel') {
    const layers: SceneLayer[] = vars.timed_cues.map((cue) => ({
      ...seedHookLayer('reel', cue.text),
      startSec: cue.startSec,
      endSec: cue.endSec,
      enterAnim: cue.enterAnim ?? null,
      exitAnim: cue.exitAnim ?? null,
    }))
    return {
      version: 2,
      format: 'reel',
      size: SCENE_SIZES.reel,
      tokens: emptyTokens(),
      pages: [{ id: newPageId(), background, layers }],
      timeline: { durationSec: vars.duration, coverFrameSec: 0 },
    }
  }

  // feed
  const layers: SceneLayer[] = vars.hook_on_image ? [seedHookLayer('feed', vars.hook_on_image)] : []
  return {
    version: 2,
    format: 'feed',
    size: SCENE_SIZES.feed,
    tokens: emptyTokens(),
    pages: [{ id: newPageId(), background, layers }],
  }
}

function parseV1OrNull(raw: string | null | undefined): CanvasDoc | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as { version?: number }
    if (parsed.version === 2) return null
    return parsed as CanvasDoc
  } catch {
    return null
  }
}

function seedHookLayer(format: PostFormat, hook: string): SceneTextLayer {
  const size = SCENE_SIZES[format]
  return {
    id: newLayerId(),
    type: 'text',
    name: 'Hook',
    x: Math.round(size.w * 0.08),
    y: Math.round(size.h * 0.08),
    w: Math.round(size.w * 0.84),
    h: Math.round(size.h * 0.2),
    text: hook,
    fontSize: 64,
    fontWeight: 700,
    color: '#ffffff',
    align: 'center',
    shadow: true,
  }
}

/**
 * Build a SceneDoc from a post row + optional carousel slides.
 * Used by the DB backfill; prefers slides → canvas_json → default (+ optional hook).
 */
export function upgradePostToScene(input: UpgradePostInput): SceneDoc {
  const format: PostFormat =
    input.format === 'reel' || input.format === 'carousel' || input.format === 'feed'
      ? input.format
      : 'feed'

  const slides = (input.slides ?? []).slice().sort((a, b) => a.position - b.position)

  if (slides.length > 0) {
    const pages: ScenePage[] = slides.map((slide) => {
      const v1 = parseV1OrNull(slide.canvas_json)
      const imageUrl = slide.source_image_url ?? null
      if (v1) {
        const upgraded = upgradeV1Canvas({ ...v1, format: 'carousel' }, imageUrl)
        return upgraded.pages[0]
      }
      const page: ScenePage = {
        id: newPageId(),
        background: imageUrl
          ? imageBackground(imageUrl)
          : { kind: 'color', color: '#1a1a2e' },
        layers: slide.text ? [seedHookLayer('carousel', slide.text)] : [],
      }
      return page
    })

    return {
      version: 2,
      format: 'carousel',
      size: SCENE_SIZES.carousel,
      tokens: emptyTokens(),
      pages,
    }
  }

  const imageUrl = input.source_image_url ?? input.image_url ?? null
  const v1 = parseV1OrNull(input.canvas_json ?? null)
  if (v1) {
    return upgradeV1Canvas({ ...v1, format }, imageUrl)
  }

  // Also accept a v2 scene already stored in canvas_json by mistake.
  if (input.canvas_json?.trim()) {
    try {
      const parsed = JSON.parse(input.canvas_json) as unknown
      if (isSceneDocShaped(parsed)) return upgradeCanvasDoc(parsed)
    } catch {
      // fall through
    }
  }

  // No canvas_json and no slides — fall back to the compiled prompt_vars.
  const promptVars = parsePromptVarsOrNull(input.prompt_vars)
  if (promptVars) {
    return fromPromptVars(promptVars, imageUrl)
  }

  const doc = defaultSceneDoc(format)
  if (imageUrl) {
    doc.pages[0].background = imageBackground(imageUrl)
  }
  if (input.hook?.trim()) {
    doc.pages[0].layers.push(seedHookLayer(format, input.hook.trim()))
  }
  return doc
}

/** Parse and upgrade scene_json from the DB (may be v1 or v2). */
export function parseSceneJson(raw: string | null | undefined, format: PostFormat): SceneDoc {
  if (!raw?.trim()) return defaultSceneDoc(format)
  try {
    const parsed = JSON.parse(raw) as { version?: number } & Record<string, unknown>
    if (parsed.version === 2) {
      const result = SceneDocSchema.safeParse(parsed)
      if (result.success) return result.data
      return defaultSceneDoc(format)
    }
    return upgradeCanvasDoc(parsed as unknown as CanvasDoc)
  } catch {
    return defaultSceneDoc(format)
  }
}
