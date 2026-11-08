/**
 * Build a finish draft from successful tool observations so the model
 * does not have to re-emit the entire carousel payload as JSON.
 */
import { FinishDraftSchema, type FinishDraft } from './schemas'

type Obs = {
  ok?: boolean
  /** Superseded by a later content_planning — ignored by lastOk. */
  stale?: boolean
  tool?: string
  data?: Record<string, unknown>
  draft?: Record<string, unknown>
  error?: string
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function pickString(obj: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const v = obj?.[key]
  return typeof v === 'string' && v.trim() ? v : undefined
}

function lastOk(history: unknown[], tool: string): Record<string, unknown> | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const o = history[i] as Obs
    if (o?.ok && !o.stale && o.tool === tool && o.data) return asRecord(o.data)
  }
  return null
}

/** Tools whose output depends on the plan (invalidated when the plan changes). */
const DOWNSTREAM_OF_PLAN = new Set(['media_prompts', 'caption_writing', 'post_review'])
/** Tools whose output depends on the media brief. */
const DOWNSTREAM_OF_MEDIA = new Set(['caption_writing', 'post_review'])
/** A rewritten caption needs a fresh review. */
const DOWNSTREAM_OF_CAPTION = new Set(['post_review'])

/**
 * Mark earlier downstream observations stale after `tool` succeeds again, so a
 * re-plan / re-brief forces the dependent steps to re-run instead of being
 * assembled next to the new output. Returns how many were invalidated.
 */
function invalidateDownstream(history: unknown[], tool: string): number {
  const deps =
    tool === 'content_planning'
      ? DOWNSTREAM_OF_PLAN
      : tool === 'media_prompts'
        ? DOWNSTREAM_OF_MEDIA
        : tool === 'caption_writing'
          ? DOWNSTREAM_OF_CAPTION
          : null
  if (!deps) return 0
  let n = 0
  for (const h of history) {
    const o = h as Obs
    if (o?.ok && !o.stale && o.tool && deps.has(o.tool)) {
      o.stale = true
      n++
    }
  }
  return n
}

/** Plan + media exist — caption_writing can run (it needs slides / beats). */
function canWriteCaption(history: unknown[], preferredFormat?: string | null): boolean {
  const plan = lastOk(history, 'content_planning')
  const media = lastOk(history, 'media_prompts')
  if (!plan || !media) return false
  return mediaComplete(plan, media, preferredFormat)
}

function mediaComplete(
  plan: Record<string, unknown>,
  media: Record<string, unknown>,
  preferredFormat?: string | null
): boolean {
  const format = String(
    preferredFormat || pickString(plan, 'format') || pickString(media, 'format') || 'feed'
  ).toLowerCase()
  if (format === 'carousel') {
    const slides = media.slides
    return Array.isArray(slides) && slides.length >= 2
  }
  return Boolean(pickString(media, 'image_prompt') && pickString(media, 'stock_search_query'))
}

/** True when plan + caption + media are present enough to review/finish. */
function canAssembleDraft(history: unknown[], preferredFormat?: string | null): boolean {
  const plan = lastOk(history, 'content_planning')
  const caption = lastOk(history, 'caption_writing')
  const media = lastOk(history, 'media_prompts')
  if (!plan || !caption || !media) return false
  return mediaComplete(plan, media, preferredFormat)
}

/** True when checklist review has run (required before finish). */
function hasPostReview(history: unknown[]): boolean {
  return Boolean(lastOk(history, 'post_review'))
}

function assembleDraftFromHistory(
  history: unknown[],
  opts: { preferredFormat?: string | null; topic?: string } = {}
): FinishDraft {
  const plan = lastOk(history, 'content_planning') || {}
  const caption = lastOk(history, 'caption_writing') || {}
  const media = lastOk(history, 'media_prompts') || {}
  const review = lastOk(history, 'post_review')

  let format = String(
    opts.preferredFormat || pickString(plan, 'format') || 'feed'
  ).toLowerCase()
  if (format !== 'reel' && format !== 'carousel' && format !== 'feed') format = 'feed'
  if (Array.isArray(media.slides) && (media.slides as unknown[]).length >= 2) {
    format = 'carousel'
  }

  const hookOnImage =
    pickString(plan, 'hook_on_image') || pickString(plan, 'hook') || ''

  const draft: Record<string, unknown> = {
    job: pickString(plan, 'job') || 'educate',
    audience: pickString(plan, 'audience') || '',
    audience_problem: pickString(plan, 'audience_problem') || pickString(plan, 'audience') || '',
    hook: pickString(plan, 'hook') || '',
    hook_on_image: hookOnImage,
    angle: pickString(plan, 'angle') || pickString(plan, 'hook') || '',
    format,
    tone: pickString(plan, 'tone') || '',
    hashtag_theme:
      pickString(plan, 'hashtag_theme') || opts.topic?.trim() || pickString(plan, 'angle') || '',
    alt_hooks: Array.isArray(plan.alt_hooks) ? plan.alt_hooks : ['', '', ''],
    topic: opts.topic,
    caption: pickString(caption, 'caption') || '',
    hashtags: pickString(caption, 'hashtags') || '',
    first_line: pickString(caption, 'first_line'),
    cta: pickString(caption, 'cta'),
    image_prompt: pickString(media, 'image_prompt') || '',
    stock_search_query: pickString(media, 'stock_search_query') || '',
    reel_prompt: pickString(media, 'reel_prompt'),
    media_type: media.media_type === 'reel' ? 'reel' : 'image',
    fallback_prompt: pickString(media, 'fallback_prompt'),
    duration_sec:
      typeof media.duration_sec === 'number' && Number.isFinite(media.duration_sec)
        ? media.duration_sec
        : undefined,
    alt_text: pickString(caption, 'alt_text'),
  }

  if (Array.isArray(media.slides)) {
    draft.slides = (media.slides as Array<Record<string, unknown>>).map((s) => ({
      text: typeof s.text === 'string' ? s.text : '',
      image_prompt: typeof s.image_prompt === 'string' ? s.image_prompt : '',
      stock_search_query: typeof s.stock_search_query === 'string' ? s.stock_search_query : '',
      role:
        typeof s.role === 'string' &&
        ['cover', 'why', 'step', 'mistake', 'recap', 'point', 'cta'].includes(s.role)
          ? s.role
          : undefined,
      alt_text: typeof s.alt_text === 'string' && s.alt_text.trim() ? s.alt_text : undefined,
    }))
  }

  if (Array.isArray(media.beats)) {
    draft.beats = (media.beats as Array<Record<string, unknown>>).map((b) => ({
      t_start: typeof b.t_start === 'number' ? b.t_start : Number(b.t_start) || 0,
      visual_change: typeof b.visual_change === 'string' ? b.visual_change : '',
      on_screen_text_intent:
        typeof b.on_screen_text_intent === 'string' ? b.on_screen_text_intent : '',
    }))
  }

  if (review) {
    draft.review = review
    if (Array.isArray(review.lint)) draft.lint = review.lint
  }

  const alts = draft.alt_hooks as string[]
  while (alts.length < 3) alts.push(draft.hook as string)
  draft.alt_hooks = alts.slice(0, 3)

  return FinishDraftSchema.parse(draft)
}

export {
  assembleDraftFromHistory,
  canAssembleDraft,
  canWriteCaption,
  hasPostReview,
  invalidateDownstream,
  lastOk,
}
