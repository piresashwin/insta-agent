/**
 * Lesson 06 — Policy gate.
 * Answers: is this (actor, action, resource) allowed?
 */
import type { BrandProfile, Post } from '@instagram-agent/shared'
import { ApiError } from './orchestrator'
import { appendEvent, completeRun, createRun } from './runs'
import { allSlidesHaveSource, allSlidesHaveStaged, listSlides } from './slides'

export type PolicyRole = 'human' | 'agent' | 'operator_agent'

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
  | 'brand.create'
  | 'brand.update'
  | 'calendar.plan'
  | 'calendar.commit'

export type BrandPolicyRef = Pick<BrandProfile, 'id' | 'name'> | { id?: number; name?: string }

export type PolicyResource =
  | { type: 'post'; post: Post }
  | { type: 'brand'; brand: BrandPolicyRef }

export type PolicyDecision = { allow: true } | { allow: false; reason: string }

export const AGENT_PIPELINE: PolicyActor = {
  role: 'agent',
  id: 'agent:pipeline',
  name: 'content-pipeline',
}

/** Stdio MCP harness operator — human-class; may draft/read, never publish. */
export const MCP_OPERATOR: PolicyActor = {
  role: 'human',
  id: 'mcp:operator',
  name: 'MCP Operator',
}

/**
 * MCP operator_agent role — can draft and request changes but NOT approve or publish.
 * Set MCP_ALLOW_APPROVE=1 to elevate to human-class for trusted automation.
 */
export const MCP_OPERATOR_AGENT: PolicyActor = {
  role: 'operator_agent',
  id: 'mcp:operator_agent',
  name: 'MCP Agent',
}

/** REST dashboard principal when body.actor is omitted. */
export const DASHBOARD_OPERATOR: PolicyActor = {
  role: 'human',
  id: 'dashboard:rest',
  name: 'Dashboard',
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
  'brand.create',
  'brand.update',
  'calendar.plan',
  'calendar.commit',
])

/** operator_agent (MCP): can draft and request changes; cannot approve, publish, or start_publish. */
const OPERATOR_AGENT_ACTIONS: ReadonlySet<PolicyAction> = new Set([
  'post.draft',
  'post.request_changes',
  'media.search',
  'calendar.plan',
])

/** Actions MCP must never perform (defense in depth beyond tool surface). */
const MCP_DENIED_ACTIONS: ReadonlySet<PolicyAction> = new Set([
  'instagram.publish',
  'post.start_publish',
  'post.approve',
  'media.approve',
])

const BRAND_CALENDAR_ACTIONS: ReadonlySet<PolicyAction> = new Set([
  'brand.create',
  'brand.update',
  'calendar.plan',
  'calendar.commit',
])

export function can(
  actor: PolicyActor,
  action: PolicyAction,
  resource: PolicyResource
): PolicyDecision {
  const allowedForRole =
    actor.role === 'agent'
      ? AGENT_ACTIONS
      : actor.role === 'human'
        ? HUMAN_ACTIONS
        : actor.role === 'operator_agent'
          ? OPERATOR_AGENT_ACTIONS
          : null

  if (!allowedForRole) {
    return { allow: false, reason: `unknown actor role: ${String((actor as PolicyActor).role)}` }
  }

  if (!allowedForRole.has(action)) {
    return {
      allow: false,
      reason: `role "${actor.role}" cannot perform "${action}"`,
    }
  }

  // MCP harness: never publish / start_publish even if somehow invoked
  if (actor.id === MCP_OPERATOR.id && MCP_DENIED_ACTIONS.has(action)) {
    return {
      allow: false,
      reason: 'MCP operator cannot publish or start_publish — use the React dashboard',
    }
  }

  if (BRAND_CALENDAR_ACTIONS.has(action)) {
    if (actor.role !== 'human' || !actor.id) {
      return { allow: false, reason: 'human actor.id required for brand/calendar actions' }
    }
    if (resource.type !== 'brand' || !resource.brand) {
      return { allow: false, reason: 'brand resource required' }
    }
    if (
      (action === 'brand.update' || action === 'calendar.plan' || action === 'calendar.commit') &&
      resource.brand.id == null
    ) {
      return { allow: false, reason: 'brand.id required' }
    }
    if (action === 'brand.create' && !(resource.brand.name || '').trim() && resource.brand.id == null) {
      return { allow: false, reason: 'brand name required for create' }
    }
    return { allow: true }
  }

  if (resource.type !== 'post' || !resource.post) {
    return { allow: false, reason: 'unknown resource' }
  }

  const post = resource.post

  switch (action) {
    case 'post.approve':
    case 'post.request_changes':
      if (actor.role !== 'human' || !actor.id) {
        return { allow: false, reason: 'human actor.id required' }
      }
      if (action === 'post.approve' && !actor.name) {
        return { allow: false, reason: 'human actor.name required for approve' }
      }
      if (action === 'post.approve' && (post.format || '') === 'carousel') {
        const slides = listSlides(post.id)
        if (slides.length < 2) {
          return {
            allow: false,
            reason: 'carousel needs at least 2 slides before copy approve',
          }
        }
        const missingText = slides.some((s) => {
          if (s.text?.trim()) return false
          try {
            const doc = JSON.parse(s.canvas_json || '{}') as {
              layers?: Array<{ text?: string }>
            }
            return !doc.layers?.some((l) => l.text?.trim())
          } catch {
            return true
          }
        })
        if (missingText) {
          return {
            allow: false,
            reason: 'every carousel slide needs on-image text before copy approve',
          }
        }
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
        // Reels stage from reel_url (video); stills require per-slide source images.
        if (format === 'reel') {
          if (!(post as { reel_url?: string | null }).reel_url) {
            return { allow: false, reason: 'reel media.approve requires reel_url (generate video first)' }
          }
          break
        }
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
      if ((post.format || '') === 'carousel' && !allSlidesHaveStaged(post.id)) {
        return {
          allow: false,
          reason: 'carousel publish requires staged_url on every slide',
        }
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
  const postId = resource.type === 'post' ? resource.post.id : null
  if (runId == null) {
    const run = createRun({
      goal: `policy deny: ${action}`,
      postId,
      kind: 'policy',
    })
    runId = run.id
  }

  appendEvent(runId, 'policy_deny', {
    actor: { role: actor.role, id: actor.id, name: actor.name ?? null },
    action,
    reason,
    post_id: postId,
    post_status: resource.type === 'post' ? resource.post.status : null,
    brand_id: resource.type === 'brand' ? resource.brand.id ?? null : null,
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

export function humanFromBody(actor?: { id?: string; name?: string; role?: string } | null): PolicyActor {
  const role = actor?.role === 'operator_agent' ? 'operator_agent' : 'human'
  return {
    role,
    id: actor?.id || '',
    name: actor?.name,
  }
}

/** REST actor: body.actor if present, else dashboard principal. */
export function actorFromRequest(actor?: { id?: string; name?: string; role?: string } | null): PolicyActor {
  if (actor?.id) return humanFromBody(actor)
  return { ...DASHBOARD_OPERATOR }
}
