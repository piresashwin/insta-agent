/**
 * Brand-tokenized SceneDoc factories for the studio template picker.
 * All colors use `token:` refs only.
 */

import type { PostFormat } from '../index'
import type { BrandTokens, SceneDoc, SceneLayer, ScenePage } from './schema'

const SCENE_SIZES: Record<PostFormat, { w: number; h: number }> = {
  feed: { w: 1080, h: 1350 },
  reel: { w: 1080, h: 1920 },
  carousel: { w: 1080, h: 1350 },
}

function emptyTokens(): BrandTokens {
  return { colors: {}, fonts: {} }
}

function newPageId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function newLayerId(): string {
  return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export type TemplateId =
  | 'blank'
  | 'hook_poster'
  | 'quote_card'
  | 'tip_stack'
  | 'cover_cta'
  | 'split_band'
  | 'minimal_type'
  | 'scrim_story'
  | 'carousel_cover'
  | 'carousel_tip'
  | 'reel_hook'

export type TemplateMeta = {
  id: TemplateId
  label: string
  formats: PostFormat[]
}

export const TEMPLATE_CATALOG: TemplateMeta[] = [
  { id: 'blank', label: 'Blank', formats: ['feed', 'carousel', 'reel'] },
  { id: 'hook_poster', label: 'Hook poster', formats: ['feed', 'reel'] },
  { id: 'quote_card', label: 'Quote card', formats: ['feed'] },
  { id: 'tip_stack', label: 'Tip stack', formats: ['feed', 'carousel'] },
  { id: 'cover_cta', label: 'Cover + CTA', formats: ['feed', 'carousel'] },
  { id: 'split_band', label: 'Split band', formats: ['feed'] },
  { id: 'minimal_type', label: 'Minimal type', formats: ['feed', 'reel'] },
  { id: 'scrim_story', label: 'Scrim story', formats: ['feed', 'reel'] },
  { id: 'carousel_cover', label: 'Carousel cover', formats: ['carousel'] },
  { id: 'carousel_tip', label: 'Carousel tip', formats: ['carousel'] },
  { id: 'reel_hook', label: 'Reel hook', formats: ['reel'] },
]

function tokensOrEmpty(tokens?: BrandTokens): BrandTokens {
  return tokens ?? emptyTokens()
}

function page(layers: SceneLayer[], bg: ScenePage['background'] = { kind: 'color', color: 'token:background' }): ScenePage {
  return { id: newPageId(), background: bg, layers }
}

function textLayer(opts: {
  name: string
  text: string
  x: number
  y: number
  w: number
  h: number
  fontSize: number
  color?: string
  align?: 'left' | 'center' | 'right'
  weight?: 400 | 600 | 700
}): SceneLayer {
  return {
    id: newLayerId(),
    type: 'text',
    name: opts.name,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    text: opts.text,
    fontSize: opts.fontSize,
    fontFamily: 'token:heading',
    fontWeight: opts.weight ?? 700,
    color: opts.color ?? 'token:primary',
    align: opts.align ?? 'center',
  }
}

function shapeLayer(opts: {
  name: string
  shape: 'rect' | 'ellipse'
  x: number
  y: number
  w: number
  h: number
  fill: string
  scrim?: 'none' | 'bottom' | 'full'
}): SceneLayer {
  return {
    id: newLayerId(),
    type: 'shape',
    name: opts.name,
    shape: opts.shape,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    fill: opts.fill,
    scrim: opts.scrim,
  }
}

function baseDoc(format: PostFormat, tokens: BrandTokens, pages: ScenePage[]): SceneDoc {
  return {
    version: 2,
    format,
    size: SCENE_SIZES[format],
    tokens,
    pages,
    ...(format === 'reel' ? { timeline: { durationSec: 8, coverFrameSec: 0 } } : {}),
  }
}

function blank(format: PostFormat, tokens: BrandTokens): SceneDoc {
  return baseDoc(format, tokens, [page([])])
}

function hookPoster(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES[format]
  return baseDoc(format, tokens, [
    page([
      textLayer({
        name: 'Hook',
        text: 'Your hook goes here',
        x: Math.round(w * 0.08),
        y: Math.round(h * 0.35),
        w: Math.round(w * 0.84),
        h: Math.round(h * 0.25),
        fontSize: format === 'reel' ? 72 : 64,
      }),
    ]),
  ])
}

function quoteCard(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES[format]
  return baseDoc(format, tokens, [
    page([
      shapeLayer({
        name: 'Accent bar',
        shape: 'rect',
        x: Math.round(w * 0.08),
        y: Math.round(h * 0.28),
        w: 8,
        h: Math.round(h * 0.3),
        fill: 'token:accent',
      }),
      textLayer({
        name: 'Quote',
        text: '"A short quotable line."',
        x: Math.round(w * 0.14),
        y: Math.round(h * 0.3),
        w: Math.round(w * 0.72),
        h: Math.round(h * 0.28),
        fontSize: 48,
        align: 'left',
        color: 'token:primary',
      }),
    ]),
  ])
}

function tipStack(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES[format]
  return baseDoc(format, tokens, [
    page([
      textLayer({
        name: 'Title',
        text: '3 tips',
        x: Math.round(w * 0.08),
        y: Math.round(h * 0.12),
        w: Math.round(w * 0.84),
        h: Math.round(h * 0.12),
        fontSize: 56,
      }),
      textLayer({
        name: 'Tip 1',
        text: '1. Keep it concrete',
        x: Math.round(w * 0.1),
        y: Math.round(h * 0.35),
        w: Math.round(w * 0.8),
        h: Math.round(h * 0.1),
        fontSize: 36,
        weight: 600,
        color: 'token:secondary',
        align: 'left',
      }),
      textLayer({
        name: 'Tip 2',
        text: '2. Show the outcome',
        x: Math.round(w * 0.1),
        y: Math.round(h * 0.48),
        w: Math.round(w * 0.8),
        h: Math.round(h * 0.1),
        fontSize: 36,
        weight: 600,
        color: 'token:secondary',
        align: 'left',
      }),
      textLayer({
        name: 'Tip 3',
        text: '3. End with a next step',
        x: Math.round(w * 0.1),
        y: Math.round(h * 0.61),
        w: Math.round(w * 0.8),
        h: Math.round(h * 0.1),
        fontSize: 36,
        weight: 600,
        color: 'token:secondary',
        align: 'left',
      }),
    ]),
  ])
}

function coverCta(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES[format]
  return baseDoc(format, tokens, [
    page([
      textLayer({
        name: 'Hook',
        text: 'Big idea',
        x: Math.round(w * 0.08),
        y: Math.round(h * 0.28),
        w: Math.round(w * 0.84),
        h: Math.round(h * 0.2),
        fontSize: 68,
      }),
      shapeLayer({
        name: 'CTA pill',
        shape: 'rect',
        x: Math.round(w * 0.25),
        y: Math.round(h * 0.72),
        w: Math.round(w * 0.5),
        h: Math.round(h * 0.08),
        fill: 'token:accent',
      }),
      textLayer({
        name: 'CTA',
        text: 'Learn more',
        x: Math.round(w * 0.25),
        y: Math.round(h * 0.73),
        w: Math.round(w * 0.5),
        h: Math.round(h * 0.06),
        fontSize: 28,
        color: 'token:background',
        weight: 600,
      }),
    ]),
  ])
}

function splitBand(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES[format]
  return baseDoc(format, tokens, [
    page([
      shapeLayer({
        name: 'Band',
        shape: 'rect',
        x: 0,
        y: Math.round(h * 0.55),
        w,
        h: Math.round(h * 0.45),
        fill: 'token:primary',
      }),
      textLayer({
        name: 'Headline',
        text: 'Split the frame',
        x: Math.round(w * 0.08),
        y: Math.round(h * 0.62),
        w: Math.round(w * 0.84),
        h: Math.round(h * 0.2),
        fontSize: 56,
        color: 'token:background',
      }),
    ]),
  ])
}

function minimalType(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES[format]
  return baseDoc(format, tokens, [
    page([
      textLayer({
        name: 'Line',
        text: 'Less is more',
        x: Math.round(w * 0.1),
        y: Math.round(h * 0.42),
        w: Math.round(w * 0.8),
        h: Math.round(h * 0.12),
        fontSize: 52,
        color: 'token:primary',
      }),
    ], { kind: 'color', color: 'token:background' }),
  ])
}

function scrimStory(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES[format]
  return baseDoc(format, tokens, [
    page([
      shapeLayer({
        name: 'Scrim',
        shape: 'rect',
        x: 0,
        y: 0,
        w,
        h,
        fill: 'token:primary',
        scrim: 'bottom',
      }),
      textLayer({
        name: 'Hook',
        text: 'Story beat',
        x: Math.round(w * 0.08),
        y: Math.round(h * 0.68),
        w: Math.round(w * 0.84),
        h: Math.round(h * 0.18),
        fontSize: 56,
        color: 'token:background',
      }),
    ]),
  ])
}

function carouselCover(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const doc = coverCta(format === 'carousel' ? 'carousel' : format, tokens)
  return { ...doc, format: 'carousel', size: SCENE_SIZES.carousel }
}

function carouselTip(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const doc = tipStack(format === 'carousel' ? 'carousel' : format, tokens)
  return { ...doc, format: 'carousel', size: SCENE_SIZES.carousel }
}

function reelHook(format: PostFormat, tokens: BrandTokens): SceneDoc {
  const { w, h } = SCENE_SIZES.reel
  return baseDoc('reel', tokens, [
    page([
      textLayer({
        name: 'Hook',
        text: 'Watch this',
        x: Math.round(w * 0.08),
        y: Math.round(h * 0.4),
        w: Math.round(w * 0.84),
        h: Math.round(h * 0.2),
        fontSize: 80,
      }),
    ]),
  ])
}

const FACTORIES: Record<TemplateId, (format: PostFormat, tokens: BrandTokens) => SceneDoc> = {
  blank,
  hook_poster: hookPoster,
  quote_card: quoteCard,
  tip_stack: tipStack,
  cover_cta: coverCta,
  split_band: splitBand,
  minimal_type: minimalType,
  scrim_story: scrimStory,
  carousel_cover: carouselCover,
  carousel_tip: carouselTip,
  reel_hook: reelHook,
}

/** Build a SceneDoc from a template id. Colors are token: refs only. */
export function buildTemplate(
  id: TemplateId,
  format: PostFormat,
  tokens?: BrandTokens,
): SceneDoc {
  const t = tokensOrEmpty(tokens)
  const meta = TEMPLATE_CATALOG.find((m) => m.id === id)
  const fmt = meta && !meta.formats.includes(format) ? meta.formats[0] : format
  return FACTORIES[id](fmt, t)
}

export function listTemplates(format?: PostFormat): TemplateMeta[] {
  if (!format) return TEMPLATE_CATALOG
  return TEMPLATE_CATALOG.filter((t) => t.formats.includes(format))
}
