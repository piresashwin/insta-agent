/** Shared API / domain DTOs for client + server. */

export type PostStatus =
  | 'draft'
  | 'pending_approval'
  | 'changes_requested'
  | 'needs_revision'
  | 'approved'
  | 'media_generating'
  | 'media_ready'
  | 'staged'
  | 'pending_upload'
  | 'publishing'
  | 'published'
  | 'failed'

export type PostFormat = 'feed' | 'reel' | 'carousel'

export type TextAnim = 'none' | 'fade' | 'slideUp' | 'slideDown' | 'scaleIn'

export const TEXT_ANIMS: TextAnim[] = ['none', 'fade', 'slideUp', 'slideDown', 'scaleIn']

export type CanvasLayer = {
  id: string
  type: 'hook' | 'text'
  text: string
  x: number
  y: number
  w: number
  fontSize: number
  align: 'left' | 'center' | 'right'
  color: string
  weight: 400 | 600 | 700
  /** CSS font-family name (Google Font), e.g. "Playfair Display". */
  fontFamily?: string | null
  shadow?: boolean
  /** Reel: show from this time (seconds). Omit / null = always on for feed/carousel. */
  startSec?: number | null
  /** Reel: hide at this time (seconds). */
  endSec?: number | null
  enterAnim?: TextAnim | null
  exitAnim?: TextAnim | null
  /** Enter/exit duration in ms (default 350). */
  animMs?: number | null
}

export type CanvasScrim = 'none' | 'bottom' | 'full'

export type CanvasDoc = {
  version: 1
  format: PostFormat
  background: { fit: 'cover' | 'contain'; focusX: number; focusY: number }
  /** Dark overlay so light text stays readable. */
  scrim?: CanvasScrim
  layers: CanvasLayer[]
  safeZone: boolean
}

/** Operator-chosen visual direction — steers Pexels / image_prompt keywords. */
export type BackgroundStyle =
  | 'flat_lay'
  | 'lifestyle'
  | 'outdoor_nature'
  | 'cozy_indoor'
  | 'studio_minimal'
  | 'urban'
  | 'workspace'
  | 'abstract_texture'

export const BACKGROUND_STYLES: Array<{
  id: BackgroundStyle
  label: string
  keywords: string
}> = [
  { id: 'flat_lay', label: 'Flat lay', keywords: 'flat lay overhead tabletop' },
  { id: 'lifestyle', label: 'Lifestyle', keywords: 'lifestyle candid natural light' },
  { id: 'outdoor_nature', label: 'Outdoor / nature', keywords: 'outdoor nature landscape greenery' },
  { id: 'cozy_indoor', label: 'Cozy indoor', keywords: 'cozy indoor warm home' },
  { id: 'studio_minimal', label: 'Studio minimal', keywords: 'studio minimal clean background' },
  { id: 'urban', label: 'Urban', keywords: 'urban city street architecture' },
  { id: 'workspace', label: 'Workspace', keywords: 'desk workspace laptop coffee' },
  { id: 'abstract_texture', label: 'Abstract texture', keywords: 'abstract texture pattern soft' },
]

export type PostSlide = {
  id: number
  post_id: number
  position: number
  source_image_url: string | null
  canvas_json: string | null
  staged_url: string | null
  /** On-image copy for this slide (carousel). */
  text: string | null
  image_prompt: string | null
  stock_search_query: string | null
  /** Accessibility alt text sent to Graph (carousel item). */
  alt_text?: string | null
  created_at: string
  updated_at: string | null
}

export type BrandPillar = {
  name: string
  notes?: string
}

/** Sparse per-post patch merged over brand_profile at resolve time. */
export type BrandOverrides = {
  audience?: string
  tone?: string
  voice_note?: string
  hashtag_extra?: string
  visual_extra?: string
  image_prompt_extra?: string
  background_style?: BackgroundStyle | string
  /** Cap agent-generated carousel slides (2–7). */
  max_slides?: number
}

/** Structured look system — preferred over freeform `visual` alone. */
export type VisualIdentity = {
  palette?: {
    primary?: string
    secondary?: string
    accent?: string
    background?: string
  }
  typography?: {
    heading_font?: string
    body_font?: string
  }
  logo_url?: string | null
  shot_rules?: {
    must?: string[]
    avoid?: string[]
  }
  layout_defaults?: {
    scrim?: 'none' | 'bottom' | 'full'
    text_align?: 'left' | 'center' | 'right'
    safe_margin?: number
  }
  /** Render look for generated media, e.g. "photoreal", "flat illustration", "typographic poster". */
  render_style?: string
  /** Opt-in brand emblem painted on cover/CTA. Unset = no emblem. */
  brand_mark?: 'cross' | null
}

/** Per-format fill quotas for fill-week, e.g. { feed: 1, reel: 1, carousel: 1 }. */
export type FormatMix = Partial<Record<PostFormat, number>>

export type FeedPromptVars = {
  format: 'feed'
  hook_on_image: string
  caption: string
  hashtags: string
  subject: string
  setting: string
  lighting: string
  palette: string
  font: string
  scrim: CanvasScrim
  aspect: '4:5'
  negative: string
}

export type CarouselSlideRole =
  | 'cover'
  | 'why'
  | 'step'
  | 'mistake'
  | 'recap'
  | 'point'
  | 'cta'

export type CarouselSlideVars = {
  on_image_text: string
  role: CarouselSlideRole
  visual_subject: string
}

export type CarouselPromptVars = {
  format: 'carousel'
  slide_count: number
  slides: CarouselSlideVars[]
  palette: string
  font: string
  scrim: CanvasScrim
  aspect: '4:5'
  negative: string
  caption: string
  hashtags: string
}

export type ReelTimedCue = {
  text: string
  startSec: number
  endSec: number
  enterAnim?: TextAnim | null
  exitAnim?: TextAnim | null
}

export type ReelBeatVisual = {
  t: number
  visual: string
}

export type ReelPromptVars = {
  format: 'reel'
  timed_cues: ReelTimedCue[]
  motion_brief: string
  /** Per-beat visual changes (from media_prompts beats); compiled separately from motion_brief. */
  beat_visuals?: ReelBeatVisual[]
  /** Seconds — one Runware clip (6–15). Passed to the video provider. */
  duration: number
  aspect: '9:16'
  font: string
  palette: string
  scrim: CanvasScrim
  negative: string
  caption: string
  hashtags: string
}

export type PromptVars = FeedPromptVars | CarouselPromptVars | ReelPromptVars

export type PromptPlatePreview = {
  kind: 'image' | 'video'
  label: string
  plate_prompt: string
  overlay_texts: string[]
}

export type PromptPreview = {
  vars: PromptVars
  plates: PromptPlatePreview[]
  compiled: string[]
}

export type VoiceRules = {
  do?: string[]
  dont?: string[]
  banned_words?: string[]
  emoji_policy?: 'none' | 'sparing' | 'moderate'
  person?: 'first_singular' | 'first_plural' | 'second' | 'third'
  caption_length?: 'short' | 'medium' | 'long'
  cta_styles?: string[]
}

export type ExamplePost = {
  hook: string
  caption?: string
  hashtags?: string
  what_works?: string
}

export type HashtagSet = {
  name: string
  tags: string[]
  use_always?: boolean
  max_pick?: number
}

export type BrandProfile = {
  id: number
  name: string
  niche: string | null
  audience: string | null
  goals: string | null
  /** JSON array of BrandPillar or string[] */
  pillars: string | null
  posts_per_week: number
  /** JSON string[] e.g. ["mon","wed","fri"] */
  preferred_days: string | null
  voice: string | null
  examples: string | null
  visual: string | null
  /** JSON VisualIdentity */
  visual_identity: string | null
  /** JSON FormatMix */
  format_mix: string | null
  default_background_style: BackgroundStyle | string | null
  default_format: PostFormat | string | null
  /** Default max slides when generating carousels (2–7). */
  default_max_slides: number | null
  guide_md: string | null
  /** JSON VoiceRules */
  voice_rules: string | null
  /** JSON ExamplePost[] */
  example_posts: string | null
  /** JSON HashtagSet[] */
  hashtag_sets: string | null
  timezone: string
  created_at: string
  updated_at: string | null
}

export type CalendarProposal = {
  date: string
  topic: string
  pillar: string | null
  format: PostFormat | string
  angle: string | null
  background_style?: BackgroundStyle | string | null
}

export type Post = {
  id: number
  account_id: string | null
  status: PostStatus
  topic: string | null
  hook: string | null
  hook_alternates: string | null
  caption: string | null
  hashtags: string | null
  format: PostFormat | string | null
  background_style: BackgroundStyle | string | null
  image_prompt: string | null
  stock_search_query: string | null
  reel_prompt: string | null
  image_url: string | null
  source_image_url: string | null
  reel_url: string | null
  /** Runware tier: draft (720×1280) | final (1080×1920) | null */
  reel_quality: 'draft' | 'final' | string | null
  media_type: string | null
  media_provider: string | null
  canvas_json: string | null
  /** Scene v2 JSON (SceneDoc). Supersedes canvas_json when present. */
  scene_json: string | null
  /** JSON PromptVars — compiled format template inputs */
  prompt_vars: string | null
  /** Week-plan / operator angle */
  angle: string | null
  brand_profile_id: number | null
  brand_overrides: string | null
  scheduled_at: string | null
  pillar: string | null
  /** Published IG media id (use for insights / comments). */
  instagram_media_id: string | null
  /** Pre-publish container / creation id from Graph. */
  instagram_creation_id: string | null
  instagram_permalink: string | null
  instagram_shortcode: string | null
  /** ISO timestamp from Graph media.timestamp */
  instagram_published_at: string | null
  /** JSON string[] of carousel child media/container ids */
  instagram_children_ids: string | null
  approved_by: string | null
  approved_at: string | null
  revisions: number
  revision_comments: string | null
  agent_output: string | null
  /** Accessibility alt text sent to Graph (feed image). */
  alt_text?: string | null
  /** JSON MediaQa — advisory vision check of baked on-image text. */
  media_qa?: string | null
  error: string | null
  created_at: string
  updated_at: string | null
  /** Linked idea from Plan → schedule (Idea → Post flow). */
  idea_id?: number | null
}

export type IdeaStatus = 'new' | 'shortlisted' | 'dismissed' | 'scheduled'
export type IdeaSource = 'ai' | 'manual' | 'riff'

export type Idea = {
  id: number
  brand_profile_id: number
  batch_id: string | null
  topic: string
  angle: string | null
  pillar: string | null
  format: PostFormat
  hooks: string[]
  chosen_hook: string | null
  direction: string | null
  why: string | null
  source: IdeaSource
  parent_idea_id: number | null
  steer: string | null
  status: IdeaStatus
  post_id: number | null
  created_at: string
  updated_at: string | null
}

/** Advisory result of the optional vision QA pass. */
export type MediaQa = {
  text_ok: boolean
  issues: string[]
  expected: string[]
  seen?: string
  model?: string
  checked_at: string
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'needs_human'

export type Run = {
  id: number
  post_id: number | null
  goal: string
  kind: string
  status: RunStatus | string
  model: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export type RunEvent = {
  id: number
  run_id: number
  seq: number
  type: string
  payload: Record<string, unknown>
  created_at: string
}

export type InstagramConnection = {
  id: number
  account_id: string
  status: string
  updated_at: string | null
  ig_username?: string | null
  page_id?: string | null
  last_error?: string | null
  token_expires_at?: string | null
  has_token?: boolean
  default_brand_profile_id?: number | null
  granted_scopes?: string | null
  needs_reconnect?: boolean
}

export type Actor = {
  id: string
  name: string
}

export type ApproveBody = {
  actor: Actor
}

export type RequestChangesBody = {
  author: Actor
  comment: string
}

export type CreatePostBody = {
  topic?: string
  account_id?: string
  background_style?: BackgroundStyle | string
  format?: PostFormat | string
  brand_profile_id?: number
  scheduled_at?: string
  pillar?: string
}

export type AgentRunResponse = {
  post: Post
  run_id: number
  job_id?: number
  note?: string
}

export type PostsListResponse = {
  posts: Post[]
}

export type PostResponse = {
  post: Post
  slides?: PostSlide[]
}

export type RunsListResponse = {
  runs: Run[]
}

export type RunDetailResponse = {
  run: Run
  events: RunEvent[]
}

export type InstagramListResponse = {
  connections: InstagramConnection[]
}

/** Export pixel sizes per format (carousel uses feed size per slide). */
export const FORMAT_EXPORT: Record<
  PostFormat,
  { width: number; height: number; aspect: string }
> = {
  feed: { width: 1080, height: 1350, aspect: '4 / 5' },
  reel: { width: 1080, height: 1920, aspect: '9 / 16' },
  carousel: { width: 1080, height: 1350, aspect: '4 / 5' },
}

/** Google Fonts available in Compose — keep in sync with client canvas-fonts. */
export const CANVAS_GOOGLE_FONTS = [
  'Source Sans 3',
  'Inter',
  'DM Sans',
  'Poppins',
  'Montserrat',
  'Oswald',
  'Playfair Display',
  'Lora',
  'Merriweather',
  'Libre Baskerville',
  'Roboto Slab',
  'Bebas Neue',
  'Anton',
  'Pacifico',
  'Caveat',
] as const

export type CanvasGoogleFont = (typeof CANVAS_GOOGLE_FONTS)[number]
export const DEFAULT_CANVAS_FONT: CanvasGoogleFont = 'Source Sans 3'

/** Map a freeform LLM suggestion onto a catalog font (exact / case-insensitive / contains). */
export function resolveCanvasFontFamily(
  raw: string | null | undefined,
  fallback: CanvasGoogleFont = DEFAULT_CANVAS_FONT
): CanvasGoogleFont {
  const tip = (raw || '').trim()
  if (!tip) return fallback
  const lower = tip.toLowerCase()
  const exact = CANVAS_GOOGLE_FONTS.find((f) => f.toLowerCase() === lower)
  if (exact) return exact
  const contains = CANVAS_GOOGLE_FONTS.find(
    (f) => lower.includes(f.toLowerCase()) || f.toLowerCase().includes(lower)
  )
  if (contains) return contains
  // Common aliases
  if (/playfair|serif.*display/i.test(tip)) return 'Playfair Display'
  if (/baskerville/i.test(tip)) return 'Libre Baskerville'
  if (/slab/i.test(tip)) return 'Roboto Slab'
  if (/bebas|impact|display.*sans/i.test(tip)) return 'Bebas Neue'
  if (/script|hand|cursive|caveat|pacifico/i.test(tip)) {
    return /pacifico/i.test(tip) ? 'Pacifico' : 'Caveat'
  }
  if (/oswald|condensed/i.test(tip)) return 'Oswald'
  if (/lora|merriweather|serif/i.test(tip)) {
    return /merri/i.test(tip) ? 'Merriweather' : 'Lora'
  }
  return fallback
}

/** Whether a layer should be drawn at time t (seconds). Untimed layers always show. */
export function layerVisibleAt(layer: CanvasLayer, t: number): boolean {
  const hasStart = layer.startSec != null && Number.isFinite(layer.startSec)
  const hasEnd = layer.endSec != null && Number.isFinite(layer.endSec)
  if (!hasStart && !hasEnd) return true
  const start = hasStart ? Number(layer.startSec) : 0
  const end = hasEnd ? Number(layer.endSec) : Number.POSITIVE_INFINITY
  return t >= start && t < end
}

export function layerAnimMs(layer: CanvasLayer): number {
  const n = Number(layer.animMs)
  if (Number.isFinite(n) && n >= 0) return Math.min(2000, n)
  return 350
}

/** CSS transform/opacity for enter/exit near the visibility window. */
export function layerAnimStyle(
  layer: CanvasLayer,
  t: number
): { opacity: number; transform: string } {
  if (!layerVisibleAt(layer, t)) {
    return { opacity: 0, transform: 'none' }
  }
  const ms = layerAnimMs(layer)
  const dur = ms / 1000
  const start = layer.startSec != null ? Number(layer.startSec) : 0
  const end = layer.endSec != null ? Number(layer.endSec) : Number.POSITIVE_INFINITY
  const enter = (layer.enterAnim || 'none') as TextAnim
  const exit = (layer.exitAnim || 'none') as TextAnim

  let phase: 'enter' | 'hold' | 'exit' = 'hold'
  let p = 1
  if (enter !== 'none' && dur > 0 && t < start + dur) {
    phase = 'enter'
    p = Math.max(0, Math.min(1, (t - start) / dur))
  } else if (exit !== 'none' && Number.isFinite(end) && dur > 0 && t > end - dur) {
    phase = 'exit'
    p = Math.max(0, Math.min(1, (end - t) / dur))
  }

  const anim = phase === 'exit' ? exit : phase === 'enter' ? enter : 'none'
  if (anim === 'none' || phase === 'hold') return { opacity: 1, transform: 'none' }

  const ease = p * p * (3 - 2 * p) // smoothstep
  if (anim === 'fade') return { opacity: ease, transform: 'none' }
  if (anim === 'slideUp') {
    return { opacity: ease, transform: `translateY(${(1 - ease) * 24}px)` }
  }
  if (anim === 'slideDown') {
    return { opacity: ease, transform: `translateY(${(1 - ease) * -24}px)` }
  }
  if (anim === 'scaleIn') {
    const s = 0.85 + 0.15 * ease
    return { opacity: ease, transform: `scale(${s})` }
  }
  return { opacity: 1, transform: 'none' }
}

export const CANVAS_PLACEHOLDER_HOOK = 'Your hook'

export function isPlaceholderCanvasText(text: string | null | undefined): boolean {
  const t = (text || '').trim()
  return !t || t === CANVAS_PLACEHOLDER_HOOK
}

/**
 * Replace stale placeholder overlay copy with the real hook / prompt_vars cues.
 * Prefer reel timed_cues when present; otherwise refresh hook-type (or sole) layers.
 */
export function hydrateCanvasDoc(
  doc: CanvasDoc,
  opts: {
    hook?: string | null
    vars?: PromptVars | null
  }
): CanvasDoc {
  const next: CanvasDoc = {
    ...doc,
    layers: (doc.layers || []).map((l) => ({ ...l })),
  }
  const vars = opts.vars
  if (vars?.format === 'reel' && vars.timed_cues?.length) {
    const font = resolveCanvasFontFamily(vars.font || next.layers[0]?.fontFamily)
    next.scrim = vars.scrim || next.scrim || 'bottom'
    next.format = 'reel'
    next.layers = vars.timed_cues.map((c, i) => ({
      id: `cue-${i}`,
      type: (i === 0 ? 'hook' : 'text') as CanvasLayer['type'],
      text: c.text,
      x: 0.08,
      y: 0.55,
      w: 0.84,
      fontSize: 0.05,
      align: 'center' as const,
      color: '#ffffff',
      weight: 700 as const,
      fontFamily: font,
      shadow: true,
      startSec: c.startSec,
      endSec: c.endSec,
      enterAnim: c.enterAnim || 'fade',
      exitAnim: c.exitAnim || 'fade',
      animMs: 350,
    }))
    return next
  }
  if (vars?.format === 'feed' && vars.hook_on_image?.trim()) {
    const text = vars.hook_on_image.trim()
    if (!next.layers.length) {
      return defaultCanvasDoc('feed', text, { fontFamily: vars.font })
    }
    next.layers = next.layers.map((l, i) =>
      i === 0 || l.type === 'hook' || isPlaceholderCanvasText(l.text)
        ? { ...l, text }
        : l
    )
    if (vars.scrim) next.scrim = vars.scrim
    return next
  }
  if (vars?.format === 'carousel' && vars.slides?.length) {
    // Caller passes slide-specific doc; only replace placeholders with first slide text here.
    const text = vars.slides[0]?.on_image_text?.trim()
    if (text) {
      next.layers = next.layers.map((l, i) =>
        i === 0 || isPlaceholderCanvasText(l.text) ? { ...l, text } : l
      )
    }
    return next
  }
  const hook = (opts.hook || '').trim()
  if (!hook) return next
  next.layers = next.layers.map((l) =>
    isPlaceholderCanvasText(l.text) || l.type === 'hook' ? { ...l, text: hook } : l
  )
  return next
}

export function defaultCanvasDoc(
  format: PostFormat,
  hook?: string | null,
  opts?: { fontFamily?: string | null }
): CanvasDoc {
  const fontFamily = resolveCanvasFontFamily(opts?.fontFamily)
  const timed =
    format === 'reel'
      ? {
          startSec: 0.4,
          endSec: 4,
          enterAnim: 'fade' as TextAnim,
          exitAnim: 'fade' as TextAnim,
          animMs: 350,
        }
      : {}
  return {
    version: 1,
    format,
    background: { fit: 'cover', focusX: 0.5, focusY: 0.5 },
    scrim: 'bottom',
    layers: [
      {
        id: 'hook',
        type: 'hook',
        text: (hook || '').trim() || CANVAS_PLACEHOLDER_HOOK,
        x: 0.08,
        y: 0.72,
        w: 0.84,
        fontSize: 0.045,
        align: 'center',
        color: '#ffffff',
        weight: 700,
        fontFamily,
        shadow: true,
        ...timed,
      },
    ],
    safeZone: true,
  }
}

// ── Status glossary (single source of truth for labels, tones and icons) ──

export type StatusTone = 'draft' | 'pending' | 'info' | 'positive' | 'negative' | 'neutral'

export type StatusEntry = {
  label: string
  tone: StatusTone
  /** Short description for tooltips */
  description: string
}

export const STATUS_GLOSSARY: Record<string, StatusEntry> = {
  draft:            { label: 'Draft',                   tone: 'draft',    description: 'Not yet submitted for review.' },
  pending_approval: { label: 'Needs OK',                tone: 'pending',  description: 'Waiting for your approval.' },
  changes_requested:{ label: 'Changes requested',       tone: 'info',     description: 'Revisions were requested.' },
  needs_revision:   { label: 'Needs revision',          tone: 'info',     description: 'Max revisions reached; needs manual fix.' },
  approved:         { label: 'Copy approved',           tone: 'positive', description: 'Copy approved, media not yet generated.' },
  media_generating: { label: 'Generating media',        tone: 'info',     description: 'Media is being created.' },
  media_ready:      { label: 'Media ready for review',  tone: 'pending',  description: 'Media is ready — please review before publishing.' },
  staged:           { label: 'Ready to publish',        tone: 'positive', description: 'Approved and scheduled for publishing.' },
  pending_upload:   { label: 'Uploading',               tone: 'info',     description: 'Uploading to Instagram.' },
  publishing:       { label: 'Publishing',              tone: 'info',     description: 'Publishing to Instagram.' },
  published:        { label: 'Live',                    tone: 'positive', description: 'Published to Instagram.' },
  failed:           { label: 'Failed',                  tone: 'negative', description: 'An error occurred.' },
}

export function statusLabel(status: string): string {
  return STATUS_GLOSSARY[status]?.label ?? status
}

export function statusToneFor(status: string): StatusTone {
  return STATUS_GLOSSARY[status]?.tone ?? 'neutral'
}

// Scene v2
export * from './scene/index'
export * from './scene/renderer'
export * from './insights/index'
