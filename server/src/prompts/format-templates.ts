/**
 * Deterministic format prompt templates — variables in, full generation prompts out.
 * On-image typography is instructed in the prompt for the model to bake into pixels.
 */
import type {
  BrandProfile,
  CanvasDoc,
  FeedPromptVars,
  CarouselPromptVars,
  Post,
  PostFormat,
  PromptPreview,
  PromptVars,
  ReelPromptVars,
  VisualIdentity,
} from '@instagram-agent/shared'
import {
  DEFAULT_CANVAS_FONT,
  resolveCanvasFontFamily,
} from '@instagram-agent/shared'
import { IG, clampReelDuration, renderedMarginPct, stillCropPctPerSide } from '../instagram-rules'

/** Avoid logos / chrome / invented extra words — lettering itself is requested in the prompt. */
const GENERATION_NEGATIVE =
  'no logos, no watermarks, no crosses/emblems/icons, no UI chrome, no hashtags in the image, no extra invented text beyond the specified on-image copy, nothing clipped by frame edges'

/** Max characters for a compiled reel prompt (Runware accepts 2000; keep headroom). */
export const REEL_PROMPT_MAX = 1900

/** Brand-opt-in emblem: drop the emblem ban from the negative so the two don't contradict. */
function negativeFor(raw: string | undefined, ctx: CompileContext): string {
  const base = (raw || GENERATION_NEGATIVE).trim()
  if (ctx.brandMark !== 'cross') return base
  return base.replace(/crosses\/emblems\/icons/i, 'icons').replace(/crosses\/emblems/i, 'emblems')
}

/** Render look from brand identity. Empty string when unset (caller should guard with assertVisualIdentityReady). */
export function renderStyle(identity: VisualIdentity): string {
  return (identity.render_style || '').trim().slice(0, 80)
}

type Frame = 'still' | 'reel'

/**
 * Feed/carousel stills are rendered taller than 4:5 and center-cropped.
 * Tell the model which band survives and express margins in the rendered frame.
 */
function stillCropNote(): string | null {
  const crop = stillCropPctPerSide()
  if (crop < 1) return null
  const pct = Math.round(crop)
  return `CROP NOTE: this frame is center-cropped to 4:5 after generation — the top ~${pct}% and bottom ~${pct}% are cut off. Keep all lettering, any handle, and the key subject inside the central ${100 - 2 * (pct + 5)}% of the frame height.`
}

/**
 * Reels: Instagram overlays the caption/username/audio row on the bottom ~third and the
 * like/comment/share rail on the right — keep baked text in the clear band.
 */
export function reelPlacement(): string {
  const { topPct, bottomPct, sidePct, rightPct } = IG.reelSafe
  const top = topPct + 4
  const bottom = 100 - bottomPct
  return `Placement (Reels safe zone): text block between ${top}% and ${bottom}% of frame height, ≥${sidePct}% from the left edge and ≥${rightPct + 2}% from the right edge (right rail holds Instagram buttons). NOTHING in the bottom ${bottomPct}% (caption/audio UI) or top ${topPct}% (status/header UI).`
}

export function parseVisualIdentity(raw: string | null | undefined): VisualIdentity {
  if (!raw?.trim()) return {}
  try {
    return JSON.parse(raw) as VisualIdentity
  } catch {
    return {}
  }
}

export function parsePromptVars(raw: string | null | undefined): PromptVars | null {
  if (!raw?.trim()) return null
  try {
    const v = JSON.parse(raw) as PromptVars
    if (v && (v.format === 'feed' || v.format === 'carousel' || v.format === 'reel')) return v
    return null
  } catch {
    return null
  }
}

function paletteString(identity: VisualIdentity, fallback?: string): string {
  const p = identity.palette
  if (!p) return fallback || ''
  return [p.primary, p.secondary, p.accent, p.background].filter(Boolean).join(', ')
}

function defaultFont(identity: VisualIdentity): string {
  return resolveCanvasFontFamily(
    identity.typography?.heading_font || identity.typography?.body_font,
    DEFAULT_CANVAS_FONT
  )
}

/** Drop format-mismatched brand shot rules (e.g. reel overlay rules on a feed still). */
function filterShotLines(lines: string[], format?: PostFormat): string[] {
  return lines.filter((line) => {
    const l = line.toLowerCase()
    if (format === 'feed' || format === 'carousel') {
      if (/\breels?\b/.test(l) && /(overlay|white text|on-screen|scrim behind)/.test(l)) {
        return false
      }
    }
    if (format === 'reel' && /\bcarousel\b/.test(l) && !/\breels?\b/.test(l)) {
      return false
    }
    return true
  })
}

function shotRules(
  identity: VisualIdentity,
  format?: PostFormat
): { must: string; avoid: string } {
  const must = filterShotLines(identity.shot_rules?.must || [], format).join('; ')
  const avoid = filterShotLines(identity.shot_rules?.avoid || [], format).join('; ')
  return { must, avoid }
}

function scrimDescription(scrim: string, frame: 'still' | 'reel' = 'still'): string {
  if (scrim === 'full') return 'soft full-frame dark scrim behind the letters for contrast'
  if (scrim === 'bottom') {
    // Reel text sits in the middle safe band — a bottom scrim would sit under the IG caption UI.
    return frame === 'reel'
      ? 'soft dark gradient band directly behind the text block only'
      : 'soft bottom gradient scrim behind the text only (lower ~35% of frame)'
  }
  return 'no scrim; ensure letters contrast clearly against the scene'
}

/**
 * Strip lettering instructions that agents often bake into "subject" / image_prompt.
 * Lettering SoT is hook_on_image / slide text + typeRecipe — not the subject field.
 */
export function sceneOnlySubject(raw: string, fallback = 'typography-led brand graphic'): string {
  let s = (raw || '').trim()
  if (!s) return fallback
  const cut = s.search(
    /\bPaint this exact|\bexact lettering|\bExact on-image|\bON-IMAGE TYPOGRAPHY|\bPlace all text\b/i
  )
  if (cut > 48) s = s.slice(0, cut).trim()
  s = s
    .replace(/\bPaint this exact lettering[\s\S]*$/i, '')
    .replace(/\bPlace all text[\s\S]*$/i, '')
    // Scene briefs often smuggle type color as "deep-navy text (#…)" — strip those
    .replace(/\band\s+[\w-]+\s+text\s*\([^)]*\)/gi, '')
    .replace(/\bwith\s+[\w-]+\s+text\b[^.]*\./gi, '.')
    .replace(/\bleft-aligned\s+within[^.]*/gi, '')
    .trim()
    .replace(/[.,;:\s]+$/g, '')
  return (s.slice(0, 420) || fallback).trim()
}

/** Short on-image line — first sentence, then word + char caps for mobile bake. */
export function shortOnImageText(raw: string, maxChars = 90, maxWords = 12): string {
  const t = (raw || '').trim()
  if (!t) return ''
  let first = t.split(/(?<=[.!?])\s+/)[0] || t
  const words = first.split(/\s+/).filter(Boolean)
  if (maxWords > 0 && words.length > maxWords) {
    first = words.slice(0, maxWords).join(' ')
  }
  if (first.length <= maxChars) return first
  const cut = first.slice(0, maxChars)
  const sp = cut.lastIndexOf(' ')
  return (sp > 40 ? cut.slice(0, sp) : cut).trim()
}

/** Still placement with margins converted into the rendered (pre-crop) frame. */
function stillPlacement(align: 'left' | 'center' | 'right', area: 'upper' | 'lower'): string {
  const edge = renderedMarginPct(10)
  const bottom = renderedMarginPct(12)
  if (align === 'left' || align === 'right') {
    return `Placement: ${area} area, ${align}-aligned text block — keep all lettering ≥${edge}% from top/bottom and ≥10% from left/right.`
  }
  return area === 'upper'
    ? `Placement: upper-middle band, centered — keep the text block ≥${edge}% from the top edge and ≥10% from left/right.`
    : `Placement: lower-middle band (not flush to the bottom), centered — keep the entire text block ≥${bottom}% from the bottom edge and ≥10% from left/right.`
}

function typeRecipe(opts: {
  font: string
  scrim: string
  palette: string
  sizeHint?: string
  textAlign?: 'left' | 'center' | 'right' | null
  frame?: Frame
}): string {
  const align = opts.textAlign || (opts.scrim === 'none' ? 'left' : 'center')
  const frame = opts.frame || 'still'
  const placement =
    frame === 'reel'
      ? reelPlacement()
      : opts.sizeHint || stillPlacement(align, align === 'center' ? 'lower' : 'upper')

  // Light boards (scrim none) → dark type; dark scrims → white type.
  const letterStyle =
    opts.scrim === 'none'
      ? `Style: bold ${opts.font}, deep primary/navy letters from the palette on the light background (high contrast) — do not force white-on-dark unless the panel behind the text is dark.`
      : `Style: bold ${opts.font} (or closest condensed sans), white letters with soft dark shadow.`

  if (frame === 'reel') {
    // Compact recipe — reel prompts share a hard character budget with the cue timeline.
    return [
      letterStyle,
      `SIZE: letter height ≈ 4–6% of frame height, text block under ~18% of frame height, max 2 lines, never clipped.`,
      placement,
      `Contrast: ${scrimDescription(opts.scrim, 'reel')}. Palette: ${opts.palette}.`,
    ].join(' ')
  }

  return [
    `ON-IMAGE TYPOGRAPHY (must be sharp, correctly spelled, no extra words):`,
    letterStyle,
    // Models default to billboard type — constrain hard for IG feed readability.
    `SIZE: restrained mobile type — each line’s letter height ≈ 5–7% of frame height (not giant billboard). The full text block must stay under ~22% of frame height. Prefer 2 wrapping lines over one oversized line. Leave ≥40% of the frame as clean scene/negative space.`,
    placement,
    stillCropNote(),
    `SAFE ZONE: never crop or clip letters. Leave clear padding under the last line — no flush-to-edge type.`,
    `Contrast: ${scrimDescription(opts.scrim)}.`,
    `Palette cues in scene and type: ${opts.palette}.`,
    `Do not invent extra logos, watermarks, UI chrome, URLs, or text beyond the exact line(s) / brand chrome specified.`,
  ]
    .filter(Boolean)
    .join(' ')
}

export type CompileContext = {
  angle?: string | null
  /** e.g. @dailywordwithashwin — from brand visual brief */
  brandHandle?: string | null
  /** Brand opted in (visual_identity.brand_mark) to a small emblem (kept inset). */
  brandMark?: 'cross' | null
}

/** Pull @handle from brand visual copy (first match). */
export function extractBrandHandle(visualBrief?: string | null): string | null {
  if (!visualBrief?.trim()) return null
  const m = visualBrief.match(/@[a-zA-Z0-9._]{2,30}/)
  return m ? m[0].toLowerCase() : null
}

/**
 * Brand emblem is opt-in only via visual_identity.brand_mark — free-text briefs that
 * merely mention "cross"/"emblem" (often in an avoid list) must not inject one.
 */
export function brandMarkFromIdentity(identity: VisualIdentity | null | undefined): 'cross' | null {
  return identity?.brand_mark === 'cross' ? 'cross' : null
}

function brandChromeLines(ctx: CompileContext, frame: Frame = 'still'): string[] {
  const lines: string[] = []
  const handle = (ctx.brandHandle || '').trim()
  if (handle) {
    const h = handle.startsWith('@') ? handle : `@${handle}`
    const where =
      frame === 'reel'
        ? `just below the top UI band, ${IG.reelSafe.topPct + 2}–${IG.reelSafe.topPct + 6}% from the top edge, centered, ≥${IG.reelSafe.sidePct}% from left and ≥${IG.reelSafe.rightPct + 2}% from right`
        : `at the TOP of the frame, centered or slightly inset, ≥${renderedMarginPct(6)}% from the top edge and ≥8% from left/right`
    lines.push(
      `Exact brand handle (required, in addition to hook text): "${h}". Place it small and discreet ${where}. Do not crop it.`
    )
  }
  if (ctx.brandMark === 'cross') {
    const bottom =
      frame === 'reel' ? `above the bottom ${IG.reelSafe.bottomPct}% UI band` : `≥${renderedMarginPct(8)}% from the bottom edge`
    lines.push(
      `Exact brand mark: one small subtle cross emblem near the lower area, centered, fully visible ${bottom} (never clipped). No other icons.`
    )
  }
  return lines
}

/** Seed prompt_vars from post + brand when missing. */
export function seedPromptVars(
  post: Post,
  identity: VisualIdentity = {}
): PromptVars {
  const format = (post.format || 'feed') as PostFormat
  const font = defaultFont(identity)
  const palette = paletteString(identity)
  const scrim = identity.layout_defaults?.scrim || 'bottom'
  const hook = (post.hook || post.topic || '').trim()
  const caption = (post.caption || '').trim()
  const hashtags = (post.hashtags || '').trim()
  const negative = GENERATION_NEGATIVE
  const angle = (post.angle || '').trim()

  if (format === 'reel') {
    const onImage = shortOnImageText(hook, 80, 12)
    const duration = clampReelDuration(IG.reelDuration.default)
    const split = Math.max(3, duration - 3)
    const cues: ReelPromptVars['timed_cues'] = onImage
      ? [
          { text: onImage, startSec: 0, endSec: split, enterAnim: 'fade', exitAnim: 'fade' },
          {
            text: shortOnImageText(post.topic || 'Try this / share with a friend', 80, 12),
            startSec: split,
            endSec: duration,
            enterAnim: 'slideUp',
            exitAnim: 'fade',
          },
        ]
      : []
    const motionBase =
      post.reel_prompt ||
      `Short vertical motion about: ${post.topic || hook || 'brand moment'}`
    return {
      format: 'reel',
      timed_cues: cues,
      motion_brief: angle ? `${motionBase}. Angle / POV: ${angle}.` : motionBase,
      duration,
      aspect: '9:16',
      font,
      palette,
      scrim,
      negative,
      caption,
      hashtags,
    }
  }

  if (format === 'carousel') {
    const slides: CarouselPromptVars['slides'] = [
      {
        on_image_text: hook || 'Cover',
        role: 'cover',
        visual_subject: post.topic || 'hero scene',
      },
      {
        on_image_text: 'Key point',
        role: 'point',
        visual_subject: 'supporting detail shot',
      },
      {
        on_image_text: 'Save this',
        role: 'cta',
        visual_subject: 'closing beat matching cover',
      },
    ]
    return {
      format: 'carousel',
      slide_count: slides.length,
      slides,
      palette,
      font,
      scrim,
      aspect: '4:5',
      negative,
      caption,
      hashtags,
    }
  }

  const onImage = shortOnImageText(hook)
  return {
    format: 'feed',
    hook_on_image: onImage,
    caption,
    hashtags,
    subject: angle
      ? `${post.topic || onImage || 'brand subject'} (angle: ${angle})`
      : post.topic || onImage || 'brand subject',
    setting: 'on-brand environment',
    lighting: 'natural soft key light',
    palette,
    font,
    scrim,
    aspect: '4:5',
    negative,
  }
}

export function compileFeedPlate(
  vars: FeedPromptVars,
  identity: VisualIdentity = {},
  ctx: CompileContext = {}
): string {
  const { must, avoid } = shotRules(identity, 'feed')
  const hook = shortOnImageText((vars.hook_on_image || '').trim())
  const subject = sceneOnlySubject(vars.subject)
  const textAlign = identity.layout_defaults?.text_align || null
  const scrim = vars.scrim || identity.layout_defaults?.scrim || 'bottom'
  return [
    `Instagram feed still, final aspect 4:5, ${renderStyle(identity)}.`,
    `Subject (scene only — no lettering instructions here): ${subject}.`,
    `Setting: ${vars.setting}.`,
    `Lighting: ${vars.lighting}.`,
    `Palette: ${vars.palette}.`,
    ctx.angle?.trim() && `Angle / POV: ${ctx.angle.trim()}.`,
    must && `Must include: ${must}.`,
    avoid && `Avoid: ${avoid}.`,
    hook
      ? `Exact on-image hook text (primary line): "${hook}".`
      : `No primary on-image hook text.`,
    ...brandChromeLines(ctx),
    hook &&
      typeRecipe({
        font: vars.font,
        scrim,
        palette: vars.palette,
        textAlign,
      }),
    !hook && stillCropNote(),
    `Also avoid: ${negativeFor(vars.negative, ctx)}.`,
  ]
    .filter(Boolean)
    .join(' ')
}

/** One fixed continuity line for every slide so the series doesn't drift. */
export function seriesDescriptor(vars: CarouselPromptVars): string {
  const first = sceneOnlySubject(vars.slides[0]?.visual_subject || '', '').slice(0, 160)
  return [
    `SERIES CONTINUITY (identical on every slide): same lighting setup, same camera distance and lens feel, same color grade using palette ${vars.palette}, same type style (${vars.font}) in the same position and size.`,
    first && `Shared subject world from slide 1: ${first}.`,
  ]
    .filter(Boolean)
    .join(' ')
}

export function compileCarouselPlate(
  vars: CarouselPromptVars,
  slideIndex: number,
  identity: VisualIdentity = {},
  ctx: CompileContext = {}
): string {
  const slide = vars.slides[slideIndex]
  const { must, avoid } = shotRules(identity, 'carousel')
  const role = slide?.role || 'point'
  const text = shortOnImageText(
    (slide?.on_image_text || '').trim(),
    role === 'cover' ? 70 : 110,
    role === 'cover' ? 10 : 12
  )
  const textAlign = identity.layout_defaults?.text_align || null
  const scrim = vars.scrim || identity.layout_defaults?.scrim || 'bottom'
  const alignLeft = textAlign === 'left' || (!textAlign && scrim === 'none')
  const isCover = role === 'cover'
  const isCta = role === 'cta'
  const vEdge = renderedMarginPct(10)
  const vBottom = renderedMarginPct(12)
  const size = isCover ? 'bold cover size' : isCta ? 'clear CTA size' : 'slightly smaller than cover'
  const sizeHint = alignLeft
    ? `Placement: upper-left, left-aligned, ${size} — ≥${vEdge}% from the top edge and ≥10% from left/right.`
    : `Placement: lower-middle, centered, ${size} — keep full text ≥${vBottom}% above the bottom edge and ≥10% from left/right.`
  const visual = sceneOnlySubject(
    slide?.visual_subject || vars.slides[0]?.visual_subject || 'scene'
  )
  return [
    `Instagram carousel slide ${slideIndex + 1}/${vars.slide_count}, role=${role}, final aspect 4:5, ${renderStyle(identity)}.`,
    seriesDescriptor(vars),
    `Visual subject (scene only — no lettering instructions here): ${visual}.`,
    ctx.angle?.trim() && `Angle / POV: ${ctx.angle.trim()}.`,
    must && `Must include: ${must}.`,
    avoid && `Avoid: ${avoid}.`,
    text
      ? `Exact on-image slide text (primary line): "${text}".`
      : `No primary on-image text on this slide.`,
    // Brand chrome on cover (+ CTA) so the handle shows in feed previews
    ...(isCover || isCta ? brandChromeLines(ctx) : []),
    text &&
      typeRecipe({
        font: vars.font,
        scrim,
        palette: vars.palette,
        sizeHint,
        textAlign,
      }),
    !text && stillCropNote(),
    `Also avoid: ${negativeFor(vars.negative, ctx)}.`,
  ]
    .filter(Boolean)
    .join(' ')
}

function fmtSec(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function compileReelPlate(
  vars: ReelPromptVars,
  identity: VisualIdentity = {},
  ctx: CompileContext = {}
): string {
  const { must, avoid } = shotRules(identity, 'reel')
  const duration = clampReelDuration(vars.duration)
  const cues = (vars.timed_cues || [])
    .map((c) => ({
      text: shortOnImageText((c.text || '').trim(), 80, 12),
      start: Math.max(0, Math.min(duration, Number(c.startSec) || 0)),
      end: Math.max(0, Math.min(duration, Number(c.endSec) || duration)),
    }))
    .filter((c) => c.text && c.end > c.start)
  const textAlign = identity.layout_defaults?.text_align || null
  const scrim = vars.scrim || identity.layout_defaults?.scrim || 'bottom'
  const cueLines = cues.length
    ? `On-screen text timeline (one line at a time, swap at each window; exact wording): ${cues
        .map((c) => `${fmtSec(c.start)}–${fmtSec(c.end)}s: "${c.text}"`)
        .join('; ')}.`
    : `No on-screen text.`
  const beatLine = vars.beat_visuals?.length
    ? `Visual beats (new shot/prop/camera change at each time): ${vars.beat_visuals
        .map((b) => `${fmtSec(Number(b.t) || 0)}s ${sceneOnlySubject(b.visual, 'change').slice(0, 90)}`)
        .join('; ')}.`
    : null

  // Fixed parts — never trimmed (format, typography, safe zone, negative).
  const head = `Instagram reel, vertical 9:16, exactly ${duration}s single continuous clip, ${renderStyle(identity)} motion, visible change within the first second, silent.`
  const tail = [
    `ON-SCREEN TYPOGRAPHY burned into video pixels (correct English spelling; no other captions, subtitles, watermarks, or UI):`,
    cueLines,
    ...brandChromeLines(ctx, 'reel'),
    cues.length &&
      typeRecipe({
        font: vars.font,
        scrim,
        palette: vars.palette,
        textAlign,
        frame: 'reel',
      }),
    `Also avoid: ${negativeFor(vars.negative, ctx)}.`,
  ]
    .filter(Boolean)
    .join(' ')
  // Trimmable parts, most important first (dropped from the end). Palette lives in the type recipe.
  const optional = [
    beatLine,
    must && `Must include: ${must}.`,
    avoid && `Avoid: ${avoid}.`,
    ctx.angle?.trim() && `Angle / POV: ${ctx.angle.trim()}.`,
    !cues.length && `Palette: ${vars.palette}.`,
  ].filter(Boolean) as string[]

  const motionFull = sceneOnlySubject(vars.motion_brief, vars.motion_brief || 'brand motion')
  const assemble = (motion: string, extras: string[]) =>
    [head, motion && `Motion / scene (no lettering here): ${motion}.`, ...extras, tail]
      .filter(Boolean)
      .join(' ')

  /** Cut to ≤n chars at a word boundary (no-op when already short). */
  const cutWords = (t: string, n: number) =>
    t.length <= n ? t : t.slice(0, n + 1).replace(/\s+\S*$/, '').replace(/[.,;:\s]+$/, '')

  let extras = [...optional]
  let out = assemble(motionFull, extras)
  if (out.length <= REEL_PROMPT_MAX) return out
  // 1) Trim the motion brief first (down to a floor).
  const over = out.length - REEL_PROMPT_MAX
  const minMotion = 120
  if (motionFull.length - over >= minMotion) {
    out = assemble(cutWords(motionFull, motionFull.length - over - 1), extras)
    if (out.length <= REEL_PROMPT_MAX) return out
  }
  let motion = cutWords(motionFull, minMotion)
  // 2) Then drop optional extras from the end.
  while (extras.length) {
    out = assemble(motion, extras)
    if (out.length <= REEL_PROMPT_MAX) return out
    extras = extras.slice(0, -1)
  }
  out = assemble(motion, extras)
  if (out.length <= REEL_PROMPT_MAX) return out
  motion = ''
  return assemble(motion, extras).slice(0, REEL_PROMPT_MAX)
}

export function compilePromptPreview(
  vars: PromptVars,
  identity: VisualIdentity = {},
  ctx: CompileContext = {}
): PromptPreview {
  if (vars.format === 'feed') {
    const plate = compileFeedPlate(vars, identity, ctx)
    return {
      vars,
      plates: [
        {
          kind: 'image',
          label: 'Feed generation',
          plate_prompt: plate,
          overlay_texts: [],
        },
      ],
      compiled: [plate],
    }
  }
  if (vars.format === 'carousel') {
    const plates = vars.slides.map((s, i) => ({
      kind: 'image' as const,
      label: `Slide ${i + 1} (${s.role})`,
      plate_prompt: compileCarouselPlate(vars, i, identity, ctx),
      overlay_texts: [] as string[],
    }))
    return {
      vars,
      plates,
      compiled: plates.map((p) => p.plate_prompt),
    }
  }
  const plate = compileReelPlate(vars, identity, ctx)
  return {
    vars,
    plates: [
      {
        kind: 'video',
        label: 'Reel generation',
        plate_prompt: plate,
        overlay_texts: [],
      },
    ],
    compiled: [plate],
  }
}

/** Empty canvas — model-baked media has no HTML overlay layers. */
export function emptyCanvasDoc(format: PostFormat): CanvasDoc {
  return {
    version: 1,
    format,
    background: { fit: 'cover', focusX: 0.5, focusY: 0.5 },
    scrim: 'none',
    layers: [],
    safeZone: true,
  }
}

/** @deprecated Prefer emptyCanvasDoc — overlays are no longer the publish path. */
export function canvasDocFromPromptVars(vars: PromptVars, _slideIndex = 0): CanvasDoc {
  const format =
    vars.format === 'feed' || vars.format === 'carousel' || vars.format === 'reel'
      ? vars.format
      : 'feed'
  return emptyCanvasDoc(format)
}

export function identityFromBrand(profile: BrandProfile | null): VisualIdentity {
  if (!profile) return {}
  return parseVisualIdentity(profile.visual_identity)
}
