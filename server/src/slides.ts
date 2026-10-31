/** Durable post slides (feed/reel = 1, carousel = 2–10). */
import type { CanvasDoc, PostFormat, PostSlide } from '@instagram-agent/shared'
import { defaultCanvasDoc } from '@instagram-agent/shared'
import db from './db'
import { ApiError } from './orchestrator'

export type CarouselSlidePlan = {
  text?: string | null
  image_prompt?: string | null
  stock_search_query?: string | null
}

export function listSlides(postId: number | string): PostSlide[] {
  return db
    .prepare('SELECT * FROM post_slides WHERE post_id = ? ORDER BY position ASC')
    .all(Number(postId)) as PostSlide[]
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
  hook?: string | null
): PostSlide[] {
  const existing = listSlides(postId)
  const min = format === 'carousel' ? 2 : 1
  if (existing.length >= min) return existing

  const insert = db.prepare(
    `INSERT INTO post_slides (post_id, position, canvas_json, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
  )
  for (let i = existing.length; i < min; i++) {
    const label =
      format === 'carousel' && i > 0
        ? `${(hook || 'Slide').trim()} · ${i + 1}`
        : hook
    insert.run(postId, i, JSON.stringify(defaultCanvasDoc(format, label)))
  }
  return listSlides(postId)
}

/**
 * Pad/update carousel rows from agent slide plan (distinct on-image text per slide).
 * Does not touch source_image_url / staged_url.
 */
export function applyCarouselSlidePlan(
  postId: number,
  plan: CarouselSlidePlan[],
  fallbackHook?: string | null
): PostSlide[] {
  const count = Math.min(10, Math.max(2, plan.length || 2))
  let slides = listSlides(postId)
  while (slides.length < count) {
    const i = slides.length
    const text =
      plan[i]?.text?.trim() ||
      (i === 0 ? fallbackHook : `${(fallbackHook || 'Slide').trim()} · ${i + 1}`)
    addSlide(postId, 'carousel', text)
    slides = listSlides(postId)
  }
  for (let i = 0; i < count; i++) {
    const text =
      plan[i]?.text?.trim() ||
      (i === 0 ? fallbackHook : `${(fallbackHook || 'Slide').trim()} · ${i + 1}`)
    // Only rewrite canvas when slide has no custom layers yet or still empty source —
    // always set text for freshly planned carousels from agent finish.
    updateSlide(slides[i].id, {
      canvas_json: JSON.stringify(defaultCanvasDoc('carousel', text)),
    })
  }
  return listSlides(postId)
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
      `INSERT INTO post_slides (post_id, position, canvas_json, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .run(postId, position, canvas)
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
  // Re-pack positions
  const remaining = listSlides(postId)
  const upd = db.prepare('UPDATE post_slides SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
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
  }
): PostSlide {
  const slide = getSlide(slideId)
  if (!slide) throw new ApiError(404, 'slide not found')
  const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
  const values: Array<string | number | null> = []
  for (const key of ['source_image_url', 'canvas_json', 'staged_url'] as const) {
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

export function parseCanvas(json: string | null | undefined, format: PostFormat, hook?: string | null): CanvasDoc {
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
