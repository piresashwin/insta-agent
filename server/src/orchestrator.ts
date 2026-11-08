/**
 * Lesson 05 — Orchestrator: durable post lifecycle.
 * Domain status lives here. Cognition fills fields; it never invents transitions.
 */
import type { Actor, Post, PostStatus } from '@instagram-agent/shared'
import db from './db'
import { assertMediaApprovalForStage } from './services/approvals'
import { bumpAndSnapshot } from './services/versions'
import { historyActorFrom } from './services/attribution'

/** Max human revision rounds before the post parks on needs_revision (Lesson 07). */
export const MAX_REVISIONS = 3

/**
 * Statuses where copy fields may be edited by humans or the agent.
 * Any status not in this set is "locked" — PATCH must be rejected with 409.
 */
const EDITABLE_STATUSES = new Set<PostStatus>([
  'draft',
  'pending_approval',
  'changes_requested',
  'needs_revision',
])

/**
 * Fields the media job may write while status is `media_generating`.
 * Copy/content fields stay locked so HITL copy approval is not invalidated mid-render.
 */
const MEDIA_GENERATING_WRITABLE = new Set([
  'source_image_url',
  'image_url',
  'reel_url',
  'reel_quality',
  'media_type',
  'media_provider',
  'media_qa',
  'error',
  'prompt_vars',
  'image_prompt',
  'reel_prompt',
  'canvas_json',
  'scene_json',
])

/**
 * Guard for every PATCH route.
 * Throws 409 if the post is in a terminal or locked state.
 * Pass `fields` to get a helpful error message; omit to check the post as a whole.
 */
export function assertEditable(post: Post, fields?: string[]): void {
  if (EDITABLE_STATUSES.has(post.status as PostStatus)) return
  if (
    post.status === 'media_generating' &&
    fields?.length &&
    fields.every((f) => MEDIA_GENERATING_WRITABLE.has(f))
  ) {
    return
  }
  const what = fields?.length ? ` (${fields.join(', ')})` : ''
  throw new ApiError(
    409,
    `Post ${post.id} is ${post.status} and cannot be edited${what}. ` +
      `To make changes, restart the post to draft first.`,
  )
}

/** Legal edges of the post status machine. */
export const VALID_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ['pending_approval'],
  // Human may restart/regenerate back to draft (clears copy via /restart).
  pending_approval: ['approved', 'changes_requested', 'needs_revision', 'draft'],
  changes_requested: ['pending_approval', 'draft'],
  needs_revision: ['draft'],
  approved: ['media_generating', 'draft'],
  media_generating: ['media_ready', 'draft'],
  // Compose → approve media → staged; or regenerate stock / restart to draft.
  media_ready: ['staged', 'media_generating', 'draft'],
  staged: ['pending_upload', 'media_ready', 'media_generating', 'draft'],
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

export function listPosts(opts: { status?: string | null; limit?: number } = {}): Post[] {
  const lim = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
  if (opts.status?.trim()) {
    return db
      .prepare(
        'SELECT * FROM posts WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?'
      )
      .all(opts.status.trim(), lim) as Post[]
  }
  return db
    .prepare('SELECT * FROM posts ORDER BY updated_at DESC, id DESC LIMIT ?')
    .all(lim) as Post[]
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
  opts: TransitionOpts & { skipVersionBump?: boolean } = {}
): Post {
  const post = getPost(id)
  if (!post) throw new ApiError(404, 'post not found')

  validateTransition(post, next, opts.actor || {})

  // Phase 2 media gate: cannot enter staged without a media approval of the current version.
  if (next === 'staged' && post.status === 'media_ready') {
    assertMediaApprovalForStage(id)
  }

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
    'reel_quality',
    'media_type',
    'media_provider',
    'canvas_json',
    'scene_json',
    'prompt_vars',
    'angle',
    'instagram_media_id',
    'instagram_creation_id',
    'instagram_permalink',
    'instagram_shortcode',
    'instagram_published_at',
    'instagram_children_ids',
    'revision_comments',
    'agent_output',
    'alt_text',
    'media_qa',
    'error',
    'topic',
    'account_id',
    'approved_by',
    'approved_at',
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

  let updated = getPost(id)
  if (!updated) throw new ApiError(500, 'post missing after transition')

  // Snapshot content-affecting transitions only. Do NOT bump on media_ready/staged —
  // that would invalidate a just-recorded media approval of the current version.
  if (
    !opts.skipVersionBump &&
    (next === 'pending_approval' || next === 'approved' || next === 'changes_requested')
  ) {
    updated = bumpAndSnapshot(
      id,
      historyActorFrom(
        opts.actor
          ? { id: opts.actor.id, name: opts.actor.name }
          : { id: 'system', name: 'system', role: 'agent' },
      ),
    )
  }

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
  assertEditable(post, Object.keys(patch))

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
    'reel_quality',
    'media_type',
    'media_provider',
    'canvas_json',
    'scene_json',
    'prompt_vars',
    'angle',
    'instagram_media_id',
    'instagram_creation_id',
    'instagram_permalink',
    'instagram_shortcode',
    'instagram_published_at',
    'instagram_children_ids',
    'revision_comments',
    'agent_output',
    'alt_text',
    'media_qa',
    'error',
    'topic',
    'account_id',
    'brand_profile_id',
    'brand_overrides',
    'scheduled_at',
    'pillar',
    'approved_by',
    'approved_at',
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

/**
 * Human/content edit with version bump + snapshot (PATCH and explicit editors).
 * Prefer this over updatePostFields when the change must invalidate approvals.
 */
export function updatePostContent(
  id: string | number,
  patch: Record<string, string | number | null>,
  actor?: { id?: string; name?: string },
): Post {
  updatePostFields(id, patch)
  return bumpAndSnapshot(
    id,
    historyActorFrom(
      actor
        ? { id: actor.id, name: actor.name }
        : { id: 'dashboard:rest', name: 'Dashboard' },
    ),
  )
}

export function canStartAgentRun(post: Post): boolean {
  return post.status === 'draft' || post.status === 'changes_requested'
}
