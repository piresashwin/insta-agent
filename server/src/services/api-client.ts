/**
 * Phase 2 — thin HTTP client used by the MCP process to talk to Express.
 * Keeps a single SQLite writer (the Express job worker).
 */
export type ApiClientOpts = {
  baseUrl?: string
  token?: string | null
  fetchImpl?: typeof fetch
}

export class ApiClient {
  readonly baseUrl: string
  private token: string | null
  private fetchImpl: typeof fetch

  constructor(opts: ApiClientOpts = {}) {
    this.baseUrl = (opts.baseUrl || process.env.API_BASE_URL || 'http://127.0.0.1:3001').replace(
      /\/$/,
      '',
    )
    this.token =
      opts.token ??
      process.env.OPERATOR_TOKEN ??
      readOperatorTokenFromSettings() ??
      null
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(extra || {}),
    }
    if (this.token) h.Authorization = `Bearer ${this.token}`
    return h
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data: T
    try {
      data = (text ? JSON.parse(text) : {}) as T
    } catch {
      data = { raw: text } as T
    }
    return { ok: res.ok, status: res.status, data }
  }

  startAgentRun(postId: string | number, body: Record<string, unknown> = {}) {
    return this.request<{
      post?: { id: number; status: string }
      run_id?: number
      job_id?: number
      note?: string
      error?: string
    }>('POST', `/api/posts/${postId}/agent-run`, body)
  }

  getJob(jobId: number) {
    return this.request<{ job?: unknown; error?: string }>('GET', `/api/jobs/${jobId}`)
  }

  listJobs(query: { post_id?: number; status?: string; limit?: number } = {}) {
    const qs = new URLSearchParams()
    if (query.post_id != null) qs.set('post_id', String(query.post_id))
    if (query.status) qs.set('status', query.status)
    if (query.limit != null) qs.set('limit', String(query.limit))
    const q = qs.toString()
    return this.request<{ jobs?: unknown[] }>('GET', `/api/jobs${q ? `?${q}` : ''}`)
  }
}

function readOperatorTokenFromSettings(): string | null {
  try {
    // Lazy require so ApiClient can be constructed in MCP without pulling DB at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = (require('../db') as typeof import('../db')).default
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = 'operator_token'")
      .get() as { value: string } | undefined
    return row?.value?.trim() || null
  } catch {
    return null
  }
}

export function defaultApiClient(): ApiClient {
  return new ApiClient()
}
