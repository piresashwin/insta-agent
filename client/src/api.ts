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
    body: JSON.stringify({ actor: DEV_OPERATOR }),
  })
}

export type JobRow = {
  id: number
  kind: string
  status: string
  post_id: number | null
  run_id: number | null
  error: string | null
  result_json?: string | null
  result?: unknown
  created_at: string
  updated_at: string | null
}

export function listJobs(opts: { post_id?: number; status?: string; limit?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.post_id != null) params.set('post_id', String(opts.post_id))
  if (opts.status) params.set('status', opts.status)
  if (opts.limit != null) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request<{ jobs: JobRow[] }>(`/api/jobs${qs ? `?${qs}` : ''}`)
}

export function getJob(jobId: number) {
  return request<{ job: JobRow }>(`/api/jobs/${jobId}`)
}

export type PostVersionRow = {
  id: number
  post_id: number
  version: number
  snapshot: string
  actor_kind: string | null
  actor_name: string | null
  actor_client: string | null
  created_at: string
}

export function listPostVersions(postId: number) {
  return request<{ versions: PostVersionRow[]; proposed: unknown[] }>(
    `/api/posts/${postId}/versions`,
  )
}

export function diffPostVersions(postId: number, from: number, to: number) {
  return request<{
    from: number
    to: number
    changed: Record<string, { from: unknown; to: unknown }>
  }>(`/api/posts/${postId}/diff?from=${from}&to=${to}`)
}

export function approvePost(postId: number) {
  return request<PostResponse>(`/api/posts/${postId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ actor: DEV_OPERATOR }),
  })
}

export function requestChanges(
  postId: number,
  comment: string,
  opts?: { target?: 'hook' | 'caption' | 'visual' | 'hashtags'; rerun?: boolean },
) {
  return request<
    PostResponse & {
      note?: string
      run_id?: number
      job_id?: number
      rerun_error?: string
    }
  >(`/api/posts/${postId}/request-changes`, {
    method: 'POST',
    body: JSON.stringify({
      author: DEV_OPERATOR,
      comment,
      ...opts,
    }),
  })
}

export function restartPost(postId: number, opts?: { clear?: boolean }) {
  return request<PostResponse & { note?: string }>(`/api/posts/${postId}/restart`, {
    method: 'POST',
    body: JSON.stringify({
      actor: DEV_OPERATOR,
      clear: opts?.clear !== false,
    }),
  })
}

export function deletePost(postId: number) {
  return request<{ ok: boolean; deleted_id: number }>(`/api/posts/${postId}`, {
    method: 'DELETE',
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
    provider?: 'pexels' | 'openai' | 'runware'
    quality?: 'draft' | 'final'
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
      ...(opts?.quality ? { quality: opts.quality } : {}),
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

export function generateVisualIdentity(
  brandId: number,
  body?: { persist?: boolean }
) {
  return request<{
    identity: import('@instagram-agent/shared').VisualIdentity
    visual_summary: string
    brand: BrandProfile
    note?: string
  }>(`/api/brand-profiles/${brandId}/generate-visual-identity`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  })
}

export function getPromptPreview(postId: number) {
  return request<import('@instagram-agent/shared').PromptPreview & {
    post_id: number
    status: string
  }>(`/api/posts/${postId}/prompt-preview`)
}

export function patchPromptPreview(
  postId: number,
  vars?: import('@instagram-agent/shared').PromptVars | null,
  opts?: { reset?: boolean }
) {
  return request<import('@instagram-agent/shared').PromptPreview & {
    post_id: number
    status?: string
  }>(`/api/posts/${postId}/prompt-preview`, {
    method: 'PATCH',
    body: JSON.stringify(
      opts?.reset ? { reset: true } : { vars }
    ),
  })
}

export function generateMedia(
  postId: number,
  body?: {
    provider?: string
    quality?: string
    bake_only?: boolean
    actor?: { id: string; name: string }
  }
) {
  return request<{
    job_id?: number
    post: Post
    slides?: PostSlide[]
    note?: string
  }>(`/api/posts/${postId}/generate-media`, {
    method: 'POST',
    body: JSON.stringify({
      actor: body?.actor || { id: 'local-dev', name: 'Local operator' },
      provider: body?.provider,
      quality: body?.quality,
      bake_only: body?.bake_only,
    }),
  })
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
  fields: {
    canvas_json?: string
    source_image_url?: string
    text?: string
    image_prompt?: string
    stock_search_query?: string
  }
) {
  return request<{ slide: PostSlide }>(`/api/posts/${postId}/slides/${slideId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  })
}

export function approveMedia(
  postId: number,
  body: {
    canvas_json?: string
    stage_reel?: boolean
    slides?: Array<{ position: number; png_base64: string; canvas_json: string }>
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
  return request<
    PostResponse & {
      graph?: {
        media_id: string
        creation_id?: string
        permalink?: string | null
        shortcode?: string | null
        children_ids?: string[]
        learn_id?: number
      }
      note?: string
    }
  >(`/api/posts/${postId}/publish-instagram`, {
    method: 'POST',
    body: JSON.stringify({ actor: DEV_OPERATOR }),
  })
}

export function getPostInstagram(postId: number) {
  return request<{
    post_id: number
    account_id: string | null
    media_id: string | null
    creation_id: string | null
    permalink: string | null
    shortcode: string | null
    published_at: string | null
    children_ids: string[]
    status: string
  }>(`/api/posts/${postId}/instagram`)
}

export function getPostInstagramInsights(postId: number) {
  return request<{
    post_id: number
    media_id: string
    metrics: Record<string, number>
    raw?: unknown
    note?: string
  }>(`/api/posts/${postId}/instagram/insights`)
}

export function getPostInstagramComments(postId: number) {
  return request<{
    post_id: number
    media_id: string
    comments: Array<{
      id: string
      text?: string
      username?: string
      timestamp?: string
      like_count?: number
    }>
  }>(`/api/posts/${postId}/instagram/comments`)
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

export type PublishTunnelStatus = {
  base_url: string | null
  pid: number | null
  process_alive: boolean
  reachable: boolean | null
  source: 'database' | 'env' | 'none'
  log_path: string
}

export function getPublishTunnel() {
  return request<{ tunnel: PublishTunnelStatus }>('/api/admin/publish-tunnel')
}

/** Spawn cloudflared and store URL in SQLite for live publish. */
export function startPublishTunnel() {
  return request<{ tunnel: PublishTunnelStatus }>('/api/admin/publish-tunnel', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function setPublishTunnelUrl(base_url: string) {
  return request<{ tunnel: PublishTunnelStatus }>('/api/admin/publish-tunnel', {
    method: 'PUT',
    body: JSON.stringify({ base_url }),
  })
}

export function stopPublishTunnel() {
  return request<{ tunnel: PublishTunnelStatus }>('/api/admin/publish-tunnel', {
    method: 'DELETE',
  })
}

export type PostReviewScore = {
  criterion_id: string
  score: number
  note: string
  passed: boolean
}

export type PostReviewItem = {
  target: string
  criterion_id: string
  problem: string
  fix: string
  severity: string
}

export type PostReviewData = {
  id: number
  post_id: number
  overall_score?: number
  passed: boolean
  scores?: PostReviewScore[]
  items?: PostReviewItem[]
  created_at: string
}

export function getPostReview(postId: number) {
  return request<{ review: PostReviewData | null }>(`/api/posts/${postId}/review`)
}

export type RubricCriterion = {
  id: string
  target: 'hook' | 'caption' | 'slides' | 'visual' | 'hashtags' | 'cta'
  weight: number
  description: string
  pass_example?: string
  fail_example?: string
  min_score?: number
}

export type BrandRubricData = {
  id?: number
  version?: number
  criteria: RubricCriterion[]
  edited_by_human?: number
  created_at?: string
}

export function getBrandRubric(brandId: number) {
  return request<{ rubric: BrandRubricData | null }>(`/api/brands/${brandId}/rubric`)
}

export function saveBrandRubric(brandId: number, criteria: RubricCriterion[]) {
  return request<{ ok: boolean; version: number }>(`/api/brands/${brandId}/rubric`, {
    method: 'POST',
    body: JSON.stringify({ criteria }),
  })
}

export function generateBrandRubric(brandId: number) {
  return request<{ rubric: { criteria: RubricCriterion[] }; version: number; saved: boolean }>(
    `/api/brands/${brandId}/rubric/generate`,
    { method: 'POST' }
  )
}

// ---- Phase 2 API ----

export type BudgetData = {
  cap: number
  spent: number
  forecast: number
  remaining: number
  pct_used: number
  by_kind: Record<string, number>
  at_capacity: boolean
}

export type BudgetSettings = {
  budget_monthly_usd: number
  budget_per_post_soft_usd: number
  budget_max_image_rerolls: number
  budget_max_reel_rerolls: number
}

export function getBudget() {
  return request<BudgetData>('/api/budget')
}

export function getBudgetSettings() {
  return request<BudgetSettings>('/api/budget/settings')
}

export function saveBudgetSettings(body: Partial<BudgetSettings>) {
  return request<{ ok: boolean }>('/api/budget/settings', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function estimateCost(body: { kind: string; format?: string; duration_sec?: number }) {
  return request<{ estimate: number; spent: number; cap: number; would_exceed: boolean }>(
    '/api/budget/estimate',
    { method: 'POST', body: JSON.stringify(body) }
  )
}

// ---- Ideas (Explore → Shortlist → Craft) ----

export type { Idea, IdeaStatus } from '@instagram-agent/shared'

export function listIdeas(brandId: number, status?: string) {
  const q = new URLSearchParams({ brand_profile_id: String(brandId) })
  if (status) q.set('status', status)
  return request<{ ideas: import('@instagram-agent/shared').Idea[] }>(`/api/ideas?${q}`)
}

export function getIdea(id: number) {
  return request<{ idea: import('@instagram-agent/shared').Idea }>(`/api/ideas/${id}`)
}

export function generateIdeas(
  brandId: number,
  opts?: {
    count?: number
    steer?: string
    pillar?: string
    format?: string
    like_idea_id?: number
  },
) {
  return request<{
    batch_id: string
    ideas: import('@instagram-agent/shared').Idea[]
    dropped: number
  }>('/api/ideas/generate', {
    method: 'POST',
    body: JSON.stringify({
      brand_profile_id: brandId,
      actor: DEV_OPERATOR,
      ...opts,
    }),
  })
}

export function createIdea(
  brandId: number,
  body: {
    topic: string
    angle?: string
    pillar?: string
    format?: string
    hooks?: string[]
  },
) {
  return request<{ idea: import('@instagram-agent/shared').Idea }>('/api/ideas', {
    method: 'POST',
    body: JSON.stringify({
      brand_profile_id: brandId,
      actor: DEV_OPERATOR,
      ...body,
    }),
  })
}

export function updateIdea(
  id: number,
  patch: Partial<{
    topic: string
    angle: string | null
    pillar: string | null
    format: string
    chosen_hook: string | null
    direction: string | null
    status: string
  }>,
) {
  return request<{ idea: import('@instagram-agent/shared').Idea }>(`/api/ideas/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, actor: DEV_OPERATOR }),
  })
}

export function scheduleIdea(id: number, body: { date: string; account_id?: string | null }) {
  return request<{
    idea: import('@instagram-agent/shared').Idea
    post: Post
  }>(`/api/ideas/${id}/schedule`, {
    method: 'POST',
    body: JSON.stringify({ ...body, actor: DEV_OPERATOR }),
  })
}

export function unscheduleIdea(id: number) {
  return request<{ idea: import('@instagram-agent/shared').Idea }>(`/api/ideas/${id}/unschedule`, {
    method: 'POST',
    body: JSON.stringify({ actor: DEV_OPERATOR }),
  })
}

export type HealthCheck = { ok: boolean; detail?: string }
export type HealthData = { ok: boolean; checks: Record<string, HealthCheck> }

export function getHealth() {
  return request<HealthData>('/api/health')
}

export type ActivityItem = {
  kind: 'post_version' | 'approval' | 'iteration' | 'run' | 'auth'
  created_at: string
  post_id: number | null
  brand_id: number | null
  actor_kind: string | null
  actor_name: string | null
  actor_client: string | null
  detail: Record<string, unknown>
}

export function listActivity(opts: { limit?: number; kind?: string; actor_kind?: string } = {}) {
  const params = new URLSearchParams()
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.kind) params.set('kind', opts.kind)
  if (opts.actor_kind) params.set('actor_kind', opts.actor_kind)
  const qs = params.toString()
  return request<{ items: ActivityItem[] }>(`/api/activity${qs ? `?${qs}` : ''}`)
}

export function bulkApprovePosts(postIds: number[]) {
  return request<{ approved: number[]; skipped: Array<{ id: number; reason: string }> }>(
    '/api/posts/bulk-approve',
    { method: 'POST', body: JSON.stringify({ post_ids: postIds }) }
  )
}

// ── Studio: Scene + Assets ────────────────────────────────────────────────────

export type AssetItem = {
  id: number
  kind: 'image' | 'video' | 'font' | 'logo' | 'audio'
  url: string
  w: number | null
  h: number | null
  source: 'ai' | 'stock' | 'upload' | 'render'
  provider: string | null
  prompt: string | null
  sha256: string | null
  post_id: number | null
  brand_id: number | null
  created_at: string
}

export function getPostScene(postId: number) {
  return request<{ scene_json: string | null; canvas_json: string | null; format: string }>(
    `/api/posts/${postId}/scene`
  )
}

export function savePostScene(postId: number, sceneJson: string) {
  return request<{ ok: boolean }>(`/api/posts/${postId}/scene`, {
    method: 'PATCH',
    body: JSON.stringify({ scene_json: sceneJson }),
  })
}

export function listAssets(opts: { brand_id?: number; post_id?: number; kind?: string } = {}) {
  const params = new URLSearchParams()
  if (opts.brand_id) params.set('brand_id', String(opts.brand_id))
  if (opts.post_id)  params.set('post_id',  String(opts.post_id))
  if (opts.kind)     params.set('kind',      opts.kind)
  const qs = params.toString()
  return request<{ assets: AssetItem[] }>(`/api/assets${qs ? `?${qs}` : ''}`)
}

export function createAsset(body: Omit<AssetItem, 'id' | 'created_at'>) {
  return request<AssetItem>('/api/assets', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export type StudioActionName =
  | 'generate-background'
  | 'variations'
  | 'replace-from-stock'
  | 'rewrite-text'
  | 'punch-up-text'
  | 'alternate-hooks'
  | 'auto-layout'

export function studioAction(
  postId: number,
  action: StudioActionName,
  body: Record<string, unknown> = {},
) {
  return request<{
    action: string
    costLabel: string
    scene_json?: string
    assets?: Array<{ url: string; sha256?: string | null; prompt?: string }>
    hooks?: string[]
    note?: string
    job_id?: number
  }>(`/api/posts/${postId}/studio/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function renderPost(postId: number) {
  return request<{
    sceneHash: string
    pages: Array<{ url: string; sha256: string; w: number; h: number }>
  }>(`/api/posts/${postId}/render`, { method: 'POST', body: '{}' })
}

// ---- Phase 4 insights ----

export function getInsightsAccount(accountId: string) {
  return request<{
    account_id: string
    daily: Array<{
      account_id: string
      date: string
      followers: number | null
      reach: number | null
      views: number | null
      accounts_engaged: number | null
      link_taps: number | null
      final: boolean
    }>
    audience:
      | { hidden: true; reason: string }
      | {
          account_id: string
          captured_at: string
          follower_count_at_capture: number | null
          demographics_json: string | null
        }
      | null
    publish_markers: Array<{ date: string; media_id: string; thumbnail_url: string | null }>
  }>(`/api/insights/account?account_id=${encodeURIComponent(accountId)}`)
}

export function getInsightsDigest(brandProfileId: number) {
  return request<
    | {
        insufficientData: true
        count: number
        needed: number
      }
    | {
        brand_profile_id: number
        correlational: true
        post_count: number
        median_score: number
        finding_line: string
        top: Array<{
          post_id: number
          hook: string | null
          format: string | null
          pillar: string | null
          score: number
        }>
        bottom: Array<{
          post_id: number
          hook: string | null
          format: string | null
          pillar: string | null
          score: number
        }>
        lift_by_format: Array<{ key: string; mean_score: number; lift_vs_median: number; count: number }>
        lift_by_pillar: Array<{ key: string; mean_score: number; lift_vs_median: number; count: number }>
      }
  >(`/api/insights/digest?brand_profile_id=${brandProfileId}`)
}
