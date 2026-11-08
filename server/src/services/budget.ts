/**
 * Phase 2 — budget estimate, month-to-date, pre-flight downgrade/block.
 */
import db from '../db'
import { ApiError } from '../orchestrator'

export type BudgetScope = 'prod' | 'eval'

export type CostEstimate = {
  estimate: number
  kind: string
  tier?: 'full' | 'downgraded' | 'floor'
  detail?: Record<string, unknown>
}

export type PreflightResult =
  | { ok: true; estimate: CostEstimate; spent: number; cap: number; remaining: number }
  | {
      ok: false
      reason: 'needs_budget_approval'
      estimate: CostEstimate
      spent: number
      cap: number
      remaining: number
    }
  | {
      ok: true
      downgraded: true
      estimate: CostEstimate
      spent: number
      cap: number
      remaining: number
    }

function getSetting(key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? fallback
}

export function monthlyCap(): number {
  return parseFloat(getSetting('budget_monthly_usd', '10'))
}

export function monthlySpend(scope: BudgetScope = 'prod'): number {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd),0) AS total FROM spend_ledger WHERE budget_scope=? AND estimated=0 AND created_at >= ?",
    )
    .get(scope, start.toISOString()) as { total: number }
  return row.total
}

export function estimateJobCost(opts: {
  kind: string
  format?: string | null
  duration_sec?: number
  tier?: 'full' | 'downgraded' | 'floor'
}): CostEstimate {
  const tier = opts.tier ?? 'full'
  const kind = opts.kind
  let estimate = 0.01
  const detail: Record<string, unknown> = { tier }

  switch (kind) {
    case 'agent_run':
      estimate = 0.05
      break
    case 'generate_media': {
      if (opts.format === 'reel') {
        const fullDur = Math.min(Math.max(Number(opts.duration_sec || 8), 6), 15)
        const dur = tier === 'full' ? fullDur : tier === 'downgraded' ? Math.min(fullDur, 6) : 6
        estimate = dur * 0.04
        detail.duration_sec = dur
      } else if (opts.format === 'carousel') {
        // full = all slides as images; downgraded = 2 backgrounds; floor = 1
        const slides = tier === 'full' ? 5 : tier === 'downgraded' ? 2 : 1
        estimate = slides * 0.02
        detail.slides = slides
      } else {
        estimate = 0.02
      }
      break
    }
    case 'publish_post':
      estimate = 0
      break
    case 'fill_week': {
      if (tier === 'full') estimate = 7 * 0.05 + 2 * 0.43 + 2 * 0.05
      else if (tier === 'downgraded') estimate = 7 * 0.05 + 1 * 0.24 + 2 * 0.05
      else estimate = 5 * 0.05 + 0.02
      break
    }
    default:
      estimate = 0.01
  }

  return { estimate, kind, tier, detail }
}

/**
 * Pre-flight: try full → downgrade → floor. Block with needs_budget_approval if still over.
 */
export function preflightPaidJob(opts: {
  kind: string
  format?: string | null
  duration_sec?: number
  scope?: BudgetScope
}): PreflightResult {
  const scope = opts.scope ?? 'prod'
  const spent = monthlySpend(scope)
  const cap = monthlyCap()
  const remaining = Math.max(0, cap - spent)

  const full = estimateJobCost({ ...opts, tier: 'full' })
  if (spent + full.estimate <= cap) {
    return { ok: true, estimate: full, spent, cap, remaining }
  }

  const down = estimateJobCost({ ...opts, tier: 'downgraded' })
  if (spent + down.estimate <= cap) {
    return { ok: true, downgraded: true, estimate: down, spent, cap, remaining }
  }

  const floor = estimateJobCost({ ...opts, tier: 'floor' })
  if (spent + floor.estimate <= cap) {
    return { ok: true, downgraded: true, estimate: floor, spent, cap, remaining }
  }

  return {
    ok: false,
    reason: 'needs_budget_approval',
    estimate: floor,
    spent,
    cap,
    remaining,
  }
}

export function recordSpend(opts: {
  kind: 'text' | 'image' | 'video'
  provider: string
  model: string
  cost_usd: number
  post_id?: number | null
  job_id?: number | null
  estimated?: boolean
  budget_scope?: BudgetScope
}): number {
  const info = db
    .prepare(
      `INSERT INTO spend_ledger (kind, provider, model, cost_usd, post_id, job_id, estimated, budget_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.kind,
      opts.provider,
      opts.model,
      opts.cost_usd,
      opts.post_id ?? null,
      opts.job_id ?? null,
      opts.estimated ? 1 : 0,
      opts.budget_scope ?? 'prod',
    )
  return Number(info.lastInsertRowid)
}

/** Count completed generate_media jobs for a post (each counts toward re-roll cap). */
export function countMediaGenerations(postId: string | number): number {
  const fromJobs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE post_id = ? AND kind = 'generate_media' AND status = 'done'`,
    )
    .get(Number(postId)) as { n: number }
  if (fromJobs.n > 0) return fromJobs.n
  // Fallback: spend ledger image/video rows for this post
  const fromSpend = db
    .prepare(
      `SELECT COUNT(*) AS n FROM spend_ledger
       WHERE post_id = ? AND kind IN ('image','video') AND estimated = 0`,
    )
    .get(Number(postId)) as { n: number }
  return fromSpend.n
}

/**
 * Block when prior generations already hit the configured re-roll cap.
 * First call sees count=0; after `max` completed gens, the next is rejected.
 */
export function assertRerollAllowed(postId: string | number, format?: string | null): void {
  const isReel = (format || '') === 'reel'
  const key = isReel ? 'budget_max_reel_rerolls' : 'budget_max_image_rerolls'
  const max = parseInt(getSetting(key, isReel ? '1' : '2'), 10)
  const prior = countMediaGenerations(postId)
  if (prior >= max) {
    throw new ApiError(
      409,
      `Re-roll limit reached (${prior}/${max} ${isReel ? 'reel' : 'image'} generations). Raise the cap in Settings or start a new post.`,
    )
  }
}

/** Mark a post as needing budget approval (soft status via error + stay put). */
export function markNeedsBudgetApproval(postId: string | number, detail: string): void {
  db.prepare(
    `UPDATE posts SET error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(`needs_budget_approval: ${detail}`, postId)
}

export function assertWithinBudgetOrThrow(result: PreflightResult): asserts result is Extract<
  PreflightResult,
  { ok: true }
> {
  if (!result.ok) {
    throw new ApiError(
      402,
      `Budget cap reached (spent $${result.spent.toFixed(2)} / $${result.cap.toFixed(2)}; need ~$${result.estimate.estimate.toFixed(2)}). Needs budget approval.`,
    )
  }
}

/** Reduce reel count in a format mix when remaining budget is low. */
export function budgetAwareFormatMix(
  mix: Record<string, number>,
  remainingUsd: number,
): Record<string, number> {
  const out = { ...mix }
  const reelCost = 0.24 // ~6s downgraded reel
  const reels = Number(out.reel || out.reels || 0)
  if (reels <= 0) return out

  const maxReels = Math.max(0, Math.floor(remainingUsd / reelCost))
  const capped = Math.min(reels, maxReels)
  if ('reel' in out) out.reel = capped
  if ('reels' in out) out.reels = capped
  return out
}
