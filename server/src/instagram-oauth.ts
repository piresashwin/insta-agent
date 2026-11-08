/**
 * Lesson 14 — Instagram API with Instagram Login (Business Login).
 * Consent (instagram.com) → short-lived → long-lived IG user token → /me profile.
 * Not Facebook Login / Page tokens.
 */
import crypto from 'crypto'
import db from './db'
import { encryptSecret, decryptSecret } from './crypto-secret'

// Read lazily (at call time, not at import time) so that dotenv.config() in
// server.ts has time to load .env.local before these values are consumed.
const IG_AUTHORIZE = 'https://www.instagram.com/oauth/authorize'
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token'

function igGraphBase(): string {
  const v = process.env.META_GRAPH_VERSION || 'v21.0'
  return `https://graph.instagram.com/${v}`
}

const REQUIRED_INSIGHT_SCOPES = [
  'instagram_business_manage_insights',
  'instagram_business_manage_comments',
] as const

/** Scopes for Instagram API with Instagram Login (post–Jan 2025 names). Lazy — reads env at call time. */
export function getDefaultScopes(): string {
  return (
    process.env.INSTAGRAM_OAUTH_SCOPES ||
    [
      'instagram_business_basic',
      'instagram_business_content_publish',
      ...REQUIRED_INSIGHT_SCOPES,
    ].join(',')
  )
}

export type IgConnRow = {
  id: number
  account_id: string
  app_id: string
  client_secret: string
  redirect_uri: string
  access_token: string | null
  refresh_token: string | null
  status: string
  ig_username: string | null
  page_id: string | null
  last_error: string | null
  token_expires_at: string | null
  granted_scopes?: string | null
  default_brand_profile_id?: number | null
  updated_at?: string | null
}

export function getConn(id: string | number): IgConnRow | null {
  return (
    (db.prepare('SELECT * FROM instagram_conn WHERE id = ?').get(id) as IgConnRow | undefined) ||
    null
  )
}

/** True when the connection was made before insights scopes (or is missing either). */
export function connectionNeedsReconnect(conn: {
  granted_scopes?: string | null
}): boolean {
  const raw = conn.granted_scopes
  if (raw == null || !String(raw).trim()) return true
  const parts = new Set(
    String(raw)
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return REQUIRED_INSIGHT_SCOPES.some((s) => !parts.has(s))
}

export function publicConn(row: IgConnRow) {
  return {
    id: row.id,
    account_id: row.account_id,
    status: row.status,
    ig_username: row.ig_username,
    page_id: row.page_id,
    last_error: row.last_error,
    token_expires_at: row.token_expires_at,
    default_brand_profile_id: row.default_brand_profile_id ?? null,
    updated_at: row.updated_at ?? null,
    has_token: Boolean(row.access_token),
    granted_scopes: row.granted_scopes ?? null,
    needs_reconnect: connectionNeedsReconnect(row),
  }
}

export function logAuthEvent(
  connId: number | null,
  event: string,
  detail: Record<string, unknown> = {}
) {
  const safe = { ...detail }
  for (const k of Object.keys(safe)) {
    if (/token|secret|code/i.test(k)) delete safe[k]
  }
  db.prepare(
    `INSERT INTO auth_events (conn_id, event, detail, created_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(connId, event, JSON.stringify(safe))
}

export function createOAuthState(connId: number): string {
  const state = crypto.randomBytes(24).toString('hex')
  db.prepare(
    `INSERT INTO oauth_states (state, conn_id, created_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(state, connId)
  return state
}

export function consumeOAuthState(state: string): number | null {
  const row = db
    .prepare('SELECT conn_id FROM oauth_states WHERE state = ?')
    .get(state) as { conn_id: number } | undefined
  if (!row) return null
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state)
  return row.conn_id
}

export function buildAuthorizeUrl(conn: IgConnRow, state: string): string {
  const params = new URLSearchParams({
    client_id: conn.app_id,
    redirect_uri: conn.redirect_uri,
    state,
    response_type: 'code',
    scope: getDefaultScopes(),
  })
  // force_reauth optional via env for testing re-consent
  if (process.env.INSTAGRAM_OAUTH_FORCE_REAUTH === 'true') {
    params.set('force_reauth', 'true')
  }
  return `${IG_AUTHORIZE}?${params}`
}

function appSecret(conn: IgConnRow): string {
  try {
    return decryptSecret(conn.client_secret)
  } catch {
    return conn.client_secret
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & {
    error?: { message?: string; error_user_msg?: string }
    error_message?: string
  }
  if (!res.ok || (body as { error?: unknown }).error || (body as { error_message?: string }).error_message) {
    const msg =
      (body as { error?: { message?: string; error_user_msg?: string } }).error?.error_user_msg ||
      (body as { error?: { message?: string } }).error?.message ||
      (body as { error_message?: string }).error_message ||
      `Instagram API HTTP ${res.status}`
    throw new Error(msg)
  }
  return body
}

/**
 * POST api.instagram.com/oauth/access_token
 * → short-lived Instagram User access token + user_id
 */
export async function exchangeCodeForShortToken(
  conn: IgConnRow,
  code: string
): Promise<{ access_token: string; user_id: string | number; permissions?: string[] }> {
  const form = new URLSearchParams({
    client_id: conn.app_id,
    client_secret: appSecret(conn),
    grant_type: 'authorization_code',
    redirect_uri: conn.redirect_uri,
    code,
  })
  const res = await fetch(IG_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const body = await readJson<{
    access_token: string
    user_id: string | number
    permissions?: string[]
  }>(res)
  if (!body.access_token || body.user_id == null) {
    throw new Error('Instagram token response missing access_token or user_id')
  }
  return body
}

/**
 * GET graph.instagram.com/access_token?grant_type=ig_exchange_token
 * → long-lived Instagram User token (~60 days)
 */
export async function exchangeForLongLived(
  conn: IgConnRow,
  shortToken: string
): Promise<{ access_token: string; expires_in?: number; token_type?: string }> {
  const url = new URL(`${igGraphBase()}/access_token`)
  url.searchParams.set('grant_type', 'ig_exchange_token')
  url.searchParams.set('client_secret', appSecret(conn))
  url.searchParams.set('access_token', shortToken)
  const res = await fetch(url)
  return readJson(res)
}

/** GET graph.instagram.com/me — Instagram user profile for this app. */
export async function resolveInstagramUser(userToken: string): Promise<{
  igUserId: string
  igUsername: string | null
  accountType: string | null
}> {
  const url = new URL(`${igGraphBase()}/me`)
  url.searchParams.set('fields', 'user_id,username,account_type')
  url.searchParams.set('access_token', userToken)
  const res = await fetch(url)
  const body = await readJson<{
    user_id?: string | number
    id?: string | number
    username?: string
    account_type?: string
  }>(res)
  const igUserId = String(body.user_id ?? body.id ?? '')
  if (!igUserId) throw new Error('Instagram /me did not return user_id')
  return {
    igUserId,
    igUsername: body.username || null,
    accountType: body.account_type || null,
  }
}

/** @deprecated use resolveInstagramUser — kept name alias for older imports */
export const resolveInstagramBusiness = resolveInstagramUser

export function markConnError(connId: number, message: string) {
  db.prepare(
    `UPDATE instagram_conn
     SET status = 'error', last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(message, connId)
  logAuthEvent(connId, 'oauth_error', { message })
}

export function applySuccessfulConnect(
  connId: number,
  data: {
    igUserId: string
    igUsername: string | null
    accessToken: string
    expiresIn?: number
    /** Scope string requested at connect time (Meta may not echo grants). */
    grantedScopes?: string | null
  }
) {
  const expiresAt =
    data.expiresIn != null
      ? new Date(Date.now() + data.expiresIn * 1000).toISOString()
      : null
  const scopes = data.grantedScopes ?? getDefaultScopes()
  db.prepare(
    `UPDATE instagram_conn
     SET account_id = ?,
         access_token = ?,
         refresh_token = NULL,
         status = 'connected',
         ig_username = ?,
         page_id = NULL,
         last_error = NULL,
         token_expires_at = ?,
         granted_scopes = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    data.igUserId,
    encryptSecret(data.accessToken),
    data.igUsername,
    expiresAt,
    scopes,
    connId
  )
  logAuthEvent(connId, 'oauth_connected', {
    ig_user_id: data.igUserId,
    ig_username: data.igUsername,
    provider: 'instagram_login',
    granted_scopes: scopes,
  })
}

/**
 * Refresh a long-lived IG user token (unversioned endpoint).
 * On Graph failure: records last_error and returns { ok: false } — does not throw.
 */
export async function refreshIgAccessToken(conn: IgConnRow): Promise<{
  ok: boolean
  expires_at?: string | null
  error?: string
}> {
  if (!conn.access_token) {
    const msg = 'No access_token to refresh'
    markConnError(conn.id, msg)
    return { ok: false, error: msg }
  }
  let token: string
  try {
    token = decryptSecret(conn.access_token)
  } catch {
    token = conn.access_token
  }
  try {
    const url = new URL('https://graph.instagram.com/refresh_access_token')
    url.searchParams.set('grant_type', 'ig_refresh_token')
    url.searchParams.set('access_token', token)
    const res = await fetch(url)
    const body = (await res.json()) as {
      access_token?: string
      expires_in?: number
      error?: { message?: string }
    }
    if (!res.ok || body.error || !body.access_token) {
      const msg = body.error?.message || `Token refresh HTTP ${res.status}`
      db.prepare(
        `UPDATE instagram_conn SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(msg, conn.id)
      logAuthEvent(conn.id, 'token_refresh_failed', { message: msg })
      return { ok: false, error: msg }
    }
    const expiresAt =
      body.expires_in != null
        ? new Date(Date.now() + body.expires_in * 1000).toISOString()
        : null
    db.prepare(
      `UPDATE instagram_conn
       SET access_token = ?,
           token_expires_at = ?,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(encryptSecret(body.access_token), expiresAt, conn.id)
    logAuthEvent(conn.id, 'token_refreshed', { expires_at: expiresAt })
    return { ok: true, expires_at: expiresAt }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    db.prepare(
      `UPDATE instagram_conn SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(msg, conn.id)
    logAuthEvent(conn.id, 'token_refresh_failed', { message: msg })
    return { ok: false, error: msg }
  }
}

export function disconnectConn(connId: number) {
  db.prepare(
    `UPDATE instagram_conn
     SET access_token = NULL,
         refresh_token = NULL,
         status = 'disconnected',
         token_expires_at = NULL,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(connId)
  logAuthEvent(connId, 'oauth_disconnected', {})
}

export function applyMockConnect(connId: number) {
  if (process.env.INSTAGRAM_OAUTH_MOCK !== 'true') {
    const err = new Error(
      'INSTAGRAM_OAUTH_MOCK is not enabled — set it in .env.local for local mock connect'
    ) as Error & { status?: number }
    err.status = 400
    throw err
  }
  applySuccessfulConnect(connId, {
    igUserId: `mock_ig_${connId}`,
    igUsername: 'mock_business',
    accessToken: `mock_ig_user_token_${connId}`,
    expiresIn: 60 * 60 * 24 * 60,
  })
  logAuthEvent(connId, 'oauth_mock_connected', { provider: 'instagram_login' })
}

/**
 * Local/dev connect without HTTPS callback:
 * Meta App Dashboard → Instagram → API setup → Generate token.
 * Verifies via graph.instagram.com/me; tries long-lived exchange when possible.
 */
export async function connectWithPastToken(
  conn: IgConnRow,
  rawToken: string
): Promise<{ igUserId: string; igUsername: string | null }> {
  const token = rawToken.trim()
  if (!token) throw Object.assign(new Error('access_token required'), { status: 400 })

  let accessToken = token
  let expiresIn: number | undefined
  try {
    const longLived = await exchangeForLongLived(conn, token)
    accessToken = longLived.access_token
    expiresIn = longLived.expires_in
  } catch {
    // Dashboard-generated tokens are often already long-lived; /me is the real check.
  }

  const ig = await resolveInstagramUser(accessToken)
  applySuccessfulConnect(conn.id, {
    igUserId: ig.igUserId,
    igUsername: ig.igUsername,
    accessToken,
    expiresIn,
  })
  logAuthEvent(conn.id, 'token_pasted_connected', {
    ig_user_id: ig.igUserId,
    ig_username: ig.igUsername,
    provider: 'instagram_login',
  })
  return ig
}

export function clientRedirect(pathQuery: string): string {
  const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
  return `${origin.replace(/\/$/, '')}/${pathQuery.replace(/^\//, '')}`
}
