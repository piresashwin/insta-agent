/**
 * Phase 4 — coarse insights scheduler (≈30 min), separate from the 15s publish tick.
 */
import db from '../db'
import { enqueueJob, type JobKind } from '../jobs'
import { listConnectedAccounts } from '../instagram-publish'
import { duePeriodLabels, MEDIA_POLL_MAX_MS } from './graph-metrics'
import { daysAgo, ensureIgMediaForPost, ymd } from './sync'
import { SCHEDULER_ACTOR } from '../services/attribution'

function enqueueFree(
  kind: JobKind,
  payload: Record<string, unknown>,
  dedupe_key: string,
  post_id?: number | null,
): void {
  enqueueJob({
    kind,
    payload: { ...payload, actor: SCHEDULER_ACTOR },
    dedupe_key,
    post_id: post_id ?? undefined,
  })
}

/** Enqueue due per-post insight polls. */
export function enqueueDueMediaInsightJobs(now = new Date()): number {
  // Keep ig_media in sync for recently published posts
  const published = db
    .prepare(
      `SELECT id, account_id, instagram_media_id, instagram_permalink, instagram_published_at,
              format, caption, media_type
       FROM posts
       WHERE status = 'published' AND instagram_media_id IS NOT NULL`,
    )
    .all() as Array<{
    id: number
    account_id: string | null
    instagram_media_id: string
    instagram_permalink: string | null
    instagram_published_at: string | null
    format: string | null
    caption: string | null
    media_type: string | null
  }>
  for (const p of published) ensureIgMediaForPost(p)

  const media = db
    .prepare(
      `SELECT id, timestamp FROM ig_media WHERE timestamp IS NOT NULL`,
    )
    .all() as Array<{ id: string; timestamp: string }>

  let n = 0
  for (const row of media) {
    const publishedAt = new Date(row.timestamp)
    if (Number.isNaN(publishedAt.getTime())) continue
    const elapsed = now.getTime() - publishedAt.getTime()
    if (elapsed > MEDIA_POLL_MAX_MS) continue

    const existing = new Set(
      (
        db
          .prepare(`SELECT period_label FROM ig_media_metrics WHERE media_id = ?`)
          .all(row.id) as Array<{ period_label: string }>
      ).map((r) => r.period_label),
    )
    for (const label of duePeriodLabels(publishedAt, now)) {
      if (existing.has(label)) continue
      enqueueFree(
        'sync_media_insights',
        { media_id: row.id, period_label: label },
        `sync_media_insights:${row.id}:${label}`,
      )
      n += 1
    }
  }
  return n
}

export function insightsSchedulerTick(now = new Date()): {
  media: number
  account: number
  audience: number
  refresh: number
} {
  const today = ymd(now)
  let account = 0
  let audience = 0
  let refresh = 0

  const connections = listConnectedAccounts()
  for (const conn of connections) {
    // Account metrics: today, today-1, today-2
    for (const offset of [0, 1, 2]) {
      const date = daysAgo(offset, now)
      enqueueFree(
        'sync_account_insights',
        { account_id: conn.account_id, date },
        `sync_account_insights:${conn.account_id}:${date}`,
      )
      account += 1
    }

    // Audience: at most once per 7 days
    const recentAud = db
      .prepare(
        `SELECT captured_at FROM ig_audience_snapshots
         WHERE account_id = ? ORDER BY captured_at DESC LIMIT 1`,
      )
      .get(conn.account_id) as { captured_at: string } | undefined
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString()
    if (!recentAud || recentAud.captured_at < weekAgo) {
      enqueueFree(
        'sync_audience_insights',
        { account_id: conn.account_id },
        `sync_audience_insights:${conn.account_id}:${today}`,
      )
      audience += 1
    }

    // Token refresh within 10 days
    if (conn.token_expires_at) {
      const expires = new Date(conn.token_expires_at).getTime()
      const tenDays = 10 * 24 * 3_600_000
      if (expires - now.getTime() <= tenDays) {
        enqueueFree(
          'refresh_token',
          { connection_id: conn.id },
          `refresh_token:${conn.id}:${today}`,
        )
        refresh += 1
      }
    }
  }

  const media = enqueueDueMediaInsightJobs(now)
  return { media, account, audience, refresh }
}
