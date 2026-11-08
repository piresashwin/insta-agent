import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `p4-oauth-${Math.random().toString(36).slice(2)}.db`)

let connectionNeedsReconnect: typeof import('../instagram-oauth').connectionNeedsReconnect
let getDefaultScopes: typeof import('../instagram-oauth').getDefaultScopes
let buildAuthorizeUrl: typeof import('../instagram-oauth').buildAuthorizeUrl
let refreshIgAccessToken: typeof import('../instagram-oauth').refreshIgAccessToken
let publicConn: typeof import('../instagram-oauth').publicConn
let db: typeof import('../db').default

beforeAll(async () => {
  db = (await import('../db')).default
  const oauth = await import('../instagram-oauth')
  connectionNeedsReconnect = oauth.connectionNeedsReconnect
  getDefaultScopes = oauth.getDefaultScopes
  buildAuthorizeUrl = oauth.buildAuthorizeUrl
  refreshIgAccessToken = oauth.refreshIgAccessToken
  publicConn = oauth.publicConn
})

afterEach(() => {
  delete process.env.INSTAGRAM_OAUTH_SCOPES
  vi.unstubAllGlobals()
})

describe('Phase 4 OAuth scopes + reconnect', () => {
  it('getDefaultScopes includes insights and comments scopes', () => {
    const scopes = getDefaultScopes()
    expect(scopes).toContain('instagram_business_manage_insights')
    expect(scopes).toContain('instagram_business_manage_comments')
    expect(scopes).toContain('instagram_business_basic')
    expect(scopes).toContain('instagram_business_content_publish')
  })

  it('getDefaultScopes / buildAuthorizeUrl honor live env override', () => {
    process.env.INSTAGRAM_OAUTH_SCOPES = 'custom_scope_a,custom_scope_b'
    expect(getDefaultScopes()).toBe('custom_scope_a,custom_scope_b')
    const url = buildAuthorizeUrl(
      {
        id: 1,
        account_id: 'x',
        app_id: 'app',
        client_secret: 'sec',
        redirect_uri: 'https://example.com/cb',
        access_token: null,
        refresh_token: null,
        status: 'pending',
        ig_username: null,
        page_id: null,
        last_error: null,
        token_expires_at: null,
      },
      'state123',
    )
    expect(url).toContain('custom_scope_a')
    expect(url).toContain('custom_scope_b')
  })

  it('connectionNeedsReconnect is true when granted_scopes is null/empty/missing insights', () => {
    expect(connectionNeedsReconnect({ granted_scopes: null })).toBe(true)
    expect(connectionNeedsReconnect({ granted_scopes: '' })).toBe(true)
    expect(
      connectionNeedsReconnect({
        granted_scopes: 'instagram_business_basic,instagram_business_content_publish',
      }),
    ).toBe(true)
    expect(
      connectionNeedsReconnect({
        granted_scopes:
          'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments',
      }),
    ).toBe(false)
  })

  it('publicConn surfaces needs_reconnect', () => {
    const pub = publicConn({
      id: 9,
      account_id: 'ig1',
      app_id: 'a',
      client_secret: 's',
      redirect_uri: 'https://x',
      access_token: 't',
      refresh_token: null,
      status: 'connected',
      ig_username: 'u',
      page_id: null,
      last_error: null,
      token_expires_at: null,
      granted_scopes: null,
    })
    expect(pub.needs_reconnect).toBe(true)
    expect(pub.granted_scopes).toBeNull()
  })

  it('refreshIgAccessToken records last_error on failure and does not throw', async () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO instagram_conn (account_id, app_id, client_secret, redirect_uri, access_token, status)
           VALUES ('acct_refresh', 'app', 'sec', 'https://cb', 'tok', 'connected')`,
        )
        .run().lastInsertRowid,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'token expired' } }),
      })),
    )
    const conn = db.prepare('SELECT * FROM instagram_conn WHERE id = ?').get(id) as Parameters<
      typeof refreshIgAccessToken
    >[0]
    const result = await refreshIgAccessToken(conn)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/token expired|refresh/i)
    const row = db.prepare('SELECT last_error FROM instagram_conn WHERE id = ?').get(id) as {
      last_error: string | null
    }
    expect(row.last_error).toBeTruthy()
  })
})
