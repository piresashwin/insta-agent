/**
 * Lesson 15 — gated Instagram publish (Instagram Login / graph.instagram.com).
 * Needs staged PNG URLs Meta can fetch over HTTPS (tunnel PUBLIC_API_BASE → /assets).
 */
import db from './db'
import { decryptSecret } from './crypto-secret'
import type { IgConnRow } from './instagram-oauth'
import { getConn, logAuthEvent } from './instagram-oauth'
import { rewriteAssetPublicUrl } from './media/r2'
import { listSlides } from './slides'

const GRAPH = process.env.META_GRAPH_VERSION || 'v21.0'
const IG_GRAPH = `https://graph.instagram.com/${GRAPH}`

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
  const url = new URL(`${IG_GRAPH}${path}`)
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
      `Instagram requires a public HTTPS image_url (got ${url}). Set PUBLIC_API_BASE to an HTTPS tunnel that serves /assets, then approve media again (or republish).`
    )
  }
}

function publicImageUrl(url: string): string {
  return rewriteAssetPublicUrl(url) || url
}

export async function publishImageToInstagram(opts: {
  conn: IgConnRow
  imageUrl: string
  caption: string
}): Promise<{ creationId: string; mediaId: string }> {
  const imageUrl = publicImageUrl(opts.imageUrl)
  assertHttps(imageUrl)
  const token = accessTokenFor(opts.conn)
  const igUserId = opts.conn.account_id
  if (!igUserId || igUserId.startsWith('pending:')) {
    throw new Error('Connection account_id is not a real Instagram user id')
  }

  const created = await igPost<{ id: string }>(`/${igUserId}/media`, token, {
    image_url: imageUrl,
    caption: opts.caption,
  })
  if (!created.id) throw new Error('Container create returned no id')

  await new Promise((r) => setTimeout(r, 1500))

  const published = await igPost<{ id: string }>(`/${igUserId}/media_publish`, token, {
    creation_id: created.id,
  })
  if (!published.id) throw new Error('media_publish returned no id')

  logAuthEvent(opts.conn.id, 'instagram_published', {
    ig_user_id: igUserId,
    creation_id: created.id,
    media_id: published.id,
  })

  return { creationId: created.id, mediaId: published.id }
}

/** Carousel: create child image containers, then parent, then publish. */
export async function publishCarouselToInstagram(opts: {
  conn: IgConnRow
  imageUrls: string[]
  caption: string
}): Promise<{ creationId: string; mediaId: string; childIds: string[] }> {
  if (opts.imageUrls.length < 2) {
    throw new Error('Carousel requires at least 2 image URLs')
  }
  const imageUrls = opts.imageUrls.map(publicImageUrl)
  for (const u of imageUrls) assertHttps(u)

  const token = accessTokenFor(opts.conn)
  const igUserId = opts.conn.account_id
  if (!igUserId || igUserId.startsWith('pending:')) {
    throw new Error('Connection account_id is not a real Instagram user id')
  }

  const childIds: string[] = []
  for (const imageUrl of imageUrls) {
    const child = await igPost<{ id: string }>(`/${igUserId}/media`, token, {
      image_url: imageUrl,
      is_carousel_item: 'true',
    })
    if (!child.id) throw new Error('Carousel child create returned no id')
    childIds.push(child.id)
  }

  await new Promise((r) => setTimeout(r, 2000))

  const parent = await igPost<{ id: string }>(`/${igUserId}/media`, token, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption: opts.caption,
  })
  if (!parent.id) throw new Error('Carousel parent create returned no id')

  await new Promise((r) => setTimeout(r, 1500))

  const published = await igPost<{ id: string }>(`/${igUserId}/media_publish`, token, {
    creation_id: parent.id,
  })
  if (!published.id) throw new Error('media_publish returned no id')

  logAuthEvent(opts.conn.id, 'instagram_published', {
    ig_user_id: igUserId,
    creation_id: parent.id,
    media_id: published.id,
    children: childIds,
  })

  return { creationId: parent.id, mediaId: published.id, childIds }
}

export async function publishPostToInstagram(opts: {
  conn: IgConnRow
  post: {
    id: number
    format?: string | null
    image_url?: string | null
    caption?: string | null
    hashtags?: string | null
    hook?: string | null
  }
}): Promise<{ creationId: string; mediaId: string }> {
  const caption = buildCaption(opts.post)
  const format = (opts.post.format || 'feed') as string

  if (format === 'carousel') {
    const slides = listSlides(opts.post.id)
    const urls = slides.map((s) => s.staged_url).filter((u): u is string => !!u)
    if (urls.length < 2) {
      throw new Error('Carousel publish needs ≥2 staged_url on slides — approve media first')
    }
    const result = await publishCarouselToInstagram({
      conn: opts.conn,
      imageUrls: urls,
      caption,
    })
    return { creationId: result.creationId, mediaId: result.mediaId }
  }

  const imageUrl = opts.post.image_url
  if (!imageUrl) throw new Error('post.image_url missing — approve media first')
  return publishImageToInstagram({
    conn: opts.conn,
    imageUrl,
    caption,
  })
}

export function buildCaption(post: {
  caption?: string | null
  hashtags?: string | null
  hook?: string | null
}): string {
  const parts = [post.caption || post.hook || '', post.hashtags || '']
    .map((s) => (s || '').trim())
    .filter(Boolean)
  return parts.join('\n\n').slice(0, 2200)
}

export { getConn }
