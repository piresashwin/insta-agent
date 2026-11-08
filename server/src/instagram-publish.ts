/**
 * Lesson 15 — gated Instagram publish (Instagram Login / graph.instagram.com).
 * Staged assets stay on localhost; at publish we rewrite /assets URLs onto
 * PUBLIC_API_BASE (live HTTPS tunnel) so Meta can fetch them.
 * After publish, stores media id + permalink/shortcode for analytics / comments.
 */
import db from './db'
import { decryptSecret } from './crypto-secret'
import type { IgConnRow } from './instagram-oauth'
import { getConn, logAuthEvent } from './instagram-oauth'
import { publishApiBase, rewriteAssetPublicUrl } from './media/r2'
import { allSlidesHaveStaged, listSlides } from './slides'
import { fitCaption, normalizeAltText, normalizeHashtags } from './instagram-rules'

// Read lazily so dotenv.config() in server.ts runs before this value is consumed.
function igGraphBase(): string {
  const v = process.env.META_GRAPH_VERSION || 'v21.0'
  return `https://graph.instagram.com/${v}`
}

export type PublishedMediaRef = {
  creationId: string
  mediaId: string
  childIds?: string[]
  permalink?: string | null
  shortcode?: string | null
  publishedAt?: string | null
  mediaType?: string | null
  childrenMediaIds?: string[]
}

export async function igGet<T>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${igGraphBase()}${path}`)
  url.searchParams.set('access_token', token)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }
  const res = await fetch(url)
  const json = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: number; error_subcode?: number }
  }
  if (res.status === 429 || json.error?.code === 4 || json.error?.code === 17) {
    const { RateLimitError } = await import('./insights/graph-metrics')
    throw new RateLimitError(json.error?.message || `Instagram Graph rate limited (HTTP ${res.status})`)
  }
  if (!res.ok || json.error) {
    throw new Error(json.error?.message || `Instagram Graph GET HTTP ${res.status}`)
  }
  return json
}

/** Poll container until FINISHED (or fail/timeout). */
async function waitUntilFinished(creationId: string, token: string, label: string) {
  const deadline = Date.now() + 60_000
  let last = 'UNKNOWN'
  while (Date.now() < deadline) {
    const status = await igGet<{ status_code?: string }>(`/${creationId}`, token, {
      fields: 'status_code',
    })
    last = status.status_code || 'UNKNOWN'
    if (last === 'FINISHED') return
    if (last === 'ERROR' || last === 'EXPIRED') {
      throw new Error(`Instagram ${label} container ${creationId} status=${last}`)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`Instagram ${label} container ${creationId} timed out (last=${last})`)
}

export function listConnectedAccounts(): IgConnRow[] {
  return db
    .prepare(`SELECT * FROM instagram_conn WHERE status = 'connected' AND access_token IS NOT NULL`)
    .all() as IgConnRow[]
}

export function resolvePublishConn(postAccountId?: string | null): IgConnRow {
  if (postAccountId) {
    const byAccount = db
      .prepare(
        `SELECT * FROM instagram_conn WHERE account_id = ? AND status = 'connected' AND access_token IS NOT NULL`
      )
      .get(postAccountId) as IgConnRow | undefined
    if (byAccount) return byAccount
  }
  const connected = listConnectedAccounts()
  if (connected.length === 0) {
    throw new Error(
      'No connected Instagram account. Paste a token or complete OAuth on the Accounts tab first.'
    )
  }
  return connected[0]
}

function accessTokenFor(conn: IgConnRow): string {
  if (!conn.access_token) throw new Error('Connection has no access token')
  return decryptSecret(conn.access_token)
}

async function igPost<T>(path: string, token: string, body: Record<string, string>): Promise<T> {
  const url = new URL(`${igGraphBase()}${path}`)
  url.searchParams.set('access_token', token)
  for (const [k, v] of Object.entries(body)) url.searchParams.set(k, v)
  const res = await fetch(url, { method: 'POST' })
  const json = (await res.json()) as T & { error?: { message?: string; code?: number } }
  if (!res.ok || json.error) {
    throw new Error(json.error?.message || `Instagram Graph HTTP ${res.status}`)
  }
  return json
}

function assertHttps(url: string) {
  if (!url.startsWith('https://')) {
    throw new Error(
      `Instagram requires a public HTTPS media URL (got ${url}). Generate a publish tunnel in Accounts (or set PUBLIC_API_BASE) — used only at publish.`
    )
  }
}

/** Map localhost (or stale tunnel) /assets URL → current PUBLIC_API_BASE for Graph fetch. */
function publicImageUrl(url: string): string {
  if (!publishApiBase()) {
    throw new Error(
      'Publish tunnel missing: generate one in Accounts (or set PUBLIC_API_BASE) before publish. Generation/staging use localhost.'
    )
  }
  return rewriteAssetPublicUrl(url) || url
}

/**
 * Meta returns a vague "Only photo or video…" when the URL is 403/HTML (dead tunnel).
 * Probe the rewritten URL before creating a container.
 */
async function assertFetchableMedia(url: string, kind: 'image' | 'video') {
  assertHttps(url)
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', redirect: 'follow' })
  } catch (e) {
    throw new Error(
      `Cannot reach publish media URL (${(e as Error).message}). Regenerate the publish tunnel in Accounts (cloudflared must be running). ${url}`
    )
  }
  if (!res.ok) {
    throw new Error(
      `Publish media URL returned HTTP ${res.status} (Meta needs a real ${kind}). Regenerate the publish tunnel in Accounts. ${url}`
    )
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  const expect = kind === 'video' ? 'video/' : 'image/'
  // Some CDNs omit type; sniff first bytes if needed
  if (ct && !ct.startsWith(expect) && !ct.includes('octet-stream')) {
    throw new Error(
      `Publish media URL Content-Type is "${ct || 'unknown'}" (expected ${expect}*). Dead tunnel or wrong path: ${url}`
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 100) {
    throw new Error(`Publish media URL body too small (${buf.length} bytes): ${url}`)
  }
  if (kind === 'image') {
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8
    const isWebp = buf.length > 11 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
    if (!isPng && !isJpg && !isWebp) {
      throw new Error(
        `Publish URL did not return an image file (got ${ct || 'unknown'}). Meta error "Only photo or video" usually means a dead tunnel HTML page. ${url}`
      )
    }
  }
}

/** Fetch published media fields used for analytics linking. */
export async function fetchPublishedMediaMeta(
  mediaId: string,
  token: string
): Promise<{
  permalink?: string | null
  shortcode?: string | null
  publishedAt?: string | null
  mediaType?: string | null
  childrenMediaIds?: string[]
}> {
  const meta = await igGet<{
    id?: string
    permalink?: string
    shortcode?: string
    timestamp?: string
    media_type?: string
    children?: { data?: Array<{ id: string }> }
  }>(`/${mediaId}`, token, {
    fields: 'id,permalink,shortcode,timestamp,media_type,children{id}',
  })
  return {
    permalink: meta.permalink || null,
    shortcode: meta.shortcode || null,
    publishedAt: meta.timestamp || null,
    mediaType: meta.media_type || null,
    childrenMediaIds: (meta.children?.data || []).map((c) => c.id).filter(Boolean),
  }
}

export async function fetchMediaInsights(mediaId: string, token: string, mediaType?: string | null) {
  const { mediaMetricsFor } = await import('./insights/graph-metrics')
  const metrics = mediaMetricsFor(mediaType)
  try {
    const data = await igGet<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>(
      `/${mediaId}/insights`,
      token,
      { metric: metrics }
    )
    const flat: Record<string, number> = {}
    for (const row of data.data || []) {
      const v = row.values?.[0]?.value
      if (typeof v === 'number') flat[row.name] = v
    }
    return { metrics: flat, raw: data.data || [] }
  } catch (err) {
    // Fallback smaller set if Meta rejects some metrics for this media type.
    const data = await igGet<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>(
      `/${mediaId}/insights`,
      token,
      { metric: 'reach,saved,total_interactions' }
    )
    const flat: Record<string, number> = {}
    for (const row of data.data || []) {
      const v = row.values?.[0]?.value
      if (typeof v === 'number') flat[row.name] = v
    }
    return {
      metrics: flat,
      raw: data.data || [],
      note: err instanceof Error ? err.message : 'partial metrics',
    }
  }
}

export async function fetchMediaComments(mediaId: string, token: string) {
  const data = await igGet<{
    data?: Array<{
      id: string
      text?: string
      username?: string
      timestamp?: string
      like_count?: number
    }>
  }>(`/${mediaId}/comments`, token, {
    fields: 'id,text,username,timestamp,like_count',
    limit: '50',
  })
  return data.data || []
}

async function enrichAfterPublish(
  conn: IgConnRow,
  base: { creationId: string; mediaId: string; childIds?: string[] }
): Promise<PublishedMediaRef> {
  const token = accessTokenFor(conn)
  try {
    const meta = await fetchPublishedMediaMeta(base.mediaId, token)
    return {
      ...base,
      permalink: meta.permalink,
      shortcode: meta.shortcode,
      publishedAt: meta.publishedAt,
      mediaType: meta.mediaType,
      childrenMediaIds: meta.childrenMediaIds?.length
        ? meta.childrenMediaIds
        : base.childIds,
    }
  } catch (err) {
    console.warn(
      '[instagram] fetch media meta after publish failed:',
      err instanceof Error ? err.message : err
    )
    return { ...base, childrenMediaIds: base.childIds }
  }
}

/** Seed/update learn row so analytics can join on post_id + media id. */
export function recordPublishForAnalytics(opts: {
  postId: number
  accountId: string | null
  hook?: string | null
  caption?: string | null
  mediaId: string
  creationId?: string | null
  permalink?: string | null
  shortcode?: string | null
  childrenIds?: string[] | null
}) {
  const engagement = JSON.stringify({
    instagram_media_id: opts.mediaId,
    instagram_creation_id: opts.creationId || null,
    permalink: opts.permalink || null,
    shortcode: opts.shortcode || null,
    children_ids: opts.childrenIds || [],
    recorded_at: new Date().toISOString(),
    metrics: null,
  })
  const existing = db
    .prepare('SELECT id FROM learn WHERE post_id = ? ORDER BY id DESC LIMIT 1')
    .get(opts.postId) as { id: number } | undefined
  if (existing) {
    db.prepare(
      `UPDATE learn SET account_id = ?, engagement = ?, hook = ?, caption = ? WHERE id = ?`
    ).run(
      opts.accountId,
      engagement,
      opts.hook || null,
      opts.caption || null,
      existing.id
    )
    return existing.id
  }
  const info = db
    .prepare(
      `INSERT INTO learn (post_id, account_id, engagement, hook, caption, created_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .run(
      opts.postId,
      opts.accountId,
      engagement,
      opts.hook || null,
      opts.caption || null
    )
  return Number(info.lastInsertRowid)
}

export function updateLearnEngagement(postId: number, metrics: Record<string, unknown>) {
  const row = db
    .prepare('SELECT id, engagement FROM learn WHERE post_id = ? ORDER BY id DESC LIMIT 1')
    .get(postId) as { id: number; engagement: string | null } | undefined
  if (!row) return null
  let prev: Record<string, unknown> = {}
  try {
    prev = row.engagement ? (JSON.parse(row.engagement) as Record<string, unknown>) : {}
  } catch {
    prev = {}
  }
  const next = {
    ...prev,
    metrics,
    metrics_fetched_at: new Date().toISOString(),
  }
  db.prepare('UPDATE learn SET engagement = ? WHERE id = ?').run(JSON.stringify(next), row.id)
  return next
}

/**
 * Resolve a reusable container id: reuse when still valid; otherwise create.
 * Persists via onContainerCreated immediately after Graph create (before publish).
 */
async function resolveCreationId(opts: {
  conn: IgConnRow
  existingCreationId?: string | null
  onContainerCreated?: (creationId: string) => void
  create: () => Promise<string>
  label: string
}): Promise<string> {
  const token = accessTokenFor(opts.conn)
  let creationId = opts.existingCreationId?.trim() || null
  if (creationId) {
    try {
      const status = await igGet<{ status_code?: string }>(`/${creationId}`, token, {
        fields: 'status_code',
      })
      const code = status.status_code || 'UNKNOWN'
      if (code === 'FINISHED' || code === 'IN_PROGRESS' || code === 'PUBLISHED') {
        return creationId
      }
      // ERROR / EXPIRED / unknown → create a fresh container
    } catch {
      // Missing container → create fresh
    }
    creationId = null
  }
  creationId = await opts.create()
  if (!creationId) throw new Error(`${opts.label} container create returned no id`)
  opts.onContainerCreated?.(creationId)
  return creationId
}

export async function publishImageToInstagram(opts: {
  conn: IgConnRow
  imageUrl: string
  caption: string
  altText?: string | null
  existingCreationId?: string | null
  onContainerCreated?: (creationId: string) => void
}): Promise<PublishedMediaRef> {
  const imageUrl = publicImageUrl(opts.imageUrl)
  assertHttps(imageUrl)
  const token = accessTokenFor(opts.conn)
  const igUserId = opts.conn.account_id
  if (!igUserId || igUserId.startsWith('pending:')) {
    throw new Error('Connection account_id is not a real Instagram user id')
  }

  await assertFetchableMedia(imageUrl, 'image')

  const creationId = await resolveCreationId({
    conn: opts.conn,
    existingCreationId: opts.existingCreationId,
    onContainerCreated: opts.onContainerCreated,
    label: 'image',
    create: async () => {
      const createBody: Record<string, string> = { image_url: imageUrl, caption: opts.caption }
      const alt = normalizeAltText(opts.altText)
      if (alt) createBody.alt_text = alt
      const created = await igPost<{ id: string }>(`/${igUserId}/media`, token, createBody)
      return created.id
    },
  })

  await waitUntilFinished(creationId, token, 'image')

  const published = await igPost<{ id: string }>(`/${igUserId}/media_publish`, token, {
    creation_id: creationId,
  })
  if (!published.id) throw new Error('media_publish returned no id')

  logAuthEvent(opts.conn.id, 'instagram_published', {
    ig_user_id: igUserId,
    creation_id: creationId,
    media_id: published.id,
  })

  return enrichAfterPublish(opts.conn, {
    creationId,
    mediaId: published.id,
  })
}

/** Carousel: create child image containers, then parent, then publish. */
export async function publishCarouselToInstagram(opts: {
  conn: IgConnRow
  imageUrls: string[]
  caption: string
  /** Per-item alt text, aligned with imageUrls. */
  altTexts?: Array<string | null | undefined>
  existingCreationId?: string | null
  onContainerCreated?: (creationId: string) => void
}): Promise<PublishedMediaRef> {
  if (opts.imageUrls.length < 2) {
    throw new Error('Carousel requires at least 2 image URLs')
  }
  const imageUrls = opts.imageUrls.map(publicImageUrl)
  for (const u of imageUrls) await assertFetchableMedia(u, 'image')

  const token = accessTokenFor(opts.conn)
  const igUserId = opts.conn.account_id
  if (!igUserId || igUserId.startsWith('pending:')) {
    throw new Error('Connection account_id is not a real Instagram user id')
  }

  let childIds: string[] = []
  const parentId = await resolveCreationId({
    conn: opts.conn,
    existingCreationId: opts.existingCreationId,
    onContainerCreated: opts.onContainerCreated,
    label: 'carousel parent',
    create: async () => {
      childIds = []
      for (const [i, imageUrl] of imageUrls.entries()) {
        const childBody: Record<string, string> = { image_url: imageUrl, is_carousel_item: 'true' }
        const alt = normalizeAltText(opts.altTexts?.[i])
        if (alt) childBody.alt_text = alt
        const child = await igPost<{ id: string }>(`/${igUserId}/media`, token, childBody)
        if (!child.id) throw new Error('Carousel child create returned no id')
        childIds.push(child.id)
      }
      for (const childId of childIds) {
        await waitUntilFinished(childId, token, 'carousel child')
      }
      const parent = await igPost<{ id: string }>(`/${igUserId}/media`, token, {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption: opts.caption,
      })
      return parent.id
    },
  })

  await waitUntilFinished(parentId, token, 'carousel parent')

  const published = await igPost<{ id: string }>(`/${igUserId}/media_publish`, token, {
    creation_id: parentId,
  })
  if (!published.id) throw new Error('media_publish returned no id')

  logAuthEvent(opts.conn.id, 'instagram_published', {
    ig_user_id: igUserId,
    creation_id: parentId,
    media_id: published.id,
    children: childIds,
  })

  return enrichAfterPublish(opts.conn, {
    creationId: parentId,
    mediaId: published.id,
    childIds,
  })
}

export async function publishReelToInstagram(opts: {
  conn: IgConnRow
  videoUrl: string
  caption: string
  coverUrl?: string | null
  /** Fallback cover frame (ms) when no cover image exists. */
  thumbOffsetMs?: number | null
  existingCreationId?: string | null
  onContainerCreated?: (creationId: string) => void
}): Promise<PublishedMediaRef> {
  const videoUrl = publicImageUrl(opts.videoUrl)
  await assertFetchableMedia(videoUrl, 'video')
  const token = accessTokenFor(opts.conn)
  const igUserId = opts.conn.account_id
  if (!igUserId || igUserId.startsWith('pending:')) {
    throw new Error('Connection account_id is not a real Instagram user id')
  }

  const body: Record<string, string> = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: opts.caption,
  }
  if (opts.coverUrl) {
    try {
      const cover = publicImageUrl(opts.coverUrl)
      if (cover.startsWith('https://')) body.cover_url = cover
    } catch {
      // Cover is optional — fall back to thumb_offset below.
    }
  }
  if (!body.cover_url && opts.thumbOffsetMs != null && opts.thumbOffsetMs >= 0) {
    body.thumb_offset = String(Math.round(opts.thumbOffsetMs))
  }

  const creationId = await resolveCreationId({
    conn: opts.conn,
    existingCreationId: opts.existingCreationId,
    onContainerCreated: opts.onContainerCreated,
    label: 'REELS',
    create: async () => {
      const created = await igPost<{ id: string }>(`/${igUserId}/media`, token, body)
      return created.id
    },
  })

  // Reels processing can take longer than stills
  const deadline = Date.now() + 180_000
  let last = 'UNKNOWN'
  while (Date.now() < deadline) {
    const status = await igGet<{ status_code?: string }>(`/${creationId}`, token, {
      fields: 'status_code',
    })
    last = status.status_code || 'UNKNOWN'
    if (last === 'FINISHED') break
    if (last === 'ERROR' || last === 'EXPIRED') {
      throw new Error(`Instagram REELS container ${creationId} status=${last}`)
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  if (last !== 'FINISHED') {
    throw new Error(`Instagram REELS container ${creationId} timed out (last=${last})`)
  }

  const published = await igPost<{ id: string }>(`/${igUserId}/media_publish`, token, {
    creation_id: creationId,
  })
  if (!published.id) throw new Error('media_publish returned no id')

  logAuthEvent(opts.conn.id, 'instagram_published', {
    ig_user_id: igUserId,
    creation_id: creationId,
    media_id: published.id,
    media_type: 'REELS',
  })

  return enrichAfterPublish(opts.conn, {
    creationId,
    mediaId: published.id,
  })
}

export async function publishPostToInstagram(opts: {
  conn: IgConnRow
  post: {
    id: number
    format?: string | null
    image_url?: string | null
    reel_url?: string | null
    reel_quality?: string | null
    caption?: string | null
    hashtags?: string | null
    hook?: string | null
    alt_text?: string | null
    prompt_vars?: string | null
    instagram_creation_id?: string | null
  }
}): Promise<PublishedMediaRef> {
  const caption = buildCaption(opts.post)
  const format = (opts.post.format || 'feed') as string
  const persistCreation = (creationId: string) => {
    db.prepare(
      `UPDATE posts SET instagram_creation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(creationId, opts.post.id)
  }

  if (format === 'carousel') {
    const slides = listSlides(opts.post.id)
    if (!allSlidesHaveStaged(opts.post.id)) {
      throw new Error(
        `Carousel publish needs staged_url on every slide (${slides.filter((s) => s.staged_url).length}/${slides.length}) — approve media first`
      )
    }
    const urls = slides.map((s) => s.staged_url!).filter(Boolean)
    if (urls.length < 2) {
      throw new Error('Carousel publish needs ≥2 staged_url on slides — approve media first')
    }
    return publishCarouselToInstagram({
      conn: opts.conn,
      imageUrls: urls,
      caption,
      altTexts: slides.filter((s) => s.staged_url).map((s) => s.alt_text || opts.post.alt_text),
      existingCreationId: opts.post.instagram_creation_id,
      onContainerCreated: persistCreation,
    })
  }

  if (format === 'reel') {
    const videoUrl = opts.post.reel_url
    if (!videoUrl) throw new Error('post.reel_url missing — generate + approve reel first')
    return publishReelToInstagram({
      conn: opts.conn,
      videoUrl,
      caption,
      coverUrl: opts.post.image_url,
      thumbOffsetMs: reelThumbOffsetMs(opts.post.prompt_vars),
      existingCreationId: opts.post.instagram_creation_id,
      onContainerCreated: persistCreation,
    })
  }

  const imageUrl = opts.post.image_url
  if (!imageUrl) throw new Error('post.image_url missing — approve media first')
  return publishImageToInstagram({
    conn: opts.conn,
    imageUrl,
    caption,
    altText: opts.post.alt_text,
    existingCreationId: opts.post.instagram_creation_id,
    onContainerCreated: persistCreation,
  })
}

/** Midpoint of the first timed cue — the frame where the hook is fully on screen. */
function reelThumbOffsetMs(promptVarsRaw?: string | null): number | null {
  if (!promptVarsRaw) return null
  try {
    const vars = JSON.parse(promptVarsRaw) as {
      format?: string
      timed_cues?: Array<{ startSec?: number; endSec?: number }>
    }
    const cue = vars.format === 'reel' ? vars.timed_cues?.[0] : undefined
    if (!cue) return null
    const start = Number(cue.startSec) || 0
    const end = Number(cue.endSec) || start + 2
    return Math.round(((start + end) / 2) * 1000)
  } catch {
    return null
  }
}

/** Caption + capped hashtags, trimmed at a clean boundary to Instagram's 2,200 limit. */
export function buildCaption(post: {
  caption?: string | null
  hashtags?: string | null
  hook?: string | null
}): string {
  return fitCaption(post.caption || post.hook || '', normalizeHashtags(post.hashtags))
}

export function tokenForConn(conn: IgConnRow): string {
  return accessTokenFor(conn)
}

export { getConn }
