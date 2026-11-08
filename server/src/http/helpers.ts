import crypto from 'crypto'
import type { Response } from 'express'
import type { Post, PostFormat } from '@instagram-agent/shared'
import { ApiError } from '../orchestrator'
import { parsePromptVars } from '../prompts/format-templates'
import { clampReelDuration } from '../instagram-rules'

/** Lesson 08 — every error response is `{ error: string }`. */
export function sendApiError(res: Response, e: unknown) {
  if (e instanceof ApiError) return res.status(e.status).json({ error: e.message })
  const message = e instanceof Error ? e.message : 'Internal error'
  console.error('[content-agent] unhandled:', message)
  return res.status(500).json({ error: 'Internal server error' })
}

export function generateId() {
  return crypto.randomUUID()
}

/** Field whitelist for PATCH — never status (use transition routes). */
export const PATCHABLE_POST_FIELDS = new Set([
  'topic',
  'angle',
  'hook',
  'hook_alternates',
  'caption',
  'hashtags',
  'format',
  'background_style',
  'image_prompt',
  'stock_search_query',
  'reel_prompt',
  'canvas_json',
  'scene_json',
  'account_id',
  'brand_profile_id',
  'brand_overrides',
  'scheduled_at',
  'pillar',
])

export function normalizeFormat(raw?: string | null): PostFormat {
  if (raw === 'reel' || raw === 'carousel' || raw === 'feed') return raw
  return 'feed'
}

/** Reel clip length + cover time from compiled prompt_vars (one Runware clip, 6–15s). */
export function reelRenderOpts(post: Post): { duration?: number; coverAtSec: number | null } {
  const vars = parsePromptVars(post.prompt_vars)
  if (vars?.format !== 'reel') return { coverAtSec: 1 }
  const cue = vars.timed_cues?.[0]
  const coverAtSec = cue ? ((Number(cue.startSec) || 0) + (Number(cue.endSec) || 2)) / 2 : 1
  return { duration: clampReelDuration(vars.duration), coverAtSec }
}
