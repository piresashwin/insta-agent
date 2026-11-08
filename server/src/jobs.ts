/**
 * Phase 2 — Job runner.
 *
 * Express is the single worker; MCP adds jobs through ApiClient.
 * - Jobs are claimed atomically (BEGIN IMMEDIATE + UPDATE).
 * - Leases renew every 20 s; orphaned work recovers via expired leases.
 * - Backoff: 30 s, 2 min, 10 min.
 */
import db from './db'
import { startAgentRunOnPost } from './agent/start-run'
import { getPost } from './orchestrator'
import { AGENT_PIPELINE } from './policy'
import { assertPublishApprovals, hasApproval } from './services/approvals'
import {
  assertWithinBudgetOrThrow,
  markNeedsBudgetApproval,
  preflightPaidJob,
} from './services/budget'
import { SCHEDULER_ACTOR } from './services/attribution'

const LEASE_SEC = 25
const WORKER_ID = `express:${process.pid}`
const BACKOFF_S = [30, 120, 600]

export type JobKind =
  | 'agent_run'
  | 'publish_post'
  | 'generate_media'
  | 'fetch_media'
  | 'sync_media_insights'
  | 'sync_account_insights'
  | 'sync_audience_insights'
  | 'refresh_token'

export type JobRow = {
  id: number
  kind: string
  payload_json: string
  status: string
  priority: number
  run_at: string
  attempts: number
  max_attempts: number
  lease_owner: string | null
  lease_expires_at: string | null
  dedupe_key: string | null
  result_json: string | null
  error: string | null
  post_id: number | null
  run_id: number | null
  budget_scope: string
  created_at: string
  updated_at: string | null
}

/** Add a job, deduplicating on dedupe_key when provided. */
export function enqueueJob(opts: {
  kind: JobKind
  payload?: Record<string, unknown>
  post_id?: number | null
  run_id?: number | null
  priority?: number
  run_at?: string
  dedupe_key?: string
  max_attempts?: number
  budget_scope?: string
}): number {
  if (opts.dedupe_key) {
    const existing = db
      .prepare(
        "SELECT id FROM jobs WHERE dedupe_key = ? AND status NOT IN ('done','failed','cancelled')",
      )
      .get(opts.dedupe_key) as { id: number } | undefined
    if (existing) return existing.id

    // Column is UNIQUE for all rows — free the key from terminal jobs so we can re-enqueue.
    db.prepare(
      "UPDATE jobs SET dedupe_key = NULL WHERE dedupe_key = ? AND status IN ('done','failed','cancelled')",
    ).run(opts.dedupe_key)
  }

  const info = db
    .prepare(
      `INSERT INTO jobs
        (kind, payload_json, post_id, run_id, priority, run_at, max_attempts, dedupe_key, budget_scope, updated_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .run(
      opts.kind,
      JSON.stringify(opts.payload ?? {}),
      opts.post_id ?? null,
      opts.run_id ?? null,
      opts.priority ?? 0,
      opts.run_at ?? null,
      opts.max_attempts ?? 3,
      opts.dedupe_key ?? null,
      opts.budget_scope ?? 'prod',
    )
  return Number(info.lastInsertRowid)
}

/** Cancel pending jobs for a post of a given kind. */
export function cancelJobsForPost(postId: number, kind?: JobKind): void {
  if (kind) {
    db.prepare(
      "UPDATE jobs SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE post_id=? AND kind=? AND status='pending'",
    ).run(postId, kind)
  } else {
    db.prepare(
      "UPDATE jobs SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE post_id=? AND status='pending'",
    ).run(postId)
  }
}

/** Claim one ready job (atomic). Returns null if nothing to run. Exported for tests. */
export function claimJob(): JobRow | null {
  const now = new Date().toISOString()
  const expiry = new Date(Date.now() + LEASE_SEC * 1000).toISOString()

  let claimed: JobRow | null = null
  try {
    db.exec('BEGIN IMMEDIATE')
    const row = db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending'
           AND (run_at IS NULL OR run_at <= ?)
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)
         ORDER BY priority DESC, run_at ASC
         LIMIT 1`,
      )
      .get(now, now) as JobRow | undefined

    if (!row) {
      db.exec('ROLLBACK')
      return null
    }

    db.prepare(
      `UPDATE jobs
       SET status='running', lease_owner=?, lease_expires_at=?,
           attempts = attempts + 1, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    ).run(WORKER_ID, expiry, row.id)
    db.exec('COMMIT')
    claimed = { ...row, status: 'running', lease_owner: WORKER_ID, attempts: row.attempts + 1 }
  } catch {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    return null
  }
  return claimed
}

export function renewLease(jobId: number): void {
  const expiry = new Date(Date.now() + LEASE_SEC * 1000).toISOString()
  db.prepare(
    "UPDATE jobs SET lease_expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
  ).run(expiry, jobId)
}

export function completeJob(jobId: number, result: unknown): void {
  db.prepare(
    "UPDATE jobs SET status='done', result_json=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(JSON.stringify(result), jobId)
}

export function failJob(
  jobId: number,
  error: string,
  attempts: number,
  maxAttempts: number,
): void {
  if (attempts < maxAttempts) {
    const backoffSec = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)]
    const retryAt = new Date(Date.now() + backoffSec * 1000).toISOString()
    db.prepare(
      "UPDATE jobs SET status='pending', error=?, lease_owner=NULL, lease_expires_at=NULL, run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).run(error, retryAt, jobId)
  } else {
    const job = db
      .prepare('SELECT kind, post_id FROM jobs WHERE id = ?')
      .get(jobId) as { kind: string; post_id: number | null } | undefined
    db.prepare(
      "UPDATE jobs SET status='failed', error=?, lease_owner=NULL, lease_expires_at=NULL, dedupe_key=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).run(error, jobId)
    // Unstick posts left in media_generating when the job is exhausted.
    if (job?.kind === 'generate_media' && job.post_id != null) {
      db.prepare(
        `UPDATE posts
         SET status = 'approved',
             error = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'media_generating'`,
      ).run(error.slice(0, 500), job.post_id)
    }
  }
}

/** Recover jobs whose lease expired (previous worker crashed). */
export function recoverExpiredLeases(): void {
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE jobs SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE status='running' AND lease_expires_at < ?`,
  ).run(now)
}

// --------------- Job handlers ---------------

async function handleAgentRun(payload: Record<string, unknown>): Promise<unknown> {
  const postId = Number(payload.post_id)
  if (!Number.isFinite(postId)) throw new Error('agent_run: post_id required')
  const runId = payload.run_id != null ? Number(payload.run_id) : undefined
  const initiator = (payload.initiator as { id?: string; name?: string; role?: string } | null) || null

  let result: ReturnType<typeof startAgentRunOnPost>
  try {
    result = startAgentRunOnPost(postId, {
      inline: true,
      existingRunId: runId && Number.isFinite(runId) ? runId : undefined,
      initiator: initiator?.id
        ? {
            role: (initiator.role as 'human' | 'agent' | 'operator_agent') || 'human',
            id: initiator.id,
            name: initiator.name,
          }
        : AGENT_PIPELINE,
    })
  } catch (e) {
    if (runId && Number.isFinite(runId)) {
      const { completeRun } = await import('./runs')
      completeRun(runId, 'failed', e instanceof Error ? e.message : String(e))
    }
    throw e
  }
  if (result.done) await result.done
  const { getRun } = await import('./runs')
  const run = getRun(result.run_id)
  return {
    run_id: result.run_id,
    run_status: run?.status ?? null,
    note: result.note,
  }
}

async function handleGenerateMedia(payload: Record<string, unknown>): Promise<unknown> {
  const postId = Number(payload.post_id)
  if (!Number.isFinite(postId)) throw new Error('generate_media: post_id required')

  const studioAction = payload.studio_action
  if (studioAction === 'generate-background' || studioAction === 'variations') {
    const { executeStudioGenerateJob } = await import('./services/studio-generate')
    return executeStudioGenerateJob({
      postId,
      action: studioAction,
      brief: typeof payload.brief === 'string' ? payload.brief : null,
    })
  }

  const { executeGenerateMediaJob } = await import('./services/generate-media')
  return executeGenerateMediaJob({
    postId,
    provider: typeof payload.provider === 'string' ? payload.provider : undefined,
    quality: typeof payload.quality === 'string' ? payload.quality : undefined,
    bake_only: payload.bake_only === true,
    tier: payload.budget_tier === 'downgraded' || payload.budget_tier === 'floor'
      ? payload.budget_tier
      : 'full',
    actor: (payload.actor as { id?: string; name?: string } | undefined) || {
      id: 'job:generate_media',
      name: 'Job worker',
    },
  })
}

/** Run fetch-media inline via the same Express process (async:false) to avoid duplicating the large route. */
async function handleFetchMedia(payload: Record<string, unknown>): Promise<unknown> {
  const postId = Number(payload.post_id)
  if (!Number.isFinite(postId)) throw new Error('fetch_media: post_id required')
  const base = (process.env.API_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.OPERATOR_TOKEN) {
    headers.Authorization = `Bearer ${process.env.OPERATOR_TOKEN}`
  }
  const { async: _a, post_id: _p, ...rest } = payload
  const res = await fetch(`${base}/api/posts/${postId}/fetch-media`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...rest, async: false }),
  })
  const text = await res.text()
  let data: unknown = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const err = (data as { error?: string }).error || `fetch_media HTTP ${res.status}`
    throw new Error(err)
  }
  return data
}

async function handlePublishPost(
  payload: Record<string, unknown>,
  jobId: number,
  leaseTimer: ReturnType<typeof setInterval>,
): Promise<unknown> {
  const postId = Number(payload.post_id)
  if (!Number.isFinite(postId)) throw new Error('publish_post: post_id required')
  const post = getPost(postId)
  if (!post) throw new Error(`publish_post: post ${postId} not found`)
  if (!['staged', 'pending_upload', 'publishing'].includes(post.status)) {
    throw new Error(`publish_post: post ${postId} is ${post.status}, not staged`)
  }

  // HITL gate — copy + media approval of current version
  assertPublishApprovals(postId)

  const { db: _db } = await import('./db')
  const connRow = _db
    .prepare('SELECT * FROM instagram_conn WHERE id = ? OR default_brand_profile_id = ? LIMIT 1')
    .get(post.account_id ?? '', post.brand_profile_id ?? '') as Record<string, unknown> | undefined
  if (!connRow) throw new Error(`publish_post: no Instagram connection for post ${postId}`)

  const { publishPostToInstagram } = await import('./instagram-publish')
  clearInterval(leaseTimer)
  const publishLeaseTimer = setInterval(() => renewLease(jobId), 10_000)
  try {
    const result = await publishPostToInstagram({
      conn: connRow as Parameters<typeof publishPostToInstagram>[0]['conn'],
      post,
    })
    clearInterval(publishLeaseTimer)
    return { ...result, actor: SCHEDULER_ACTOR }
  } catch (e) {
    clearInterval(publishLeaseTimer)
    throw e
  }
}

export async function runJob(job: JobRow): Promise<void> {
  const leaseTimer = setInterval(() => renewLease(job.id), 10_000)
  const payload = JSON.parse(job.payload_json || '{}') as Record<string, unknown>
  try {
    // Budget pre-flight for paid kinds
    if (job.kind === 'agent_run' || job.kind === 'generate_media') {
      const post = job.post_id != null ? getPost(job.post_id) : null
      const preflight = preflightPaidJob({
        kind: job.kind,
        format: post?.format,
        duration_sec: undefined,
        scope: (job.budget_scope as 'prod' | 'eval') || 'prod',
      })
      if (!preflight.ok) {
        if (job.post_id != null) {
          markNeedsBudgetApproval(
            job.post_id,
            `cap $${preflight.cap}, spent $${preflight.spent.toFixed(2)}`,
          )
        }
        assertWithinBudgetOrThrow(preflight)
      }
      if ('downgraded' in preflight && preflight.downgraded) {
        payload.budget_tier = preflight.estimate.tier
      }
    }

    let result: unknown
    switch (job.kind as JobKind) {
      case 'agent_run':
        result = await handleAgentRun(payload)
        break
      case 'publish_post':
        result = await handlePublishPost(payload, job.id, leaseTimer)
        break
      case 'generate_media':
        result = await handleGenerateMedia(payload)
        break
      case 'fetch_media':
        result = await handleFetchMedia(payload)
        break
      case 'sync_media_insights': {
        const { handleSyncMediaInsights } = await import('./insights/sync')
        result = await handleSyncMediaInsights({
          media_id: String(payload.media_id),
          period_label: String(payload.period_label),
        })
        break
      }
      case 'sync_account_insights': {
        const { handleSyncAccountInsights } = await import('./insights/sync')
        result = await handleSyncAccountInsights({
          account_id: String(payload.account_id),
          date: String(payload.date),
        })
        break
      }
      case 'sync_audience_insights': {
        const { handleSyncAudienceInsights } = await import('./insights/sync')
        result = await handleSyncAudienceInsights({
          account_id: String(payload.account_id),
        })
        break
      }
      case 'refresh_token': {
        const { handleRefreshToken } = await import('./insights/sync')
        const refreshed = await handleRefreshToken({
          connection_id: Number(payload.connection_id),
        })
        if (!refreshed.ok) {
          // Recorded last_error already — fail the job so backoff retries, without uncaught throw
          throw new Error(refreshed.error || 'token refresh failed')
        }
        result = refreshed
        break
      }
      default:
        // Unknown kind → fail without throwing out of the worker loop
        clearInterval(leaseTimer)
        failJob(job.id, `Unknown job kind: ${job.kind}`, job.max_attempts, job.max_attempts)
        return
    }
    clearInterval(leaseTimer)
    completeJob(job.id, result)
  } catch (e) {
    clearInterval(leaseTimer)
    const msg = e instanceof Error ? e.message : String(e)
    failJob(job.id, msg, job.attempts, job.max_attempts)
  }
}

// --------------- Scheduler ---------------

export function schedulerTick(): void {
  const now = new Date().toISOString()
  // Publish staged posts whose scheduled_at has passed + have both copy+media approvals
  const due = db
    .prepare(
      `SELECT p.id, p.version FROM posts p
       WHERE p.status = 'staged'
         AND p.scheduled_at IS NOT NULL
         AND p.scheduled_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.post_id = p.id
             AND j.kind = 'publish_post'
             AND j.status NOT IN ('done','failed','cancelled')
         )
       LIMIT 20`,
    )
    .all(now) as Array<{ id: number; version: number }>

  for (const { id, version } of due) {
    const ver = Number(version ?? 1)
    if (!hasApproval(id, 'copy', ver) || !hasApproval(id, 'media', ver)) {
      continue
    }
    enqueueJob({
      kind: 'publish_post',
      post_id: id,
      payload: { post_id: id, actor: SCHEDULER_ACTOR },
      dedupe_key: `publish:${id}`,
    })
  }
}

// --------------- Worker loop ---------------

let workerTimer: ReturnType<typeof setInterval> | null = null
let schedulerTimer: ReturnType<typeof setInterval> | null = null
let insightsTimer: ReturnType<typeof setInterval> | null = null
let busy = false

export function startJobWorker(
  opts: { tickMs?: number; schedulerMs?: number; insightsMs?: number } = {},
): void {
  if (workerTimer) return

  const tickMs = opts.tickMs ?? 2_000
  const schedulerMs = opts.schedulerMs ?? 15_000
  const insightsMs = opts.insightsMs ?? 30 * 60_000

  recoverExpiredLeases()

  workerTimer = setInterval(() => {
    if (busy) return
    busy = true
    const job = claimJob()
    if (!job) {
      busy = false
      return
    }
    runJob(job).finally(() => {
      busy = false
    })
  }, tickMs)

  schedulerTimer = setInterval(() => {
    try {
      schedulerTick()
    } catch (err) {
      console.error('[jobs] scheduler tick failed:', err)
    }
  }, schedulerMs)
  try {
    schedulerTick()
  } catch (err) {
    console.error('[jobs] scheduler tick failed:', err)
  }

  const runInsights = () => {
    try {
      // Dynamic import avoids circular load with insights/scheduler → enqueueJob
      void import('./insights/scheduler').then((m) => m.insightsSchedulerTick())
    } catch (err) {
      console.error('[jobs] insights scheduler tick failed:', err)
    }
  }
  insightsTimer = setInterval(runInsights, insightsMs)
  runInsights()
}

export function stopJobWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
  if (insightsTimer) {
    clearInterval(insightsTimer)
    insightsTimer = null
  }
}

/** List recent jobs (for the admin/debug route). */
export function listJobs(opts: { limit?: number; status?: string; post_id?: number } = {}): JobRow[] {
  const lim = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const vals: (string | number)[] = []
  if (opts.status) {
    parts.push('status = ?')
    vals.push(opts.status)
  }
  if (opts.post_id != null) {
    parts.push('post_id = ?')
    vals.push(opts.post_id)
  }
  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : ''
  return db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...vals, lim) as JobRow[]
}

export function getJob(id: number): JobRow | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null
}
