/**
 * Phase 4 — insights sync job handlers (media / account / audience / token).
 */
import db from '../db'
import { getConn, refreshIgAccessToken, type IgConnRow } from '../instagram-oauth'
import { decryptSecret } from '../crypto-secret'
import { igGet, listConnectedAccounts } from '../instagram-publish'
import { accountMetricsFields, mediaMetricsFor } from './graph-metrics'

function tokenFor(conn: IgConnRow): string {
  if (!conn.access_token) throw new Error('Connection has no access token')
  try {
    return decryptSecret(conn.access_token)
  } catch {
    return conn.access_token
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysAgo(n: number, from = new Date()): string {
  const d = new Date(from)
  d.setUTCDate(d.getUTCDate() - n)
  return ymd(d)
}

export async function handleRefreshToken(payload: {
  connection_id: number
}): Promise<{ ok: boolean; error?: string }> {
  const conn = getConn(payload.connection_id)
  if (!conn) return { ok: false, error: 'connection not found' }
  return refreshIgAccessToken(conn)
}

export async function handleSyncMediaInsights(payload: {
  media_id: string
  period_label: string
}): Promise<{ media_id: string; period_label: string; metrics: Record<string, number> }> {
  const media = db
    .prepare('SELECT * FROM ig_media WHERE id = ?')
    .get(payload.media_id) as
    | {
        id: string
        account_id: string
        media_product_type: string | null
        media_type: string | null
      }
    | undefined
  if (!media) throw new Error(`ig_media ${payload.media_id} not found`)

  const conn = listConnectedAccounts().find((c) => c.account_id === media.account_id)
  if (!conn) throw new Error(`No connected account for ${media.account_id}`)
  const token = tokenFor(conn)
  const metric = mediaMetricsFor(media.media_product_type || media.media_type)
  const data = await igGet<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>(
    `/${payload.media_id}/insights`,
    token,
    { metric },
  )
  const flat: Record<string, number> = {}
  for (const row of data.data || []) {
    const v = row.values?.[0]?.value
    if (typeof v === 'number') flat[row.name] = v
  }
  const measuredAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO ig_media_metrics (
       media_id, period_label, measured_at, views, reach, saved, shares, likes, comments,
       total_interactions, profile_visits, follows, watch_time, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(media_id, period_label) DO UPDATE SET
       measured_at = excluded.measured_at,
       views = excluded.views,
       reach = excluded.reach,
       saved = excluded.saved,
       shares = excluded.shares,
       likes = excluded.likes,
       comments = excluded.comments,
       total_interactions = excluded.total_interactions,
       profile_visits = excluded.profile_visits,
       follows = excluded.follows,
       watch_time = excluded.watch_time,
       raw_json = excluded.raw_json`,
  ).run(
    payload.media_id,
    payload.period_label,
    measuredAt,
    flat.views ?? null,
    flat.reach ?? null,
    flat.saved ?? null,
    flat.shares ?? null,
    flat.likes ?? null,
    flat.comments ?? null,
    flat.total_interactions ?? null,
    flat.profile_visits ?? null,
    flat.follows ?? null,
    flat.avg_watch_time ?? flat.watch_time ?? null,
    JSON.stringify(data.data || []),
  )
  return { media_id: payload.media_id, period_label: payload.period_label, metrics: flat }
}

export async function handleSyncAccountInsights(payload: {
  account_id: string
  date: string
}): Promise<{ account_id: string; date: string; final: boolean }> {
  const conn = listConnectedAccounts().find((c) => c.account_id === payload.account_id)
  if (!conn) throw new Error(`No connected account for ${payload.account_id}`)
  const token = tokenFor(conn)
  const metric = accountMetricsFields()
  const data = await igGet<{
    data?: Array<{ name: string; values?: Array<{ value: number; end_time?: string }> }>
  }>(`/${payload.account_id}/insights`, token, {
    metric,
    period: 'day',
    since: payload.date,
    until: payload.date,
  })

  const flat: Record<string, number> = {}
  for (const row of data.data || []) {
    const match =
      row.values?.find((v) => (v.end_time || '').startsWith(payload.date)) || row.values?.[0]
    if (match && typeof match.value === 'number') flat[row.name] = match.value
  }

  // Also try follower_count from /me if missing
  if (flat.follower_count == null) {
    try {
      const me = await igGet<{ followers_count?: number }>(`/${payload.account_id}`, token, {
        fields: 'followers_count',
      })
      if (typeof me.followers_count === 'number') flat.follower_count = me.followers_count
    } catch {
      /* optional */
    }
  }

  const ageDays =
    (Date.now() - new Date(`${payload.date}T00:00:00.000Z`).getTime()) / (24 * 3_600_000)
  const final = ageDays > 3 ? 1 : 0
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO ig_account_metrics_daily (
       account_id, date, followers, reach, views, accounts_engaged, link_taps, final, raw_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, date) DO UPDATE SET
       followers = excluded.followers,
       reach = excluded.reach,
       views = excluded.views,
       accounts_engaged = excluded.accounts_engaged,
       link_taps = excluded.link_taps,
       final = excluded.final,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
  ).run(
    payload.account_id,
    payload.date,
    flat.follower_count ?? null,
    flat.reach ?? null,
    flat.views ?? null,
    flat.accounts_engaged ?? null,
    flat.website_clicks ?? flat.link_clicks ?? null,
    final,
    JSON.stringify(data.data || []),
    now,
  )
  return { account_id: payload.account_id, date: payload.date, final: final === 1 }
}

export async function handleSyncAudienceInsights(payload: {
  account_id: string
}): Promise<{ skipped?: boolean; reason?: string; id?: number }> {
  const conn = listConnectedAccounts().find((c) => c.account_id === payload.account_id)
  if (!conn) throw new Error(`No connected account for ${payload.account_id}`)
  const token = tokenFor(conn)

  let followers =
    (
      db
        .prepare(
          `SELECT followers FROM ig_account_metrics_daily
           WHERE account_id = ? AND followers IS NOT NULL
           ORDER BY date DESC LIMIT 1`,
        )
        .get(payload.account_id) as { followers: number } | undefined
    )?.followers ?? null

  if (followers == null) {
    try {
      const me = await igGet<{ followers_count?: number }>(`/${payload.account_id}`, token, {
        fields: 'followers_count',
      })
      followers = me.followers_count ?? null
    } catch {
      followers = null
    }
  }

  if (followers != null && followers < 100) {
    return { skipped: true, reason: 'fewer than 100 followers' }
  }

  // Demographics — exact breakdown params vary by API version; best-effort.
  let demographics: unknown = null
  try {
    demographics = await igGet(`/${payload.account_id}/insights`, token, {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown: 'age,gender',
    })
  } catch (err) {
    // Soft-fail: store empty demographics with note rather than looping forever
    demographics = {
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const info = db
    .prepare(
      `INSERT INTO ig_audience_snapshots
         (account_id, captured_at, follower_count_at_capture, demographics_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      payload.account_id,
      new Date().toISOString(),
      followers,
      JSON.stringify(demographics),
    )
  return { id: Number(info.lastInsertRowid) }
}

/**
 * Paginate account media into ig_media. Matches posts.instagram_media_id when present.
 */
export async function importAccountMedia(opts: {
  account_id: string
  maxPages?: number
}): Promise<{ imported: number; linked: number }> {
  const conn = listConnectedAccounts().find((c) => c.account_id === opts.account_id)
  if (!conn) throw new Error(`No connected account for ${opts.account_id}`)
  const token = tokenFor(conn)
  let nextUrl: string | null = null
  let imported = 0
  let linked = 0
  let pages = 0
  const maxPages = opts.maxPages ?? 50

  type MediaItem = {
    id: string
    permalink?: string
    caption?: string
    timestamp?: string
    media_type?: string
    media_product_type?: string
    thumbnail_url?: string
  }

  while (pages < maxPages) {
    pages += 1
    let data: { data?: MediaItem[]; paging?: { next?: string } }
    if (nextUrl) {
      const res = await fetch(nextUrl)
      data = (await res.json()) as typeof data
      if (!res.ok) throw new Error(`media import HTTP ${res.status}`)
    } else {
      data = await igGet(`/${opts.account_id}/media`, token, {
        fields: 'id,permalink,caption,timestamp,media_type,media_product_type,thumbnail_url',
        limit: '50',
      })
    }

    for (const item of data.data || []) {
      const post = db
        .prepare('SELECT id FROM posts WHERE instagram_media_id = ?')
        .get(item.id) as { id: number } | undefined
      const isImported = post ? 0 : 1
      if (post) linked += 1
      else imported += 1
      db.prepare(
        `INSERT INTO ig_media (
           id, account_id, post_id, media_product_type, media_type, permalink, caption,
           timestamp, thumbnail_url, is_imported, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           post_id = COALESCE(excluded.post_id, ig_media.post_id),
           media_product_type = excluded.media_product_type,
           media_type = excluded.media_type,
           permalink = excluded.permalink,
           caption = excluded.caption,
           timestamp = excluded.timestamp,
           thumbnail_url = excluded.thumbnail_url,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(
        item.id,
        opts.account_id,
        post?.id ?? null,
        item.media_product_type ?? null,
        item.media_type ?? null,
        item.permalink ?? null,
        item.caption ?? null,
        item.timestamp ?? null,
        item.thumbnail_url ?? null,
        isImported,
      )
    }

    nextUrl = data.paging?.next || null
    if (!nextUrl) break
  }
  return { imported, linked }
}

/** Ensure a published post's IG media id exists in ig_media. */
export function ensureIgMediaForPost(post: {
  id: number
  account_id?: string | null
  instagram_media_id?: string | null
  instagram_permalink?: string | null
  instagram_published_at?: string | null
  format?: string | null
  caption?: string | null
  media_type?: string | null
}): void {
  if (!post.instagram_media_id || !post.account_id) return
  const product =
    (post.format || '').toLowerCase() === 'reel'
      ? 'REELS'
      : (post.format || '').toLowerCase() === 'carousel'
        ? 'CAROUSEL_ALBUM'
        : 'FEED'
  db.prepare(
    `INSERT INTO ig_media (
       id, account_id, post_id, media_product_type, media_type, permalink, caption,
       timestamp, is_imported, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       post_id = excluded.post_id,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    post.instagram_media_id,
    post.account_id,
    post.id,
    product,
    post.media_type ?? null,
    post.instagram_permalink ?? null,
    post.caption ?? null,
    post.instagram_published_at ?? null,
  )
}

export { daysAgo, ymd }
