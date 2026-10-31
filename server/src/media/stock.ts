/**
 * Lesson 13 — free stock media adapters.
 * Search order: Pexels → Unsplash → Pixabay. Download bytes to disk.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { BACKGROUND_STYLES } from '@instagram-agent/shared'

export type StockHit = {
  provider: 'pexels' | 'unsplash' | 'pixabay'
  id: string
  downloadUrl: string
  photographer?: string
  pageUrl?: string
}

export type SavedAsset = {
  provider: StockHit['provider']
  absolutePath: string
  relativePath: string
  publicUrl: string
  mime: string
  photographer?: string
  sourceUrl?: string
}

const ASSETS_ROOT = path.join(__dirname, '..', '..', 'assets')

export function assetsRoot() {
  return ASSETS_ROOT
}

function publicBase(): string {
  const base =
    process.env.PUBLIC_API_BASE ||
    `http://127.0.0.1:${process.env.PORT || 3001}`
  return base.replace(/\/$/, '')
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function pickRandom<T>(items: T[], excludeId?: string | null, idOf?: (item: T) => string): T | null {
  if (!items.length) return null
  const filtered =
    excludeId && idOf ? items.filter((item) => idOf(item) !== excludeId) : items
  const pool = filtered.length ? filtered : items
  return pool[Math.floor(Math.random() * pool.length)] ?? null
}

async function searchPexels(
  query: string,
  opts?: { excludeId?: string | null }
): Promise<StockHit | null> {
  const key = process.env.PEXELS_API_KEY
  if (!key) return null
  const url = new URL('https://api.pexels.com/v1/search')
  url.searchParams.set('query', query)
  url.searchParams.set('per_page', '15')
  url.searchParams.set('orientation', 'portrait')
  // Random page among first few so "fetch different" is not stuck on hit #1.
  url.searchParams.set('page', String(1 + Math.floor(Math.random() * 3)))
  const res = await fetch(url, { headers: { Authorization: key } })
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`)
  const body = (await res.json()) as {
    photos?: Array<{
      id: number
      url: string
      photographer?: string
      src?: { large2x?: string; large?: string; original?: string }
    }>
  }
  const photo = pickRandom(body.photos || [], opts?.excludeId, (p) => String(p.id))
  if (!photo?.src) return null
  const downloadUrl = photo.src.large2x || photo.src.large || photo.src.original
  if (!downloadUrl) return null
  return {
    provider: 'pexels',
    id: String(photo.id),
    downloadUrl,
    photographer: photo.photographer,
    pageUrl: photo.url,
  }
}

async function searchUnsplash(query: string): Promise<StockHit | null> {
  const key = process.env.UNSPLASH_API_KEY
  if (!key) return null
  const url = new URL('https://api.unsplash.com/search/photos')
  url.searchParams.set('query', query)
  url.searchParams.set('per_page', '5')
  url.searchParams.set('orientation', 'portrait')
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}` },
  })
  if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`)
  const body = (await res.json()) as {
    results?: Array<{
      id: string
      links?: { html?: string; download_location?: string }
      urls?: { full?: string; regular?: string }
      user?: { name?: string }
    }>
  }
  const photo = body.results?.[0]
  if (!photo) return null
  // Prefer download_location (Unsplash guidelines) then fall back to regular URL.
  let downloadUrl = photo.urls?.regular || photo.urls?.full
  if (photo.links?.download_location) {
    const dl = await fetch(photo.links.download_location, {
      headers: { Authorization: `Client-ID ${key}` },
    })
    if (dl.ok) {
      const j = (await dl.json()) as { url?: string }
      if (j.url) downloadUrl = j.url
    }
  }
  if (!downloadUrl) return null
  return {
    provider: 'unsplash',
    id: photo.id,
    downloadUrl,
    photographer: photo.user?.name,
    pageUrl: photo.links?.html,
  }
}

async function searchPixabay(query: string): Promise<StockHit | null> {
  const key = process.env.PIXABAY_API_KEY
  if (!key) return null
  const url = new URL('https://pixabay.com/api/')
  url.searchParams.set('key', key)
  url.searchParams.set('q', query)
  url.searchParams.set('image_type', 'photo')
  url.searchParams.set('orientation', 'vertical')
  url.searchParams.set('per_page', '5')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`)
  const body = (await res.json()) as {
    hits?: Array<{
      id: number
      largeImageURL?: string
      webformatURL?: string
      pageURL?: string
      user?: string
    }>
  }
  const hit = body.hits?.[0]
  const downloadUrl = hit?.largeImageURL || hit?.webformatURL
  if (!hit || !downloadUrl) return null
  return {
    provider: 'pixabay',
    id: String(hit.id),
    downloadUrl,
    photographer: hit.user,
    pageUrl: hit.pageURL,
  }
}

/** Pexels-first; Unsplash/Pixabay only if Pexels key missing or returns nothing. */
export async function searchStock(
  query: string,
  opts?: { excludeId?: string | null }
): Promise<StockHit> {
  const q = query.trim() || 'instagram lifestyle'
  const errors: string[] = []

  if (process.env.PEXELS_API_KEY) {
    try {
      const hit = await searchPexels(q, opts)
      if (hit) return hit
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
    throw new Error(
      `No Pexels image for “${q}”.${errors.length ? ` Errors: ${errors.join('; ')}` : ''}`
    )
  }

  for (const fn of [searchUnsplash, searchPixabay]) {
    try {
      const hit = await fn(q)
      if (hit) return hit
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  const keys = [
    process.env.UNSPLASH_API_KEY && 'unsplash',
    process.env.PIXABAY_API_KEY && 'pixabay',
  ].filter(Boolean)
  if (keys.length === 0) {
    throw new Error('Set PEXELS_API_KEY in .env.local (preferred for Generate with Pexels)')
  }
  throw new Error(
    `No stock image for “${q}”. Tried: ${keys.join(', ')}.${errors.length ? ` Errors: ${errors.join('; ')}` : ''}`
  )
}

export async function downloadStockForPost(
  postId: number | string,
  query: string,
  opts?: { excludeId?: string | null }
): Promise<SavedAsset & { hit: StockHit }> {
  const hit = await searchStock(query, opts)
  const res = await fetch(hit.downloadUrl)
  if (!res.ok) throw new Error(`Download failed HTTP ${res.status} (${hit.provider})`)
  const buf = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') || 'image/jpeg'
  const ext =
    contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
  const dir = path.join(ASSETS_ROOT, 'posts', String(postId))
  ensureDir(dir)
  const filename = `image-${crypto.randomBytes(4).toString('hex')}.${ext}`
  const absolutePath = path.join(dir, filename)
  fs.writeFileSync(absolutePath, buf)
  const relativePath = path.join('posts', String(postId), filename)
  const publicUrl = `${publicBase()}/assets/${relativePath.split(path.sep).join('/')}`
  return {
    hit,
    provider: hit.provider,
    absolutePath,
    relativePath,
    publicUrl,
    mime: contentType,
    photographer: hit.photographer,
    sourceUrl: hit.pageUrl,
  }
}

const STYLE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'with',
  'in',
  'on',
  'at',
  'to',
  'for',
  'from',
  'shot',
  'photo',
  'photograph',
  'image',
  'picture',
  'cinematic',
  'editorial',
  'bokeh',
  '4k',
  '8k',
  'hd',
  'ultra',
  'realistic',
  'detailed',
  'high',
  'quality',
  'soft',
  'lighting',
  'light',
  'composition',
  'aspect',
  'ratio',
  'vertical',
  'horizontal',
  'instagram',
  'style',
])

/** Prefer stock_search_query; else strip style fluff from image_prompt. */
export function mediaQueryFromPost(post: {
  stock_search_query?: string | null
  image_prompt?: string | null
  topic?: string | null
  hook?: string | null
  fallback_prompt?: string | null
  background_style?: string | null
}): string {
  const dedicated = (post.stock_search_query || post.fallback_prompt || '').trim()
  let base = dedicated
    ? dedicated
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8)
        .join(' ')
    : (post.image_prompt || post.topic || post.hook || 'lifestyle')
        .trim()
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 1 && !STYLE_STOPWORDS.has(w) && !/^\d+:\d+$/.test(w))
        .slice(0, 8)
        .join(' ')

  const style = BACKGROUND_STYLES.find((s) => s.id === post.background_style)
  if (style) {
    const lower = base.toLowerCase()
    const extra = style.keywords
      .split(/\s+/)
      .filter((w) => w && !lower.includes(w.toLowerCase()))
      .slice(0, 3)
    if (extra.length) base = `${base} ${extra.join(' ')}`.trim()
  }

  return base.split(/\s+/).filter(Boolean).slice(0, 10).join(' ')
}
