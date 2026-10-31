/**
 * Lesson 09 — React truth UI client.
 * Fetch only. No demo data. No status inventing — server owns rules.
 */

import type {
  AgentRunResponse,
  BrandProfile,
  CalendarProposal,
  InstagramConnection,
  InstagramListResponse,
  Post,
  PostResponse,
  PostSlide,
  PostStatus,
  PostsListResponse,
  Run,
  RunDetailResponse,
  RunEvent,
  RunsListResponse,
} from '@instagram-agent/shared'

export type { Post, PostStatus, Run, RunEvent, InstagramConnection, BrandProfile, CalendarProposal }

/** @deprecated Prefer `Post` from `@instagram-agent/shared`. */
export type ApiPost = Post

/** @deprecated Prefer `Run` from `@instagram-agent/shared`. */
export type RunRow = Run

/** @deprecated Prefer `InstagramConnection` from `@instagram-agent/shared`. */
export type InstagramConn = InstagramConnection

/** Local-only operator until operator auth exists. */
export const DEV_OPERATOR = { id: 'local-dev', name: 'Local operator' }

/**
 * Empty = same-origin / Vite proxy (`/api` → :3001).
 * Set `VITE_API_URL=http://127.0.0.1:3001` if the UI is not proxied.
 */
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = (body as { error?: string }).error || res.statusText || 'Request failed'
    throw new Error(msg)
  }
  return body as T
}

export function listPosts(status?: PostStatus | '') {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  return request<PostsListResponse>(`/api/posts${q}`)
}

export function createPost(
  topic: string,
  opts?: {
    background_style?: string
    format?: string
    brand_profile_id?: number
    scheduled_at?: string
    pillar?: string
    account_id?: string
  }
) {
  return request<PostResponse>('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      background_style: opts?.background_style || undefined,
      format: opts?.format || undefined,
      brand_profile_id: opts?.brand_profile_id,
      scheduled_at: opts?.scheduled_at,
      pillar: opts?.pillar,
      account_id: opts?.account_id,
    }),
  })
}

export function agentRun(postId: number) {
  return request<AgentRunResponse>(`/api/posts/${postId}/agent-run`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function approvePost(postId: number) {
  return request<PostResponse>(`/api/posts/${postId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ actor: DEV_OPERATOR }),
  })
}

export function requestChanges(postId: number, comment: string) {
  return request<PostResponse>(`/api/posts/${postId}/request-changes`, {
    method: 'POST',
    body: JSON.stringify({
      author: DEV_OPERATOR,
      comment,
    }),
  })
}

export function restartPost(postId: number) {
  return request<PostResponse>(`/api/posts/${postId}/restart`, {
    method: 'POST',
    body: JSON.stringify({ actor: DEV_OPERATOR }),
  })
}

export type FetchMediaResponse = PostResponse & {
  slides?: PostSlide[]
  media?: {
    provider: string
    model?: string
    url: string
    path: string
    photographer?: string
    query?: string
    prompt?: string
    slide_id?: number
  }
  note?: string
}

export function fetchPostMedia(
  postId: number,
  opts?: {
    query?: string
    prompt?: string
    provider?: 'pexels' | 'openai'
    slide_id?: number
  }
) {
  return request<FetchMediaResponse>(`/api/posts/${postId}/fetch-media`, {
    method: 'POST',
    body: JSON.stringify({
      actor: DEV_OPERATOR,
      provider: opts?.provider || 'pexels',
      ...(opts?.query ? { query: opts.query } : {}),
      ...(opts?.prompt ? { prompt: opts.prompt } : {}),
      ...(opts?.slide_id != null ? { slide_id: opts.slide_id } : {}),
    }),
  })
}

export function getPost(postId: number) {
  return request<PostResponse & { slides?: PostSlide[] }>(`/api/posts/${postId}`)
}

export function patchPost(
  postId: number,
  fields: Record<string, string | number | null>
) {
  return request<PostResponse>(`/api/posts/${postId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  })
}

export function listBrandProfiles() {
  return request<{ brands: BrandProfile[] }>('/api/brand-profiles')
}

export function createBrandProfile(body: Partial<BrandProfile> & { name: string }) {
  return request<{ brand: BrandProfile }>('/api/brand-profiles', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export type BrandGenerateDraft = {
  name: string
  niche: string
  audience: string
  goals: string
  pillars: Array<{ name: string }> | string[]
  posts_per_week: number
  preferred_days: string[]
  voice: string
  examples: string
  visual: string
  default_background_style: string
  default_format: string
  guide_md: string
}

export function generateBrandProfile(body: { feedback: string; name?: string }) {
  return request<{ draft: BrandGenerateDraft; note?: string }>(
    '/api/brand-profiles/generate',
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  )
}

export function updateBrandProfile(id: number, body: Partial<BrandProfile>) {
  return request<{ brand: BrandProfile }>(`/api/brand-profiles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteBrandProfile(id: number) {
  return request<{ ok: boolean }>(`/api/brand-profiles/${id}`, {
    method: 'DELETE',
  })
}

export function fillWeek(
  brandId: number,
  body: {
    week_start: string
    account_id?: string
    dry_run?: boolean
    proposals?: CalendarProposal[]
    count?: number
  }
) {
  return request<{
    proposals: CalendarProposal[]
    posts?: Post[]
    dry_run: boolean
  }>(`/api/brand-profiles/${brandId}/fill-week`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listCalendar(opts: {
  from: string
  to: string
  brand_profile_id?: number
  account_id?: string
}) {
  const q = new URLSearchParams({ from: opts.from, to: opts.to })
  if (opts.brand_profile_id != null) q.set('brand_profile_id', String(opts.brand_profile_id))
  if (opts.account_id) q.set('account_id', opts.account_id)
  return request<{ posts: Post[] }>(`/api/calendar?${q}`)
}

export function listPostSlides(postId: number) {
  return request<{ slides: PostSlide[] }>(`/api/posts/${postId}/slides`)
}

export function addPostSlide(postId: number) {
  return request<{ slide: PostSlide; slides: PostSlide[] }>(`/api/posts/${postId}/slides`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function removePostSlide(postId: number, slideId: number) {
  return request<{ slides: PostSlide[] }>(`/api/posts/${postId}/slides/${slideId}`, {
    method: 'DELETE',
  })
}

export function patchPostSlide(
  postId: number,
  slideId: number,
  fields: { canvas_json?: string; source_image_url?: string }
) {
  return request<{ slide: PostSlide }>(`/api/posts/${postId}/slides/${slideId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  })
}

export function approveMedia(
  postId: number,
  body: {
    canvas_json: string
    slides: Array<{ position: number; png_base64: string; canvas_json: string }>
  }
) {
  return request<PostResponse & { slides?: PostSlide[]; note?: string }>(
    `/api/posts/${postId}/approve-media`,
    {
      method: 'POST',
      body: JSON.stringify({ actor: DEV_OPERATOR, ...body }),
    }
  )
}

export function publishPostToInstagram(postId: number) {
  return request<PostResponse & { graph?: { media_id: string }; note?: string }>(
    `/api/posts/${postId}/publish-instagram`,
    {
      method: 'POST',
      body: JSON.stringify({ actor: DEV_OPERATOR }),
    }
  )
}

export type Iteration = {
  id: number
  post_id: number
  author: string
  comment: string
  created_at: string
}

export type IterationsResponse = {
  iterations: Iteration[]
  revisions: number
  max_revisions: number
}

export function listIterations(postId: number) {
  return request<IterationsResponse>(`/api/posts/${postId}/iterations`)
}

export function listRuns(limit = 20) {
  return request<RunsListResponse>(`/api/runs?limit=${limit}`)
}

export function getRun(runId: number) {
  return request<RunDetailResponse>(`/api/runs/${runId}`)
}

/** Lesson 10 — SSE URL (EventSource cannot set custom headers; use same-origin / proxy). */
export function runEventsStreamUrl(runId: number, afterSeq = 0) {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || ''
  const q = afterSeq > 0 ? `?after=${afterSeq}` : ''
  return `${base}/api/runs/${runId}/events${q}`
}

/** Redact secrets before showing event payloads in the UI. */
export function redactPayload(value: unknown): unknown {
  const secretKey = /token|secret|authorization|password|api[_-]?key|client_secret/i
  if (Array.isArray(value)) return value.map(redactPayload)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = secretKey.test(k) ? '[redacted]' : redactPayload(v)
    }
    return out
  }
  return value
}

export function listInstagramConnections() {
  return request<InstagramListResponse>('/api/admin/instagram')
}

export type CreateInstagramBody = {
  account_id: string
  app_id: string
  client_secret: string
  redirect_uri: string
}

export function createInstagramConnection(body: CreateInstagramBody) {
  return request<{ connection: InstagramConnection }>('/api/admin/instagram', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateInstagramConnection(
  id: number,
  patch: {
    status?: string
    account_id?: string
    default_brand_profile_id?: number | null
  }
) {
  return request<{ connection: InstagramConnection }>(`/api/admin/instagram/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteInstagramConnection(id: number) {
  return request<{ ok: boolean; deleted_id: number }>(`/api/admin/instagram/${id}`, {
    method: 'DELETE',
  })
}

/** Full browser navigation (not fetch) — Meta redirects back to the API callback. */
export function instagramOAuthStartUrl(id: number) {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || ''
  return `${base}/api/auth/instagram/start/${id}`
}

export function disconnectInstagramOAuth(id: number) {
  return request<{ connection: InstagramConnection }>(`/api/auth/instagram/${id}/disconnect`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function mockConnectInstagram(id: number) {
  return request<{ connection: InstagramConnection }>(`/api/auth/instagram/${id}/mock-connect`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function connectInstagramWithToken(id: number, access_token: string) {
  return request<{ connection: InstagramConnection }>(`/api/auth/instagram/${id}/token`, {
    method: 'POST',
    body: JSON.stringify({ access_token }),
  })
}

export function getInstagramAuthConfig() {
  return request<{
    provider: string
    redirect_uri: string | null
    public_api_base: string | null
    requires_https: boolean
    note: string
  }>('/api/auth/instagram/config')
}
