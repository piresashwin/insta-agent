/** Durable post slides (feed/reel = 1, carousel = 2–10). */
import type { CanvasDoc, PostFormat, PostSlide } from '@instagram-agent/shared'
import { defaultCanvasDoc, resolveCanvasFontFamily } from '@instagram-agent/shared'
import db from './db'
import { ApiError } from './orchestrator'

export type CarouselSlidePlan = {
  text?: string | null
  image_prompt?: string | null
  stock_search_query?: string | null
  alt_text?: string | null
}

export function clampMaxSlides(n: number | null | undefined, fallback = 5): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(7, Math.max(2, Math.round(v)))
}

export function listSlides(postId: number | string): PostSlide[] {
  return db
    .prepare(
      `SELECT * FROM post_slides
       WHERE post_id = ? AND archived_at IS NULL
       ORDER BY position ASC`,
    )
    .all(Number(postId)) as PostSlide[]
}

/** Soft-archive active slides so restart history is retained. */
export function archiveSlidesForPost(postId: number | string): void {
  const now = new Date().toISOString()
  // Shift positions out of the way so UNIQUE(post_id, position) allows fresh slides.
  db.prepare(
    `UPDATE post_slides
     SET archived_at = ?, position = position + 100000 + id
     WHERE post_id = ? AND archived_at IS NULL`,
  ).run(now, Number(postId))
}

export function getSlide(slideId: number | string): PostSlide | null {
  return (
    (db.prepare('SELECT * FROM post_slides WHERE id = ?').get(Number(slideId)) as
      | PostSlide
      | undefined) || null
  )
}

export function ensureSlidesForFormat(
  postId: number,
  format: PostFormat,
  hook?: string | null,
  opts?: { fontFamily?: string | null }
): PostSlide[] {
  const existing = listSlides(postId)
  const min = format === 'carousel' ? 2 : 1
  if (existing.length >= min) {
    const hookText = (hook || '').trim()
    const font = opts?.fontFamily ? resolveCanvasFontFamily(opts.fontFamily) : null
    let touched = false
    for (const s of existing) {
      try {
        const doc = s.canvas_json
          ? (JSON.parse(s.canvas_json) as CanvasDoc)
          : defaultCanvasDoc(format, s.text || hook, font ? { fontFamily: font } : undefined)
        let changed = false
        doc.layers = (doc.layers || []).map((l) => {
          let layer = { ...l }
          if (font && layer.fontFamily !== font) {
            layer = { ...layer, fontFamily: font }
            changed = true
          }
          // Refresh placeholder / empty overlay when we finally have a real hook
          // (feed/reel single-slide). Carousel keeps per-slide text from apply plan.
          if (
            format !== 'carousel' &&
            hookText &&
            (!layer.text?.trim() || layer.text.trim() === 'Your hook')
          ) {
            layer = { ...layer, text: hookText }
            changed = true
          }
          return layer
        })
        if (changed) {
          touched = true
          updateSlide(s.id, {
            canvas_json: JSON.stringify(doc),
            ...(format !== 'carousel' && hookText && !s.text?.trim() ? { text: hookText } : {}),
          })
        }
      } catch {
        /* keep prior canvas */
      }
    }
    return touched ? listSlides(postId) : existing
  }

  const insert = db.prepare(
    `INSERT INTO post_slides (post_id, position, canvas_json, text, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
  )
  for (let i = existing.length; i < min; i++) {
    // Carousel: short placeholders only — never dump the full topic onto the canvas.
    // Agent applyCarouselSlidePlan fills real per-slide copy after drafting.
    const label =
      format === 'carousel'
        ? i === 0
          ? 'Cover'
          : i === min - 1 && min > 2
            ? 'CTA'
            : `Point ${i}`
        : hook || null
    insert.run(
      postId,
      i,
      JSON.stringify(defaultCanvasDoc(format, label, { fontFamily: opts?.fontFamily })),
      label
    )
  }
  return listSlides(postId)
}

/**
 * Pad/update carousel rows from agent slide plan.
 * Writes text + prompts onto columns and refreshes canvas hook text.
 */
export function applyCarouselSlidePlan(
  postId: number,
  plan: CarouselSlidePlan[],
  fallbackHook?: string | null,
  maxSlides = 7,
  opts?: { fontFamily?: string | null }
): PostSlide[] {
  const max = clampMaxSlides(maxSlides, 7)
  const count = Math.min(max, Math.max(2, plan.length || 2))
  let slides = listSlides(postId)
  const shortFallback = (i: number) => {
    const fromPlan = plan[i]?.text?.trim()
    if (fromPlan) return fromPlan
    if (i === 0) {
      const h = (fallbackHook || '').trim()
      // Hook on cover only if it's short enough for on-image text.
      return h && h.length <= 80 ? h : 'Cover'
    }
    return i === count - 1 ? 'CTA' : `Point ${i}`
  }
  while (slides.length < count) {
    const i = slides.length
    addSlide(postId, 'carousel', shortFallback(i))
    slides = listSlides(postId)
  }
  // Trim extras beyond plan when re-running agent (keep min 2).
  while (slides.length > count && slides.length > 2) {
    const last = slides[slides.length - 1]
    db.prepare('DELETE FROM post_slides WHERE id = ?').run(last.id)
    slides = listSlides(postId)
    const upd = db.prepare(
      'UPDATE post_slides SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
    slides.forEach((s, i) => {
      if (s.position !== i) upd.run(i, s.id)
    })
    slides = listSlides(postId)
  }
  for (let i = 0; i < count; i++) {
    const text = shortFallback(i)
    updateSlide(slides[i].id, {
      text,
      image_prompt: plan[i]?.image_prompt?.trim() || null,
      stock_search_query: plan[i]?.stock_search_query?.trim() || null,
      alt_text: plan[i]?.alt_text?.trim() || null,
      canvas_json: JSON.stringify(
        defaultCanvasDoc('carousel', text, { fontFamily: opts?.fontFamily })
      ),
    })
  }
  return listSlides(postId)
}

/** Prefer durable slide columns; fall back to agent_output.slides. */
export function slidePlanFromPost(post: {
  agent_output?: string | null
  id?: number
}): CarouselSlidePlan[] {
  if (post.id != null) {
    const slides = listSlides(post.id)
    if (slides.some((s) => s.text || s.image_prompt || s.stock_search_query)) {
      return slides.map((s) => ({
        text: s.text,
        image_prompt: s.image_prompt,
        stock_search_query: s.stock_search_query,
      }))
    }
  }
  return slidePlanFromAgentOutput(post.agent_output)
}

/** Parse per-slide briefs from posts.agent_output (FinishDraft.slides). */
export function slidePlanFromAgentOutput(
  agentOutput: string | null | undefined
): CarouselSlidePlan[] {
  if (!agentOutput) return []
  try {
    const draft = JSON.parse(agentOutput) as { slides?: CarouselSlidePlan[] }
    return Array.isArray(draft.slides) ? draft.slides : []
  } catch {
    return []
  }
}

export function addSlide(postId: number, format: PostFormat, hook?: string | null): PostSlide {
  const slides = listSlides(postId)
  if (slides.length >= 10) throw new ApiError(400, 'Carousel max is 10 slides')
  const position = slides.length
  const canvas = JSON.stringify(defaultCanvasDoc(format === 'carousel' ? 'carousel' : format, hook))
  const result = db
    .prepare(
      `INSERT INTO post_slides (post_id, position, canvas_json, text, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .run(postId, position, canvas, hook || null)
  const id = Number(result.lastInsertRowid)
  const row = getSlide(id)
  if (!row) throw new ApiError(500, 'slide missing after insert')
  return row
}

export function removeSlide(postId: number, slideId: number): PostSlide[] {
  const slides = listSlides(postId)
  if (slides.length <= 2) {
    throw new ApiError(400, 'Carousel requires at least 2 slides')
  }
  const target = slides.find((s) => s.id === slideId)
  if (!target) throw new ApiError(404, 'slide not found')
  db.prepare('DELETE FROM post_slides WHERE id = ?').run(slideId)
  const remaining = listSlides(postId)
  const upd = db.prepare(
    'UPDATE post_slides SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  )
  remaining.forEach((s, i) => {
    if (s.position !== i) upd.run(i, s.id)
  })
  return listSlides(postId)
}

export function updateSlide(
  slideId: number,
  patch: {
    source_image_url?: string | null
    canvas_json?: string | null
    staged_url?: string | null
    text?: string | null
    image_prompt?: string | null
    stock_search_query?: string | null
    alt_text?: string | null
  }
): PostSlide {
  const slide = getSlide(slideId)
  if (!slide) throw new ApiError(404, 'slide not found')
  const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
  const values: Array<string | number | null> = []
  for (const key of [
    'source_image_url',
    'canvas_json',
    'staged_url',
    'text',
    'image_prompt',
    'stock_search_query',
    'alt_text',
  ] as const) {
    if (key in patch) {
      sets.push(`${key} = ?`)
      values.push(patch[key] ?? null)
    }
  }
  if (values.length === 0) return slide
  values.push(slideId)
  db.prepare(`UPDATE post_slides SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  const updated = getSlide(slideId)
  if (!updated) throw new ApiError(500, 'slide missing after update')
  return updated
}

export function clearStagedUrls(postId: number) {
  db.prepare(
    `UPDATE post_slides SET staged_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE post_id = ?`
  ).run(postId)
}

export function parseCanvas(
  json: string | null | undefined,
  format: PostFormat,
  hook?: string | null
): CanvasDoc {
  if (!json) return defaultCanvasDoc(format, hook)
  try {
    return JSON.parse(json) as CanvasDoc
  } catch {
    return defaultCanvasDoc(format, hook)
  }
}

export function allSlidesHaveSource(postId: number): boolean {
  const slides = listSlides(postId)
  if (slides.length === 0) return false
  return slides.every((s) => !!(s.source_image_url && s.source_image_url.trim()))
}

export function allSlidesHaveStaged(postId: number): boolean {
  const slides = listSlides(postId)
  if (slides.length === 0) return false
  return slides.every((s) => !!(s.staged_url && s.staged_url.trim()))
}

export function slideOutlineTexts(postId: number): string[] {
  return listSlides(postId).map((s, i) => {
    if (s.text?.trim()) return s.text.trim()
    try {
      const doc = JSON.parse(s.canvas_json || '{}') as CanvasDoc
      const hook = doc.layers?.find((l) => l.type === 'hook' || l.id === 'hook')
      if (hook?.text?.trim()) return hook.text.trim()
    } catch {
      /* ignore */
    }
    return `Slide ${i + 1}`
  })
}
