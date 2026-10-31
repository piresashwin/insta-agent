/**
 * Lesson 06 — Policy gate.
 * Answers: is this (actor, action, resource) allowed?
 */
import type { Post } from '@instagram-agent/shared'
import { ApiError } from './orchestrator'
import { appendEvent, completeRun, createRun } from './runs'
import { allSlidesHaveSource, listSlides } from './slides'

export type PolicyRole = 'human' | 'agent'

export type PolicyActor = {
  role: PolicyRole
  id: string
  name?: string
  run_id?: number
}

export type PolicyAction =
  | 'post.draft'
  | 'post.approve'
  | 'post.request_changes'
  | 'post.start_publish'
  | 'media.search'
  | 'media.approve'
  | 'instagram.publish'

export type PolicyResource = {
  type: 'post'
  post: Post
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string }

export const AGENT_PIPELINE: PolicyActor = {
  role: 'agent',
  id: 'agent:pipeline',
  name: 'content-pipeline',
}

const AGENT_ACTIONS: ReadonlySet<PolicyAction> = new Set(['post.draft', 'media.search'])

const HUMAN_ACTIONS: ReadonlySet<PolicyAction> = new Set([
  'post.draft',
  'post.approve',
  'post.request_changes',
  'post.start_publish',
  'media.search',
  'media.approve',
  'instagram.publish',
])

export function can(
  actor: PolicyActor,
  action: PolicyAction,
  resource: PolicyResource
): PolicyDecision {
  if (resource.type !== 'post' || !resource.post) {
    return { allow: false, reason: 'unknown resource' }
  }

  const post = resource.post
  const allowedForRole =
    actor.role === 'agent' ? AGENT_ACTIONS : actor.role === 'human' ? HUMAN_ACTIONS : null

  if (!allowedForRole) {
    return { allow: false, reason: `unknown actor role: ${String((actor as PolicyActor).role)}` }
  }

  if (!allowedForRole.has(action)) {
    return {
      allow: false,
      reason: `role "${actor.role}" cannot perform "${action}"`,
    }
  }

  switch (action) {
    case 'post.approve':
    case 'post.request_changes':
      if (actor.role !== 'human' || !actor.id) {
        return { allow: false, reason: 'human actor.id required' }
      }
      if (action === 'post.approve' && !actor.name) {
        return { allow: false, reason: 'human actor.name required for approve' }
      }
      break

    case 'post.start_publish':
      if (post.status !== 'approved') {
        return {
          allow: false,
          reason: `start_publish requires status "approved", got "${post.status}"`,
        }
      }
      break

    case 'media.approve':
      if (actor.role !== 'human' || !actor.id) {
        return { allow: false, reason: 'human actor.id required for media.approve' }
      }
      if (post.status !== 'media_ready') {
        return {
          allow: false,
          reason: `media.approve requires status "media_ready", got "${post.status}"`,
        }
      }
      {
        const slides = listSlides(post.id)
        const format = (post.format || 'feed') as string
        const min = format === 'carousel' ? 2 : 1
        if (slides.length < min) {
          return {
            allow: false,
            reason: `media.approve needs at least ${min} slide(s) for format "${format}"`,
          }
        }
        if (!allSlidesHaveSource(post.id)) {
          return { allow: false, reason: 'every slide needs source_image_url before media.approve' }
        }
      }
      break

    case 'instagram.publish':
      if (actor.role === 'agent') {
        return { allow: false, reason: 'agent cannot instagram.publish' }
      }
      if (!['staged', 'pending_upload', 'publishing'].includes(post.status)) {
        return {
          allow: false,
          reason: `instagram.publish requires staged media (got "${post.status}")`,
        }
      }
      break

    case 'media.search':
      if (!['approved', 'media_generating', 'media_ready', 'staged'].includes(post.status)) {
        return {
          allow: false,
          reason: `media.search not allowed from status "${post.status}"`,
        }
      }
      break

    case 'post.draft':
      break
  }

  return { allow: true }
}

export function recordPolicyDeny(
  actor: PolicyActor,
  action: PolicyAction,
  resource: PolicyResource,
  reason: string,
  existingRunId?: number | null
): number {
  let runId = existingRunId ?? actor.run_id ?? null
  if (runId == null) {
    const run = createRun({
      goal: `policy deny: ${action}`,
      postId: resource.post.id,
      kind: 'policy',
    })
    runId = run.id
  }

  appendEvent(runId, 'policy_deny', {
    actor: { role: actor.role, id: actor.id, name: actor.name ?? null },
    action,
    reason,
    post_id: resource.post.id,
    post_status: resource.post.status,
  })
  completeRun(runId, 'needs_human', reason)
  return runId
}

export function assertAllowed(
  actor: PolicyActor,
  action: PolicyAction,
  resource: PolicyResource,
  existingRunId?: number | null
): void {
  const decision = can(actor, action, resource)
  if (decision.allow) return

  const runId = recordPolicyDeny(actor, action, resource, decision.reason, existingRunId)
  throw new ApiError(403, `Policy deny: ${decision.reason} (run_id=${runId})`)
}

export function humanFromBody(actor?: { id?: string; name?: string } | null): PolicyActor {
  return {
    role: 'human',
    id: actor?.id || '',
    name: actor?.name,
  }
}
