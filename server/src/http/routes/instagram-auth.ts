import crypto from 'crypto'
import { Router, type IRouter, type Request, type Response } from 'express'
import db from '../../db'
import { ApiError } from '../../orchestrator'
import { getBrandProfile } from '../../brand'
import {
  applyMockConnect,
  applySuccessfulConnect,
  buildAuthorizeUrl,
  clientRedirect,
  consumeOAuthState,
  createOAuthState,
  disconnectConn,
  exchangeCodeForShortToken,
  exchangeForLongLived,
  getConn,
  logAuthEvent,
  markConnError,
  publicConn,
  resolveInstagramUser,
  connectWithPastToken,
} from '../../instagram-oauth'
import { publishApiBase } from '../../media/r2'
import { sendApiError } from '../helpers'

export const instagramAuthRouter: IRouter = Router()

// ---------- Instagram (Admin + OAuth Lesson 14) ----------

/** GET /api/admin/instagram → mounted as /admin/instagram */
export const instagramAdminRouter: IRouter = Router()

instagramAdminRouter.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM instagram_conn ORDER BY id').all() as ReturnType<
    typeof getConn
  >[]
  res.json({
    connections: rows.filter(Boolean).map((r) => publicConn(r!)),
  })
})

instagramAdminRouter.post('/', (req: Request, res: Response) => {
  const body = (req.body || {}) as {
    account_id?: string
    app_id?: string
    client_secret?: string
    redirect_uri?: string
  }
  const app_id = body.app_id || process.env.INSTAGRAM_APP_ID
  const client_secret = body.client_secret || process.env.INSTAGRAM_CLIENT_SECRET
  const redirect_uri =
    body.redirect_uri ||
    process.env.INSTAGRAM_REDIRECT_URI ||
    (process.env.PUBLIC_API_BASE
      ? `${process.env.PUBLIC_API_BASE.replace(/\/$/, '')}/api/auth/instagram/callback`
      : 'https://localhost/api/auth/instagram/callback')
  const account_id = body.account_id?.trim() || `pending:${crypto.randomUUID()}`

  if (!app_id || !client_secret) {
    return res.status(400).json({
      error: 'app_id and client_secret required (or set INSTAGRAM_* env)',
    })
  }
  const exists = db.prepare('SELECT id FROM instagram_conn WHERE account_id = ?').get(account_id)
  if (exists) return res.status(409).json({ error: 'account already exists' })
  const info = db
    .prepare(
      `INSERT INTO instagram_conn (account_id, app_id, client_secret, redirect_uri, status, updated_at)
     VALUES (?, ?, ?, ?, 'configured', CURRENT_TIMESTAMP)`
    )
    .run(account_id, app_id, client_secret, redirect_uri)
  const row = getConn(Number(info.lastInsertRowid))
  logAuthEvent(row!.id, 'credentials_saved', { account_id })
  res.status(201).json({ connection: publicConn(row!) })
})

instagramAdminRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const existing = getConn(id)
    if (!existing) return res.status(404).json({ error: 'connection not found' })

    const body = (req.body || {}) as {
      account_id?: string
      status?: string
      app_id?: string
      client_secret?: string
      redirect_uri?: string
      default_brand_profile_id?: number | null
    }
    if (body.status === 'connected') {
      return res.status(400).json({
        error: 'Cannot set connected manually — use GET /api/auth/instagram/start/:id',
      })
    }
    const allowedStatus = new Set(['configured', 'disconnected', 'error'])
    const upd: Record<string, string | number | null> = {}
    if (body.account_id !== undefined) upd.account_id = body.account_id
    if (body.app_id !== undefined) upd.app_id = body.app_id
    if (body.client_secret !== undefined) upd.client_secret = body.client_secret
    if (body.redirect_uri !== undefined) upd.redirect_uri = body.redirect_uri
    if (body.default_brand_profile_id !== undefined) {
      if (body.default_brand_profile_id == null) {
        upd.default_brand_profile_id = null
      } else {
        const bp = getBrandProfile(body.default_brand_profile_id)
        if (!bp) return res.status(400).json({ error: 'brand profile not found' })
        upd.default_brand_profile_id = bp.id
      }
    }
    if (body.status !== undefined) {
      if (!allowedStatus.has(body.status)) {
        return res
          .status(400)
          .json({ error: 'invalid status (allowed: configured, disconnected, error)' })
      }
      upd.status = body.status
    }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: 'no fields to update' })
    const entries = Object.entries(upd)
    const set = entries.map(([k]) => `${k} = ?`).join(', ')
    db.prepare(`UPDATE instagram_conn SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      ...entries.map(([, v]) => v),
      id
    )
    res.json({ connection: publicConn(getConn(id)!) })
  } catch (e) {
    sendApiError(res, e)
  }
})

instagramAdminRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const existing = getConn(req.params.id)
    if (!existing) return res.status(404).json({ error: 'connection not found' })
    db.prepare('DELETE FROM oauth_states WHERE conn_id = ?').run(req.params.id)
    db.prepare('DELETE FROM instagram_conn WHERE id = ?').run(req.params.id)
    logAuthEvent(Number(req.params.id), 'credentials_deleted', {})
    res.json({ ok: true, deleted_id: Number(req.params.id) })
  } catch (e) {
    sendApiError(res, e)
  }
})

/**
 * Suggested HTTPS callback for Instagram Login.
 */
instagramAuthRouter.get('/config', (_req: Request, res: Response) => {
  const publicBase = (publishApiBase() || process.env.PUBLIC_API_BASE || '').replace(/\/$/, '')
  const redirect =
    process.env.INSTAGRAM_REDIRECT_URI ||
    (publicBase ? `${publicBase}/api/auth/instagram/callback` : '')
  res.json({
    provider: 'instagram_login',
    redirect_uri: redirect || null,
    public_api_base: publicBase || null,
    requires_https: true,
    note:
      redirect && redirect.startsWith('https://')
        ? 'Use this exact HTTPS URI in Meta → Instagram Business login redirect URIs (and when saving credentials).'
        : 'Browser OAuth needs a stable HTTPS callback (PUBLIC_API_BASE / INSTAGRAM_REDIRECT_URI). Ephemeral tunnels often fail Meta. For local: paste a token from Meta → Generate token.',
  })
})

/** Start Instagram Login → redirect to Instagram consent. */
instagramAuthRouter.get('/start/:id', (req: Request, res: Response) => {
  try {
    const conn = getConn(req.params.id)
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    if (process.env.INSTAGRAM_OAUTH_MOCK === 'true' && req.query.mock === '1') {
      applyMockConnect(conn.id)
      return res.redirect(clientRedirect('?tab=connect&oauth=mock_connected'))
    }
    const state = createOAuthState(conn.id)
    const url = buildAuthorizeUrl(conn, state)
    logAuthEvent(conn.id, 'oauth_start', {
      redirect_uri: conn.redirect_uri,
      provider: 'instagram_login',
    })
    res.redirect(url)
  } catch (e) {
    sendApiError(res, e)
  }
})

/** OAuth callback — Instagram Login code → short → long-lived → /me. */
instagramAuthRouter.get('/callback', async (req: Request, res: Response) => {
  const q = req.query as { code?: string; state?: string; error?: string; error_description?: string }
  try {
    if (q.error) {
      const msg = q.error_description || q.error
      const connId = q.state ? consumeOAuthState(q.state) : null
      if (connId) markConnError(connId, msg)
      return res.redirect(
        clientRedirect(`?tab=connect&oauth=error&message=${encodeURIComponent(msg)}`)
      )
    }
    if (!q.code || !q.state) {
      return res.redirect(
        clientRedirect('?tab=connect&oauth=error&message=' + encodeURIComponent('missing code/state'))
      )
    }
    const connId = consumeOAuthState(q.state)
    if (connId == null) {
      return res.redirect(
        clientRedirect(
          '?tab=connect&oauth=error&message=' + encodeURIComponent('invalid or expired OAuth state')
        )
      )
    }
    const conn = getConn(connId)
    if (!conn) {
      return res.redirect(
        clientRedirect('?tab=connect&oauth=error&message=' + encodeURIComponent('connection missing'))
      )
    }

    try {
      const short = await exchangeCodeForShortToken(conn, q.code)
      const longLived = await exchangeForLongLived(conn, short.access_token)
      const ig = await resolveInstagramUser(longLived.access_token)
      applySuccessfulConnect(connId, {
        igUserId: ig.igUserId,
        igUsername: ig.igUsername,
        accessToken: longLived.access_token,
        expiresIn: longLived.expires_in,
      })
      return res.redirect(
        clientRedirect(
          `?tab=connect&oauth=connected&username=${encodeURIComponent(ig.igUsername || ig.igUserId)}`
        )
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth failed'
      markConnError(connId, message)
      return res.redirect(
        clientRedirect(`?tab=connect&oauth=error&message=${encodeURIComponent(message)}`)
      )
    }
  } catch (e) {
    sendApiError(res, e)
  }
})

instagramAuthRouter.post('/:id/disconnect', (req: Request, res: Response) => {
  try {
    const conn = getConn(req.params.id)
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    disconnectConn(conn.id)
    res.json({ connection: publicConn(getConn(conn.id)!) })
  } catch (e) {
    sendApiError(res, e)
  }
})

/**
 * Paste a token from Meta App Dashboard (Generate token).
 */
instagramAuthRouter.post('/:id/token', async (req: Request, res: Response) => {
  try {
    const conn = getConn(req.params.id)
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    const access_token = ((req.body || {}) as { access_token?: string }).access_token
    if (!access_token?.trim()) {
      return res.status(400).json({ error: 'access_token required' })
    }
    try {
      await connectWithPastToken(conn, access_token)
      res.json({ connection: publicConn(getConn(conn.id)!) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token connect failed'
      markConnError(conn.id, message)
      return res.status(400).json({ error: message })
    }
  } catch (e) {
    sendApiError(res, e)
  }
})

/** Dev-only: complete OAuth without Meta when INSTAGRAM_OAUTH_MOCK=true. */
instagramAuthRouter.post('/:id/mock-connect', (req: Request, res: Response) => {
  try {
    const conn = getConn(req.params.id)
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    applyMockConnect(conn.id)
    res.json({ connection: publicConn(getConn(conn.id)!) })
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 400 && e instanceof Error) {
      return res.status(400).json({ error: e.message })
    }
    sendApiError(res, e)
  }
})

// Suppress unused import warning — ApiError is imported for sendApiError usage
void ApiError
