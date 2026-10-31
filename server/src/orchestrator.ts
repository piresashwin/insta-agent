/**
 * Lesson 05 — Orchestrator: durable post lifecycle.
 * Domain status lives here. Cognition fills fields; it never invents transitions.
 */
import type { Actor, Post, PostStatus } from '@instagram-agent/shared'
import db from './db'

/** Max human revision rounds before the post parks on needs_revision (Lesson 07). */
export const MAX_REVISIONS = 3

/** Legal edges of the post status machine. */
export const VALID_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'changes_requested', 'needs_revision'],
  changes_requested: ['pending_approval'],
  needs_revision: ['draft'],
  approved: ['media_generating', 'draft'],
  media_generating: ['media_ready'],
  // Compose → approve media → staged; or regenerate stock.
  media_ready: ['staged', 'media_generating'],
  staged: ['pending_upload', 'media_ready', 'media_generating'],
  pending_upload: ['publishing'],
  publishing: ['published', 'failed'],
  published: [],
  failed: ['staged', 'media_ready', 'draft'],
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type TransitionOpts = {
  actor?: Partial<Actor>
  patch?: Record<string, string | number | null>
}

export function getPost(id: string | number): Post | null {
  return (db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Post | undefined) || null
}

export function validateTransition(
  post: Post,
  newStatus: PostStatus,
  actor: Partial<Actor> = {}
) {
  const allowed = VALID_TRANSITIONS[post.status] || []
  if (!allowed.includes(newStatus)) {
    throw new ApiError(
      409,
      `Invalid transition: "${post.status}" -> "${newStatus}". Allowed: [${allowed.join(', ')}]`
    )
  }
  if (newStatus === 'approved') {
    if (!actor.id || !actor.name) {
      throw new ApiError(400, 'Approval requires an actor: {id, name}')
    }
  }
  return true
}

export function transitionPost(
  id: string | number,
  next: PostStatus,
  opts: TransitionOpts = {}
): Post {
  const post = getPost(id)
  if (!post) throw new ApiError(404, 'post not found')

  validateTransition(post, next, opts.actor || {})

  const patch = { ...(opts.patch || {}) }
  const sets: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP']
  const values: Array<string | number | null> = [next]

  if (next === 'approved') {
    sets.push('approved_by = ?', 'approved_at = CURRENT_TIMESTAMP')
    values.push(opts.actor!.id!)
  }

  const allowedPatch = new Set([
    'hook',
    'hook_alternates',
    'caption',
    'hashtags',
    'format',
    'background_style',
    'image_prompt',
    'stock_search_query',
    'reel_prompt',
    'image_url',
    'source_image_url',
    'reel_url',
    'media_type',
    'media_provider',
    'canvas_json',
    'instagram_media_id',
    'revision_comments',
    'agent_output',
    'error',
    'topic',
    'account_id',
  ])

  for (const [key, value] of Object.entries(patch)) {
    if (!allowedPatch.has(key)) {
      throw new ApiError(400, `patch field not allowed: ${key}`)
    }
    sets.push(`${key} = ?`)
    values.push(value)
  }

  values.push(id)
  db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  const updated = getPost(id)
  if (!updated) throw new ApiError(500, 'post missing after transition')
  return updated
}

/**
 * Soft field update without going through status edge validation when status unchanged.
 * Uses direct UPDATE for PATCH routes.
 */
export function updatePostFields(
  id: string | number,
  patch: Record<string, string | number | null>
): Post {
  const post = getPost(id)
  if (!post) throw new ApiError(404, 'post not found')

  const allowedPatch = new Set([
    'hook',
    'hook_alternates',
    'caption',
    'hashtags',
    'format',
    'background_style',
    'image_prompt',
    'stock_search_query',
    'reel_prompt',
    'image_url',
    'source_image_url',
    'reel_url',
    'media_type',
    'media_provider',
    'canvas_json',
    'instagram_media_id',
    'revision_comments',
    'agent_output',
    'error',
    'topic',
    'account_id',
    'brand_profile_id',
    'brand_overrides',
    'scheduled_at',
    'pillar',
  ])

  const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
  const values: Array<string | number | null> = []
  for (const [key, value] of Object.entries(patch)) {
    if (!allowedPatch.has(key)) {
      throw new ApiError(400, `patch field not allowed: ${key}`)
    }
    sets.push(`${key} = ?`)
    values.push(value)
  }
  if (values.length === 0) throw new ApiError(400, 'no fields to update')
  values.push(id)
  db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  const updated = getPost(id)
  if (!updated) throw new ApiError(500, 'post missing after update')
  return updated
}

export function canStartAgentRun(post: Post): boolean {
  return post.status === 'draft' || post.status === 'changes_requested'
}
