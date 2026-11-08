// Express backend for the Instagram content agent
// Orchestrator + REST API + LangChain content-skill bridge.
import path from 'path'
import express, { type Request, type Response, type NextFunction } from 'express'
import dotenv from 'dotenv'
import db from './db'
import { failStaleRuns } from './runs'
import { ApiError } from './orchestrator'
import { assetsRoot } from './media/stock'
import { openaiImageConfig } from './media/openai-image'

import { brandsRouter } from './http/routes/brands'
import { calendarRouter } from './http/routes/calendar'
import { postsRouter } from './http/routes/posts'
import { postActionsRouter } from './http/routes/post-actions'
import { slidesRouter } from './http/routes/slides'
import { mediaRouter } from './http/routes/media'
import { instagramPostsRouter } from './http/routes/instagram-posts'
import { instagramAuthRouter, instagramAdminRouter } from './http/routes/instagram-auth'
import { adminRouter } from './http/routes/admin'
import { runsRouter } from './http/routes/runs'
import { budgetRouter } from './http/routes/budget'
import { activityRouter } from './http/routes/activity'
import { eventsRouter } from './http/routes/events'
import { studioRouter } from './http/routes/studio'
import { jobsRouter } from './http/routes/jobs'
import { insightsRouter } from './http/routes/insights'
import { ideasRouter } from './http/routes/ideas'
import { startJobWorker } from './jobs'

// __dirname is server/src (or dist) — .env.local lives at the repo root, two levels up.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

/** Lesson 08 — every error response is `{ error: string }`. */
function sendApiError(res: Response, e: unknown) {
  if (e instanceof ApiError) return res.status(e.status).json({ error: e.message })
  const message = e instanceof Error ? e.message : 'Internal error'
  console.error('[content-agent] unhandled:', message)
  return res.status(500).json({ error: 'Internal server error' })
}

const app = express()
// Apply 40 MB limit only to media-approval routes; everything else gets 1 MB.
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path.includes('/approve-media') || req.path.includes('/generate-media')) {
    express.json({ limit: '40mb' })(req, _res, next)
  } else {
    express.json({ limit: '1mb' })(req, _res, next)
  }
})

// Dev CORS before static so canvas bake can read /assets cross-origin.
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin
  const allowed = new Set([
    process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])
  if (origin && allowed.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin)
  } else {
    res.header('Access-Control-Allow-Origin', process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.header('Access-Control-Expose-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ---------- Auth middleware ----------
// Routes whitelisted from token auth (OAuth callback must be browser-reachable).
const AUTH_WHITELIST = new Set(['/api/auth/instagram/callback'])

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const operatorToken = process.env.OPERATOR_TOKEN
  if (!operatorToken) {
    return next()
  }
  if (AUTH_WHITELIST.has(req.path) || req.path.startsWith('/api/auth/instagram/callback')) {
    return next()
  }
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token || token !== operatorToken) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid OPERATOR_TOKEN' })
  }
  next()
})

// Lesson 13 — serve downloaded stock assets (Graph needs PUBLIC_API_BASE HTTPS later).
app.use('/assets', express.static(assetsRoot()))

const PORT = Number(process.env.PORT || 3001)
const dbPath = path.join(__dirname, '..', 'content-agent.db')

// ---------- API catalog (Lesson 08) ----------
app.get('/api', (_req: Request, res: Response) => {
  res.json({
    name: 'instagram-agent',
    error_shape: { error: 'string' },
    resources: {
      posts: {
        list: 'GET /api/posts?status=',
        create: 'POST /api/posts',
        get: 'GET /api/posts/:id',
        patch: 'PATCH /api/posts/:id',
        delete: 'DELETE /api/posts/:id',
        agent_run: 'POST /api/posts/:id/agent-run',
        approve: 'POST /api/posts/:id/approve',
        request_changes: 'POST /api/posts/:id/request-changes',
        restart: 'POST /api/posts/:id/restart',
        iterations: 'GET /api/posts/:id/iterations',
        fetch_media: 'POST /api/posts/:id/fetch-media',
        approve_media: 'POST /api/posts/:id/approve-media',
        prompt_preview: 'GET/PATCH /api/posts/:id/prompt-preview',
        generate_media: 'POST /api/posts/:id/generate-media',
        slides: 'GET/POST /api/posts/:id/slides',
        publish_instagram: 'POST /api/posts/:id/publish-instagram',
        instagram: 'GET /api/posts/:id/instagram',
        instagram_insights: 'GET /api/posts/:id/instagram/insights',
        instagram_comments: 'GET /api/posts/:id/instagram/comments',
      },
      media: {
        providers: ['pexels', 'openai'],
        openai_image: openaiImageConfig(),
        note: 'OpenAI images use IMAGE_OPENAI_* (separate from chat OPENAI_* / LM Studio)',
      },
      runs: {
        list: 'GET /api/runs?post_id=&limit=',
        get: 'GET /api/runs/:id',
        events_sse: 'GET /api/runs/:id/events?after=',
      },
      brand_profiles: {
        list: 'GET /api/brand-profiles',
        create: 'POST /api/brand-profiles',
        get: 'GET /api/brand-profiles/:id',
        patch: 'PATCH /api/brand-profiles/:id',
        delete: 'DELETE /api/brand-profiles/:id',
        generate: 'POST /api/brand-profiles/generate',
        generate_visual_identity: 'POST /api/brand-profiles/:id/generate-visual-identity',
        fill_week: 'POST /api/brand-profiles/:id/fill-week',
      },
      calendar: {
        list: 'GET /api/calendar?from=&to=&brand_profile_id=&account_id=',
      },
      ideas: {
        list: 'GET /api/ideas?brand_profile_id=&status=',
        generate: 'POST /api/ideas/generate',
        create: 'POST /api/ideas',
        get: 'GET /api/ideas/:id',
        patch: 'PATCH /api/ideas/:id',
        schedule: 'POST /api/ideas/:id/schedule',
        unschedule: 'POST /api/ideas/:id/unschedule',
      },
      instagram: {
        list: 'GET /api/admin/instagram',
        save_credentials: 'POST /api/admin/instagram',
        oauth_start: 'GET /api/auth/instagram/start/:id',
        oauth_callback: 'GET /api/auth/instagram/callback',
        disconnect: 'POST /api/auth/instagram/:id/disconnect',
      },
      publish_tunnel: {
        status: 'GET /api/admin/publish-tunnel',
        start: 'POST /api/admin/publish-tunnel',
        set_url: 'PUT /api/admin/publish-tunnel',
        stop: 'DELETE /api/admin/publish-tunnel',
      },
    },
  })
})

// ---------- Health ----------
app.get('/api/health', (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {}

  try {
    db.prepare('SELECT 1').get()
    checks.db = { ok: true }
  } catch (err) {
    checks.db = { ok: false, detail: String(err) }
  }

  for (const role of ['writer', 'judge', 'planner', 'vision'] as const) {
    const envKey = `LLM_${role.toUpperCase()}`
    checks[`llm_${role}`] = {
      ok: !!(process.env[envKey] || process.env.OPENAI_API_KEY || process.env.RUNWARE_API_KEY),
      detail: process.env[envKey] ? process.env[envKey]!.split(':')[0] : undefined,
    }
  }

  try {
    const conns = db
      .prepare('SELECT id, status, ig_username, token_expires_at FROM instagram_conn')
      .all() as Array<{ id: number; status: string; ig_username: string | null; token_expires_at: string | null }>
    checks.instagram = {
      ok: conns.some((c) => c.status === 'connected'),
      detail: conns.map((c) => `${c.ig_username ?? c.id}:${c.status}`).join(', ') || 'none',
    }
  } catch {
    checks.instagram = { ok: false, detail: 'query failed' }
  }

  try {
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd),0) as total FROM spend_ledger WHERE budget_scope='prod' AND created_at >= ?",
      )
      .get(monthStart.toISOString()) as { total: number }
    const cap = parseFloat(
      (db.prepare("SELECT value FROM app_settings WHERE key='budget_monthly_usd'").get() as { value: string } | undefined)?.value ?? '10',
    )
    checks.budget = {
      ok: row.total < cap,
      detail: `$${row.total.toFixed(2)} of $${cap}`,
    }
  } catch {
    checks.budget = { ok: true, detail: 'ledger not yet populated' }
  }

  const allOk = Object.values(checks).every((c) => c.ok)
  res.status(allOk ? 200 : 207).json({ ok: allOk, checks })
})

// ---------- Route mounts ----------
app.use('/api/brand-profiles', brandsRouter)
app.use('/api/calendar', calendarRouter)
app.use('/api/posts', postsRouter)
app.use('/api/posts', postActionsRouter)
app.use('/api/posts', slidesRouter)
app.use('/api/posts', mediaRouter)
app.use('/api/posts', instagramPostsRouter)
app.use('/api/auth/instagram', instagramAuthRouter)
app.use('/api/admin/instagram', instagramAdminRouter)
app.use('/api/admin', adminRouter)
app.use('/api/runs', runsRouter)
app.use('/api/jobs', jobsRouter)
app.use('/api/budget', budgetRouter)
app.use('/api/activity', activityRouter)
app.use('/api/events', eventsRouter)
app.use('/api/brands', brandsRouter)
app.use('/api/posts', studioRouter)
app.use('/api', studioRouter)  // for /api/assets
app.use('/api/insights', insightsRouter)
app.use('/api/ideas', ideasRouter)

// ---------- Errors (Lesson 08 contract) ----------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  sendApiError(res, err)
})

// ---------- Start ----------
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'
app.listen(PORT, BIND_HOST, () => {
  if (!process.env.OPERATOR_TOKEN) {
    console.warn(
      '[content-agent] WARNING: OPERATOR_TOKEN is not set — all API routes are open. ' +
        'Set OPERATOR_TOKEN=<secret> in .env.local for production.'
    )
  }
  console.log(`[content-agent] backend listening on http://${BIND_HOST}:${PORT}`)
  console.log(`[content-agent] db at ${dbPath}`)
  const orphaned = failStaleRuns(0)
  if (orphaned > 0) {
    console.log(`[content-agent] closed ${orphaned} orphaned running run(s)`)
  }
  startJobWorker()
  console.log('[content-agent] job worker started')
  const staleMs = Number(process.env.AGENT_STALE_RUN_MS || 10 * 60_000)
  setInterval(() => {
    const n = failStaleRuns(staleMs)
    if (n > 0) console.warn(`[content-agent] closed ${n} stale running run(s)`)
  }, Math.min(staleMs, 60_000)).unref()

  try {
    const stuckPublishing = db
      .prepare(`UPDATE posts SET status='failed', error='Process crashed during publish' WHERE status='publishing'`)
      .run()
    const stuckGenerating = db
      .prepare(`UPDATE posts SET status='draft', error='Process crashed during media generation' WHERE status='media_generating'`)
      .run()
    if ((stuckPublishing.changes ?? 0) > 0) {
      console.warn(`[content-agent] reset ${stuckPublishing.changes} post(s) stuck in 'publishing' → 'failed'`)
    }
    if ((stuckGenerating.changes ?? 0) > 0) {
      console.warn(`[content-agent] reset ${stuckGenerating.changes} post(s) stuck in 'media_generating' → 'draft'`)
    }
  } catch (e) {
    console.error('[content-agent] stuck-post sweep failed:', e)
  }
})
