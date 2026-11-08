/**
 * Auto-layout: brief → schema-valid SceneDoc (token colors only).
 */

import {
  SCENE_SIZES,
  emptyTokens,
  newLayerId,
  newPageId,
  type BrandTokens,
  type PostFormat,
  type SceneDoc,
  type SceneLayer,
  type ScenePage,
} from '@instagram-agent/shared'

export type LayoutBrief = {
  hook: string
  /** Optional supporting lines (one per extra carousel page, or stacked on feed). */
  points?: string[]
  /** Desired carousel page count (2–10). Ignored for feed/reel. */
  pageCount?: number
  cta?: string
}

function page(layers: SceneLayer[], bgColor = 'token:background'): ScenePage {
  return {
    id: newPageId(),
    background: { kind: 'color', color: bgColor },
    layers,
  }
}

function hookLayer(format: PostFormat, text: string): SceneLayer {
  const { w, h } = SCENE_SIZES[format]
  return {
    id: newLayerId(),
    type: 'text',
    name: 'Hook',
    x: Math.round(w * 0.08),
    y: Math.round(h * (format === 'reel' ? 0.38 : 0.32)),
    w: Math.round(w * 0.84),
    h: Math.round(h * 0.22),
    text,
    fontSize: format === 'reel' ? 72 : 64,
    fontFamily: 'token:heading',
    fontWeight: 700,
    color: 'token:primary',
    align: 'center',
    shadow: true,
    ...(format === 'reel'
      ? { startSec: 0.3, endSec: 4, enterAnim: 'fade' as const, exitAnim: 'fade' as const }
      : {}),
  }
}

function pointLayer(format: PostFormat, text: string, index: number): SceneLayer {
  const { w, h } = SCENE_SIZES[format]
  return {
    id: newLayerId(),
    type: 'text',
    name: `Point ${index + 1}`,
    x: Math.round(w * 0.1),
    y: Math.round(h * (0.55 + index * 0.1)),
    w: Math.round(w * 0.8),
    h: Math.round(h * 0.08),
    text,
    fontSize: 36,
    fontFamily: 'token:body',
    fontWeight: 600,
    color: 'token:secondary',
    align: 'left',
  }
}

/**
 * Build a SceneDoc from a creative brief. Colors are token: refs only.
 */
export function autoLayout(
  brief: LayoutBrief,
  tokens: BrandTokens = emptyTokens(),
  format: PostFormat = 'feed',
): SceneDoc {
  const hook = (brief.hook || 'Your hook').trim()
  const points = (brief.points ?? []).map((p) => p.trim()).filter(Boolean)

  if (format === 'carousel') {
    const count = Math.min(10, Math.max(2, brief.pageCount ?? Math.max(2, 1 + points.length)))
    const pages: ScenePage[] = []
    pages.push(page([hookLayer('carousel', hook)]))
    for (let i = 1; i < count; i++) {
      const text = points[i - 1] || `Point ${i}`
      pages.push(page([hookLayer('carousel', text)]))
    }
    if (brief.cta?.trim()) {
      const last = pages[pages.length - 1]
      const { w, h } = SCENE_SIZES.carousel
      last.layers.push({
        id: newLayerId(),
        type: 'text',
        name: 'CTA',
        x: Math.round(w * 0.15),
        y: Math.round(h * 0.75),
        w: Math.round(w * 0.7),
        h: Math.round(h * 0.08),
        text: brief.cta.trim(),
        fontSize: 32,
        fontFamily: 'token:heading',
        fontWeight: 600,
        color: 'token:accent',
        align: 'center',
      })
    }
    return {
      version: 2,
      format: 'carousel',
      size: SCENE_SIZES.carousel,
      tokens,
      pages,
    }
  }

  const layers: SceneLayer[] = [hookLayer(format, hook)]
  if (format === 'feed') {
    points.slice(0, 3).forEach((p, i) => layers.push(pointLayer(format, p, i)))
  }
  if (brief.cta?.trim()) {
    const { w, h } = SCENE_SIZES[format]
    layers.push({
      id: newLayerId(),
      type: 'text',
      name: 'CTA',
      x: Math.round(w * 0.2),
      y: Math.round(h * 0.78),
      w: Math.round(w * 0.6),
      h: Math.round(h * 0.08),
      text: brief.cta.trim(),
      fontSize: 28,
      fontFamily: 'token:heading',
      fontWeight: 600,
      color: 'token:accent',
      align: 'center',
    })
  }

  return {
    version: 2,
    format,
    size: SCENE_SIZES[format],
    tokens,
    pages: [page(layers)],
    ...(format === 'reel' ? { timeline: { durationSec: 8, coverFrameSec: 0.5 } } : {}),
  }
}

export type BackgroundPromptInput = {
  brief: string
  renderStyle?: string | null
  negativePrompt?: string | null
  format: PostFormat
}

/** Pure prompt builder for generate-background studio action. */
export function buildBackgroundPrompt(input: BackgroundPromptInput): {
  prompt: string
  negative: string
  costLabel: string
} {
  const style = (input.renderStyle || 'photoreal').trim()
  const negative =
    (input.negativePrompt || '').trim() ||
    'text, watermark, logo, low quality, blurry, distorted hands'
  const prompt = [
    style,
    input.format === 'reel' ? 'vertical 9:16 frame' : '4:5 social still',
    input.brief.trim(),
    'clean composition, room for overlay text',
  ]
    .filter(Boolean)
    .join(', ')

  return {
    prompt,
    negative,
    costLabel: '~$0.02',
  }
}
