// Express backend for the Instagram content agent
// Orchestrator + REST API + LangChain content-skill bridge.
import path from 'path'
import express, { type Request, type Response, type NextFunction } from 'express'
import crypto from 'crypto'
import dotenv from 'dotenv'
import type { Actor, Post, PostFormat } from '@instagram-agent/shared'
import { defaultCanvasDoc } from '@instagram-agent/shared'
import db from './db'
import { runAgent } from './agent/loop'
import type { FinishDraft } from './agent/schemas'
import {
  createRun,
  appendEvent,
  completeRun,
  getRun,
  getRunWithEvents,
  listEventsAfter,
  listRuns,
  compactPayload,
} from './runs'
import {
  ApiError,
  canStartAgentRun,
  getPost,
  MAX_REVISIONS,
  transitionPost,
  updatePostFields,
} from './orchestrator'
import {
  AGENT_PIPELINE,
  assertAllowed,
  humanFromBody,
  type PolicyActor,
} from './policy'
import { downloadStockForPost, mediaQueryFromPost, assetsRoot } from './media/stock'
import {
  generateOpenAiImageForPost,
  imagePromptFromPost,
  openaiImageConfigured,
  openaiImageConfig,
} from './media/openai-image'
import { uploadStagedPng } from './media/r2'
import {
  createBrandProfile,
  createDraftFromProposal,
  defaultBrandForAccount,
  deleteBrandProfile,
  getBrandProfile,
  listBrandProfiles,
  listCalendarPosts,
  parsePillars,
  parsePreferredDays,
  pickWeekDates,
  renderBrandBrief,
  resolveBrandContext,
  updateBrandProfile,
  type BrandProfileInput,
} from './brand'
import { planWeekTopics } from './skills/week-plan'
import { generateBrandFromFeedback } from './skills/generate-brand-profile'
import type { CalendarProposal } from '@instagram-agent/shared'
import {
  addSlide,
  applyCarouselSlidePlan,
  clearStagedUrls,
  ensureSlidesForFormat,
  listSlides,
  removeSlide,
  slidePlanFromAgentOutput,
  updateSlide,
} from './slides'
import { publishPostToInstagram, resolvePublishConn } from './instagram-publish'
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
} from './instagram-oauth'

// __dirname is server/src (or dist) — .env.local lives at the repo root, two levels up.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

const app = express()
app.use(express.json({ limit: '40mb' }))

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
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  res.header('Access-Control-Expose-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Lesson 13 — serve downloaded stock assets (Graph needs PUBLIC_API_BASE HTTPS later).
app.use('/assets', express.static(assetsRoot()))

const PORT = Number(process.env.PORT || 3001)
const dbPath = path.join(__dirname, '..', 'content-agent.db')

function generateId() {
  return crypto.randomUUID()
}
void generateId

/** Lesson 08 — every error response is `{ error: string }`. */
function sendApiError(res: Response, e: unknown) {
  if (e instanceof ApiError) return res.status(e.status).json({ error: e.message })
  const message = e instanceof Error ? e.message : 'Internal error'
  console.error('[content-agent] unhandled:', message)
  return res.status(500).json({ error: message })
}

/** Field whitelist for PATCH — never status (use transition routes). */
const PATCHABLE_POST_FIELDS = new Set([
  'topic',
  'hook',
  'hook_alternates',
  'caption',
  'hashtags',
  'format',
  'background_style',
  'image_prompt',
  'stock_search_query',
  'reel_prompt',
  'canvas_json',
  'account_id',
  'brand_profile_id',
  'brand_overrides',
  'scheduled_at',
  'pillar',
])

function normalizeFormat(raw?: string | null): PostFormat {
  if (raw === 'reel' || raw === 'carousel' || raw === 'feed') return raw
  return 'feed'
}

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
        slides: 'GET/POST /api/posts/:id/slides',
        publish_instagram: 'POST /api/posts/:id/publish-instagram',
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
        fill_week: 'POST /api/brand-profiles/:id/fill-week',
      },
      calendar: {
        list: 'GET /api/calendar?from=&to=&brand_profile_id=&account_id=',
      },
      instagram: {
        list: 'GET /api/admin/instagram',
        save_credentials: 'POST /api/admin/instagram',
        oauth_start: 'GET /api/auth/instagram/start/:id',
        oauth_callback: 'GET /api/auth/instagram/callback',
        disconnect: 'POST /api/auth/instagram/:id/disconnect',
      },
    },
  })
})

// ---------- Brand profiles ----------
app.get('/api/brand-profiles', (_req: Request, res: Response) => {
  res.json({ brands: listBrandProfiles() })
})

/** Autofill brand draft from freeform feedback (does not persist — client applies). */
app.post('/api/brand-profiles/generate', async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { feedback?: string; name?: string }
    const feedback = (body.feedback || '').trim()
    if (!feedback) {
      return res.status(400).json({ error: 'feedback is required' })
    }
    const draft = await generateBrandFromFeedback({
      feedback,
      nameHint: body.name,
    })
    res.json({
      draft: {
        ...draft,
        pillars: draft.pillars.map((name) => ({ name })),
        preferred_days: draft.preferred_days,
      },
      note: 'Draft generated — review and Save to persist',
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Brand generate failed'
    console.error('[brand-generate]', message)
    res.status(502).json({ error: message })
  }
})

app.post('/api/brand-profiles', (req: Request, res: Response) => {
  try {
    const brand = createBrandProfile((req.body || {}) as BrandProfileInput)
    res.status(201).json({ brand })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Create brand failed'
    res.status(400).json({ error: message })
  }
})

app.get('/api/brand-profiles/:id', (req: Request, res: Response) => {
  const brand = getBrandProfile(req.params.id)
  if (!brand) return res.status(404).json({ error: 'brand not found' })
  res.json({ brand })
})

app.patch('/api/brand-profiles/:id', (req: Request, res: Response) => {
  try {
    const brand = updateBrandProfile(req.params.id, (req.body || {}) as BrandProfileInput)
    if (!brand) return res.status(404).json({ error: 'brand not found' })
    res.json({ brand })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Update brand failed'
    res.status(400).json({ error: message })
  }
})

app.delete('/api/brand-profiles/:id', (req: Request, res: Response) => {
  const ok = deleteBrandProfile(req.params.id)
  if (!ok) return res.status(404).json({ error: 'brand not found' })
  db.prepare(
    'UPDATE instagram_conn SET default_brand_profile_id = NULL WHERE default_brand_profile_id = ?'
  ).run(Number(req.params.id))
  res.json({ ok: true })
})

app.post('/api/brand-profiles/:id/fill-week', async (req: Request, res: Response) => {
  try {
    const brand = getBrandProfile(req.params.id)
    if (!brand) return res.status(404).json({ error: 'brand not found' })
    const body = (req.body || {}) as {
      week_start?: string
      account_id?: string
      dry_run?: boolean
      proposals?: CalendarProposal[]
      count?: number
    }
    const weekStart = (body.week_start || new Date().toISOString()).slice(0, 10)
    const count = Math.max(
      1,
      Math.min(14, Number(body.count) || brand.posts_per_week || 3)
    )
    const days = parsePreferredDays(brand.preferred_days)
    const dates = pickWeekDates(weekStart, days, count)
    const pillars = parsePillars(brand.pillars).map((p) => p.name)

    let proposals: CalendarProposal[] = Array.isArray(body.proposals) ? body.proposals : []
    if (!proposals.length) {
      const planned = await planWeekTopics({
        brandBrief: renderBrandBrief(brand),
        dates,
        pillars,
        niche: brand.niche,
        audience: brand.audience,
        defaultFormat: brand.default_format,
      })
      proposals = planned.proposals.map((p, i) => ({
        date: p.date || dates[i] || dates[0],
        topic: p.topic,
        pillar: p.pillar,
        format: p.format || brand.default_format || 'feed',
        angle: p.angle,
        background_style: brand.default_background_style,
      }))
    }

    const dryRun = body.dry_run !== false
    if (dryRun) {
      return res.json({ proposals, dry_run: true })
    }

    const posts = proposals.map((proposal) =>
      createDraftFromProposal({
        brand_profile_id: brand.id,
        account_id: body.account_id || null,
        proposal,
      })
    )
    res.status(201).json({ posts, proposals, dry_run: false })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Fill week failed'
    console.error('[fill-week]', message)
    res.status(502).json({ error: message })
  }
})

app.get('/api/calendar', (req: Request, res: Response) => {
  const from = typeof req.query.from === 'string' ? req.query.from : ''
  const to = typeof req.query.to === 'string' ? req.query.to : ''
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to query params required (ISO dates)' })
  }
  const brand_profile_id =
    typeof req.query.brand_profile_id === 'string' && req.query.brand_profile_id
      ? Number(req.query.brand_profile_id)
      : undefined
  const account_id =
    typeof req.query.account_id === 'string' ? req.query.account_id : undefined
  const posts = listCalendarPosts({
    from,
    to,
    brand_profile_id: Number.isFinite(brand_profile_id) ? brand_profile_id : undefined,
    account_id,
  })
  res.json({ posts })
})

// ---------- Posts ----------
app.post('/api/posts', (req: Request, res: Response) => {
  const { topic, account_id, background_style, format, brand_profile_id, scheduled_at, pillar } =
    (req.body || {}) as {
      topic?: string
      account_id?: string
      background_style?: string
      format?: string
      brand_profile_id?: number
      scheduled_at?: string
      pillar?: string
    }
  const fmt = format ? normalizeFormat(format) : null
  const brandId =
    brand_profile_id != null
      ? Number(brand_profile_id)
      : defaultBrandForAccount(account_id) || null
  const brand = brandId ? getBrandProfile(brandId) : null
  const bg = background_style || brand?.default_background_style || null
  const finalFormat = fmt || (brand?.default_format ? normalizeFormat(brand.default_format) : null)
  const info = db
    .prepare(
      `INSERT INTO posts (
        account_id, topic, background_style, format, status,
        brand_profile_id, scheduled_at, pillar, created_at, updated_at
      ) VALUES (?, COALESCE(?, ''), ?, ?, 'draft', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(
      account_id || null,
      topic || null,
      bg,
      finalFormat,
      brandId,
      scheduled_at || null,
      pillar || null
    )
  const post = getPost(Number(info.lastInsertRowid))
  if (post && finalFormat) {
    ensureSlidesForFormat(post.id, finalFormat, post.topic || post.hook)
  }
  res.status(201).json({ post, slides: post ? listSlides(post.id) : [] })
})

app.get('/api/posts', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : ''
  const rows = (
    status
      ? db
          .prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC')
          .all(status)
      : db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all()
  ) as Post[]
  res.json({ posts: rows })
})

app.get('/api/posts/:id', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  res.json({ post, slides: listSlides(post.id) })
})

app.patch('/api/posts/:id', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as Record<string, unknown>
    if ('status' in body) {
      return res.status(400).json({
        error: 'Cannot PATCH status — use approve / request-changes / agent-run / publish routes',
      })
    }

    const sets: string[] = []
    const values: Array<string | number | null> = []
    for (const [key, value] of Object.entries(body)) {
      if (!PATCHABLE_POST_FIELDS.has(key)) {
        return res.status(400).json({ error: `patch field not allowed: ${key}` })
      }
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
        return res.status(400).json({ error: `invalid type for ${key}` })
      }
      sets.push(`${key} = ?`)
      values.push(value as string | number | null)
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' })

    sets.push('updated_at = CURRENT_TIMESTAMP')
    values.push(req.params.id)
    db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    res.json({ post: getPost(req.params.id) })
  } catch (e) {
    sendApiError(res, e)
  }
})

app.delete('/api/posts/:id', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    if (post.status === 'publishing' || post.status === 'published') {
      return res.status(409).json({ error: `Cannot delete post in status "${post.status}"` })
    }
    const id = Number(req.params.id)
    db.prepare('DELETE FROM iterations WHERE post_id = ?').run(id)
    db.prepare('DELETE FROM posts WHERE id = ?').run(id)
    res.json({ ok: true, deleted_id: id })
  } catch (e) {
    sendApiError(res, e)
  }
})

// ---------- Agent loop (cognition) → pending_approval ----------
app.post('/api/posts/:id/agent-run', async (req: Request, res: Response) => {
  const post_id = req.params.id
  const post = getPost(post_id)
  if (!post) return res.status(404).json({ error: 'post not found' })

  // Orchestrator owns the edge; cognition may not invent status.
  if (!canStartAgentRun(post)) {
    return res.status(409).json({
      error: `Cannot run agent from status "${post.status}" (allowed: draft, changes_requested)`,
    })
  }

  const alreadyRunning = listRuns({ postId: Number(post_id), limit: 5 }).find(
    (r) => r.status === 'running' && (r.kind === 'agent' || r.kind === 'pipeline')
  )
  if (alreadyRunning) {
    return res.status(409).json({
      error: `Agent already running (run_id=${alreadyRunning.id})`,
      run_id: alreadyRunning.id,
    })
  }

  const revisionNote =
    post.status === 'changes_requested' && post.revision_comments
      ? `\nOperator revision notes (must address): ${post.revision_comments}`
      : ''

  const brandCtx = resolveBrandContext(post)
  const styleNote = brandCtx.backgroundStyle
    ? `\nPreferred background style: "${brandCtx.backgroundStyle}". When calling media_prompts, pass backgroundStyle: "${brandCtx.backgroundStyle}" so stock_search_query aligns.`
    : ''
  const brandNote = brandCtx.profile
    ? `\nBrand profile: "${brandCtx.profile.name}". Stay on-brand (voice + visual).`
    : ''
  const pillarNote = post.pillar ? `\nContent pillar: ${post.pillar}.` : ''

  const goal = `Draft a complete Instagram post for topic "${post.topic || '(no topic)'}".
Produce hook, caption, hashtags, image_prompt, and stock_search_query (short Pexels keywords).
Do not publish or fetch media.${styleNote}${brandNote}${pillarNote}${revisionNote}

Brand brief:
${brandCtx.briefMd}`

  const run = createRun({
    goal,
    postId: Number(post_id),
    model: process.env.OPENAI_MODEL || null,
    kind: 'agent',
  })
  appendEvent(run.id, 'status', { status: 'running' })

  const agentActor: PolicyActor = { ...AGENT_PIPELINE, run_id: run.id }

  try {
    // Policy before mutation: agent may draft, never publish.
    assertAllowed(agentActor, 'post.draft', { type: 'post', post }, run.id)
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    throw e
  }

  // Lesson 10: return run_id immediately so the client can open SSE while cognition runs.
  res.status(202).json({
    post,
    run_id: run.id,
    note: 'Agent loop started — subscribe to GET /api/runs/:id/events',
  })

  void (async () => {
    try {
      const result = await runAgent({
        goal,
        topic: post.topic || undefined,
        backgroundStyle: brandCtx.backgroundStyle,
        brand: {
          brandGuide: brandCtx.briefMd,
          brandConfig: brandCtx.profile
            ? JSON.stringify({
                name: brandCtx.profile.name,
                niche: brandCtx.profile.niche,
                audience: brandCtx.profile.audience,
                goals: brandCtx.profile.goals,
              })
            : undefined,
          brandVoice: brandCtx.voiceBrief || brandCtx.briefMd,
          brandVisual: brandCtx.visualBrief,
        },
        onEvent: (event) => {
          appendEvent(run.id, event.type, compactPayload(event.payload))
        },
      })

      const draft = result.draft as FinishDraft
      const latest = getPost(post_id)
      if (!latest) {
        completeRun(run.id, 'failed', 'post missing after agent loop')
        return
      }

      const hookAlternates = draft.alt_hooks
        ? JSON.stringify(draft.alt_hooks)
        : latest.hook_alternates

      const format = normalizeFormat(draft.format)
      const canvas = JSON.stringify(defaultCanvasDoc(format, draft.hook || latest.hook))
      transitionPost(post_id, 'pending_approval', {
        patch: {
          hook: draft.hook || latest.hook,
          hook_alternates: hookAlternates,
          caption: draft.caption || latest.caption,
          hashtags: draft.hashtags || latest.hashtags,
          format,
          image_prompt: draft.image_prompt || latest.image_prompt,
          stock_search_query: draft.stock_search_query || null,
          reel_prompt: draft.reel_prompt || latest.reel_prompt,
          canvas_json: canvas,
          agent_output: JSON.stringify(draft),
        },
      })
      if (format === 'carousel') {
        const plan =
          draft.slides?.length && draft.slides.length >= 2
            ? draft.slides
            : [
                {
                  text: draft.hook || latest.hook || 'Cover',
                  image_prompt: draft.image_prompt,
                  stock_search_query: draft.stock_search_query,
                },
                {
                  text: draft.angle || 'Key point',
                  image_prompt: draft.image_prompt,
                  stock_search_query: draft.stock_search_query,
                },
                {
                  text: draft.cta || 'Save this for later',
                  image_prompt: draft.image_prompt,
                  stock_search_query: draft.stock_search_query,
                },
              ]
        applyCarouselSlidePlan(Number(post_id), plan, draft.hook || latest.hook)
      } else {
        ensureSlidesForFormat(Number(post_id), format, draft.hook || latest.hook)
      }
      completeRun(run.id, 'succeeded')
    } catch (e) {
      const err = e as Error
      console.error('[content-agent] agent-run failed:', err.message)
      completeRun(run.id, 'failed', err.message || String(e))
    }
  })()
})

// ---------- Approvals ----------
app.post('/api/posts/:id/approve', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const actor = ((req.body || {}) as { actor?: Actor }).actor || ({} as Actor)
    assertAllowed(humanFromBody(actor), 'post.approve', { type: 'post', post })
    const updated = transitionPost(req.params.id, 'approved', { actor })
    res.json({ post: updated })
  } catch (e) {
    sendApiError(res, e)
  }
})

// ---------- Revisions / iterations (Lesson 07 HITL) ----------
app.post('/api/posts/:id/request-changes', (req: Request, res: Response) => {
  try {
    const post_id = req.params.id
    const post = getPost(post_id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as { author?: Actor; comment?: string }
    const author = body.author
    if (!author?.id) return res.status(400).json({ error: 'author.id required' })

    assertAllowed(humanFromBody(author), 'post.request_changes', { type: 'post', post })

    const comment = body.comment || ''
    const info = db
      .prepare('INSERT INTO iterations (post_id, author, comment) VALUES (?, ?, ?)')
      .run(post_id, author.id, comment)
    const existingComments = JSON.parse(post.revision_comments || '[]') as unknown[]
    const revisionComments = JSON.stringify([
      ...existingComments,
      { id: info.lastInsertRowid, author: author.id, comment },
    ])

    // Trigger bumps posts.revisions; read after insert for the cap.
    const afterInsert = getPost(post_id)
    const revisionCount = afterInsert?.revisions ?? post.revisions + 1
    const next = revisionCount >= MAX_REVISIONS ? 'needs_revision' : 'changes_requested'

    const updated = transitionPost(post_id, next, {
      actor: author,
      patch: { revision_comments: revisionComments },
    })
    res.json({
      post: updated,
      note:
        next === 'needs_revision'
          ? `Revision cap (${MAX_REVISIONS}) reached — restart from draft to continue`
          : undefined,
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

/** Explicit restart after needs_revision (or approved undo already uses draft via other paths). */
app.post('/api/posts/:id/restart', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const actor = ((req.body || {}) as { actor?: Actor }).actor
    if (!actor?.id) return res.status(400).json({ error: 'actor.id required' })
    assertAllowed(humanFromBody(actor), 'post.request_changes', { type: 'post', post })
    const updated = transitionPost(req.params.id, 'draft', { actor })
    res.json({ post: updated, note: 'Restarted to draft — agent-run allowed again' })
  } catch (e) {
    sendApiError(res, e)
  }
})

app.get('/api/posts/:id/iterations', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  const iterations = db
    .prepare(
      'SELECT id, post_id, author, comment, created_at FROM iterations WHERE post_id = ? ORDER BY id ASC'
    )
    .all(req.params.id)
  res.json({ iterations, revisions: post.revisions, max_revisions: MAX_REVISIONS })
})

/**
 * Media → disk + slide source_image_url → media_ready.
 * provider: pexels | openai.
 * body.slide_id → one slide; omit on carousel → fill every slide (per-slide briefs from agent_output).
 */
app.post('/api/posts/:id/fetch-media', async (req: Request, res: Response) => {
  const post_id = req.params.id
  try {
    let post = getPost(post_id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as {
      actor?: Actor
      as?: 'agent' | 'human'
      query?: string
      prompt?: string
      provider?: string
      slide_id?: number
    }
    const isAgent = body.as === 'agent'
    const human = humanFromBody(body.actor || { id: 'local-dev', name: 'Local operator' })
    const principal: PolicyActor = isAgent ? { ...AGENT_PIPELINE } : human
    const provider = (body.provider || 'pexels').toLowerCase()
    if (provider !== 'pexels' && provider !== 'openai') {
      return res.status(400).json({
        error: `provider must be "pexels" or "openai" (got "${provider}")`,
      })
    }
    if (provider === 'openai' && !openaiImageConfigured()) {
      return res.status(503).json({
        error:
          'OpenAI image gen not configured. Set IMAGE_OPENAI_API_KEY in .env.local (separate from chat OPENAI_*).',
      })
    }

    if (post.status === 'approved') {
      if (isAgent) {
        return res.status(403).json({
          error: 'Human must start media fetch from approved (agent cannot post.start_publish)',
        })
      }
      assertAllowed(human, 'post.start_publish', { type: 'post', post })
      post = transitionPost(post_id, 'media_generating')
    } else if (post.status === 'media_ready' || post.status === 'staged') {
      if (isAgent) {
        return res.status(403).json({ error: 'Agent cannot regenerate media' })
      }
      clearStagedUrls(Number(post_id))
      post = transitionPost(post_id, 'media_generating', {
        patch: { error: null, image_url: null },
      })
    } else if (post.status !== 'media_generating') {
      return res.status(409).json({
        error: `fetch-media requires approved, media_ready, staged, or media_generating, got "${post.status}"`,
      })
    }

    assertAllowed(principal, 'media.search', { type: 'post', post })

    const format = normalizeFormat(post.format)
    if (!post.format) {
      updatePostFields(post_id, { format })
      post = getPost(post_id)!
    }
    let slides = ensureSlidesForFormat(Number(post_id), format, post.hook)
    const slidePlan = slidePlanFromAgentOutput(post.agent_output)
    const brandCtx = resolveBrandContext(post)

    if (body.prompt?.trim() && provider === 'openai') {
      updatePostFields(post_id, { image_prompt: body.prompt.trim() })
      post = getPost(post_id)!
    }
    if (body.query?.trim() && provider === 'pexels') {
      updatePostFields(post_id, { stock_search_query: body.query.trim() })
      post = getPost(post_id)!
    }

    let targets =
      body.slide_id != null
        ? slides.filter((s) => s.id === Number(body.slide_id))
        : format === 'carousel'
          ? [...slides]
          : slides[0]
            ? [slides[0]]
            : []

    if (body.slide_id != null && targets.length === 0) {
      return res.status(404).json({ error: 'slide_id not found on this post' })
    }
    if (targets.length === 0) {
      slides = ensureSlidesForFormat(Number(post_id), format, post.hook)
      targets = slides[0] ? [slides[0]] : []
    }
    if (targets.length === 0) {
      return res.status(500).json({ error: 'no slides available for media fetch' })
    }

    type FilledAsset = {
      provider: string
      publicUrl: string
      relativePath: string
      photographer?: string
      model?: string
      prompt?: string
      query?: string
      slide_id: number
    }
    const filled: FilledAsset[] = []

    for (const target of targets) {
      const brief = slidePlan[target.position]
      let asset: Omit<FilledAsset, 'slide_id'>

      if (provider === 'openai') {
        const prompt = (
          (targets.length === 1 && body.prompt) ||
          brief?.image_prompt ||
          imagePromptFromPost({
            ...post,
            background_style: brandCtx.backgroundStyle,
            brandVisual: brandCtx.visualBrief,
            imagePromptExtra: brandCtx.overrides.image_prompt_extra,
          })
        ).trim()
        const generated = await generateOpenAiImageForPost(post_id, prompt, { format })
        asset = {
          provider: generated.provider,
          publicUrl: generated.publicUrl,
          relativePath: generated.relativePath,
          model: generated.model,
          prompt: generated.prompt,
        }
      } else {
        const query = (
          (targets.length === 1 && body.query) ||
          brief?.stock_search_query ||
          mediaQueryFromPost({
            ...post,
            background_style: brandCtx.backgroundStyle,
          })
        ).trim()
        const stock = await downloadStockForPost(post_id, query)
        asset = {
          provider: stock.provider,
          publicUrl: stock.publicUrl,
          relativePath: stock.relativePath,
          photographer: stock.photographer,
          query,
        }
      }

      updateSlide(target.id, {
        source_image_url: asset.publicUrl,
        staged_url: null,
      })
      filled.push({ ...asset, slide_id: target.id })
    }

    const cover = filled[0]
    const updated = transitionPost(post_id, 'media_ready', {
      patch: {
        image_url: cover?.publicUrl || null,
        source_image_url: cover?.publicUrl || null,
        media_type: format === 'carousel' ? 'carousel' : 'image',
        media_provider: cover?.provider || provider,
        reel_url: null,
      },
    })

    res.json({
      post: updated,
      slides: listSlides(Number(post_id)),
      media: cover
        ? {
            provider: cover.provider,
            model: cover.model,
            url: cover.publicUrl,
            path: cover.relativePath,
            prompt: cover.prompt,
            query: cover.query,
            photographer: cover.photographer,
            slide_id: cover.slide_id,
            slides_filled: filled.length,
          }
        : undefined,
      note:
        format === 'carousel' && filled.length > 1
          ? `Filled ${filled.length} carousel slides — switch slides in canvas, then Approve media`
          : provider === 'openai'
            ? 'AI image on disk — compose in canvas, then Approve media to stage'
            : 'Stock image on disk — compose in canvas, then Approve media to stage',
    })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Media fetch failed'
    console.error('[media]', message)
    res.status(502).json({ error: message })
  }
})

/** Slides list / add */
app.get('/api/posts/:id/slides', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  res.json({ slides: listSlides(post.id) })
})

app.post('/api/posts/:id/slides', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const format = normalizeFormat(post.format)
    if (format !== 'carousel') {
      return res.status(400).json({ error: 'Add slide only for carousel format' })
    }
    ensureSlidesForFormat(post.id, 'carousel', post.hook)
    const slide = addSlide(post.id, 'carousel', post.hook)
    if (post.format !== 'carousel') updatePostFields(post.id, { format: 'carousel' })
    res.status(201).json({ slide, slides: listSlides(post.id) })
  } catch (e) {
    sendApiError(res, e)
  }
})

app.delete('/api/posts/:id/slides/:slideId', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const slides = removeSlide(post.id, Number(req.params.slideId))
    res.json({ slides })
  } catch (e) {
    sendApiError(res, e)
  }
})

app.patch('/api/posts/:id/slides/:slideId', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const existing = listSlides(post.id).find((s) => s.id === Number(req.params.slideId))
    if (!existing) return res.status(404).json({ error: 'slide not on this post' })
    const body = (req.body || {}) as { canvas_json?: string; source_image_url?: string }
    const slide = updateSlide(existing.id, {
      canvas_json: body.canvas_json,
      source_image_url: body.source_image_url,
    })
    res.json({ slide })
  } catch (e) {
    sendApiError(res, e)
  }
})

/**
 * Approve media — client-baked PNG slides → R2 → status staged.
 * Body: { actor, canvas_json?, slides: [{ position, png_base64 }] }
 */
app.post('/api/posts/:id/approve-media', async (req: Request, res: Response) => {
  const post_id = req.params.id
  try {
    const post = getPost(post_id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as {
      actor?: Actor
      as?: 'agent' | 'human'
      canvas_json?: string
      slides?: Array<{ position: number; png_base64: string; canvas_json?: string }>
    }
    if (body.as === 'agent') {
      return res.status(403).json({ error: 'Agent cannot media.approve' })
    }
    const actor = humanFromBody(body.actor || { id: 'local-dev', name: 'Local operator' })
    assertAllowed(actor, 'media.approve', { type: 'post', post })

    const format = normalizeFormat(post.format)
    const dbSlides = ensureSlidesForFormat(Number(post_id), format, post.hook)
    const payloads = body.slides || []
    if (payloads.length === 0) {
      return res.status(400).json({ error: 'slides[] with png_base64 required' })
    }
    if (format === 'carousel' && payloads.length < 2) {
      return res.status(400).json({ error: 'carousel approve-media needs ≥2 slide PNGs' })
    }

    if (body.canvas_json) {
      updatePostFields(post_id, { canvas_json: body.canvas_json })
    }

    let firstUrl: string | null = null
    let usedLocal = false
    for (const item of payloads) {
      const slide =
        dbSlides.find((s) => s.position === item.position) || dbSlides[item.position]
      if (!slide) {
        return res.status(400).json({ error: `No slide at position ${item.position}` })
      }
      const b64 = (item.png_base64 || '').replace(/^data:image\/\w+;base64,/, '')
      if (!b64) {
        return res.status(400).json({ error: `Empty png_base64 for position ${item.position}` })
      }
      const bytes = Buffer.from(b64, 'base64')
      const uploaded = await uploadStagedPng({
        postId: post_id,
        position: item.position,
        bytes,
      })
      if (uploaded.storage === 'local') usedLocal = true
      updateSlide(slide.id, {
        staged_url: uploaded.publicUrl,
        canvas_json: item.canvas_json ?? slide.canvas_json,
      })
      if (item.position === 0 || firstUrl == null) firstUrl = uploaded.publicUrl
    }

    const updated = transitionPost(post_id, 'staged', {
      patch: {
        image_url: firstUrl,
        error: null,
        media_type: format === 'carousel' ? 'carousel' : 'image',
      },
    })

    res.json({
      post: updated,
      slides: listSlides(Number(post_id)),
      note: usedLocal
        ? 'Media staged under /assets. For Instagram, point PUBLIC_API_BASE at an HTTPS tunnel to this server.'
        : 'Media approved and uploaded to R2 — ready to publish',
    })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Approve media failed'
    console.error('[approve-media]', message)
    res.status(502).json({ error: message })
  }
})

/** @deprecated Lesson 13 — use fetch-media. Kept as alias that starts generating only. */
app.post('/api/posts/:id/publish', (req: Request, res: Response) => {
  try {
    const existing = getPost(req.params.id)
    if (!existing) return res.status(404).json({ error: 'post not found' })
    const actor = humanFromBody(((req.body || {}) as { actor?: Actor }).actor)
    assertAllowed(actor, 'post.start_publish', { type: 'post', post: existing })
    const post = transitionPost(req.params.id, 'media_generating')
    res.json({
      post,
      note: 'Moved to media_generating — call POST /api/posts/:id/fetch-media next (Lesson 13)',
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

/** @deprecated fake URL stub — use fetch-media */
app.post('/api/posts/:id/media-ready', (req: Request, res: Response) => {
  res.status(410).json({
    error: 'Gone — use POST /api/posts/:id/fetch-media for a real asset on disk',
  })
})

/**
 * Lesson 15 — gated publish from staged URLs (local /assets via tunnel, or R2).
 */
app.post('/api/posts/:id/publish-instagram', async (req: Request, res: Response) => {
  const post_id = req.params.id
  try {
    let post = getPost(post_id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as { actor?: Actor; as?: 'agent' | 'human' }
    if (body.as === 'agent') {
      return res.status(403).json({ error: 'Agent cannot instagram.publish' })
    }
    const actor = humanFromBody(body.actor || { id: 'local-dev', name: 'Local operator' })

    if (post.status === 'failed') {
      const hasStaged =
        !!post.image_url?.startsWith('https://') ||
        listSlides(post.id).some((s) => !!s.staged_url)
      post = transitionPost(post_id, hasStaged ? 'staged' : 'media_ready', {
        patch: { error: null },
      })
    }

    assertAllowed(actor, 'instagram.publish', { type: 'post', post })

    if (post.status !== 'staged') {
      return res.status(409).json({
        error: `publish-instagram requires status "staged" (approve media first), got "${post.status}"`,
      })
    }

    const conn = resolvePublishConn(post.account_id)
    post = transitionPost(post_id, 'pending_upload')
    post = transitionPost(post_id, 'publishing')

    try {
      const result = await publishPostToInstagram({ conn, post })
      const updated = transitionPost(post_id, 'published', {
        patch: {
          instagram_media_id: result.mediaId,
          account_id: conn.account_id,
          error: null,
        },
      })
      res.json({
        post: updated,
        graph: { creation_id: result.creationId, media_id: result.mediaId },
        note: 'Published to Instagram',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publish failed'
      const failed = transitionPost(post_id, 'failed', {
        patch: { error: message },
      })
      res.status(502).json({ error: message, post: failed })
    }
  } catch (e) {
    sendApiError(res, e)
  }
})

app.post('/api/posts/:id/pending-upload', (req: Request, res: Response) => {
  try {
    const post = transitionPost(req.params.id, 'pending_upload')
    res.json({ post })
  } catch (e) {
    sendApiError(res, e)
  }
})

app.post('/api/posts/:id/publishing', (req: Request, res: Response) => {
  try {
    const post = transitionPost(req.params.id, 'publishing')
    res.json({ post })
  } catch (e) {
    sendApiError(res, e)
  }
})

app.post('/api/posts/:id/published', (req: Request, res: Response) => {
  res.status(410).json({
    error: 'Gone — use POST /api/posts/:id/publish-instagram (Lesson 15 gated publish)',
  })
})

/**
 * Lesson 06 checkpoint surface: simulate “model said publish now”.
 * Agent role is always denied; deny is stored as a policy run event.
 */
app.post('/api/posts/:id/instagram-publish', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as {
      as?: 'agent' | 'human'
      actor?: Actor
    }
    const principal: PolicyActor =
      body.as === 'agent'
        ? { role: 'agent', id: 'agent:model', name: 'model-said-publish' }
        : humanFromBody(body.actor)

    assertAllowed(principal, 'instagram.publish', { type: 'post', post })

    // Stub success path for humans who pass policy (real Graph comes in lesson 15).
    res.json({
      ok: true,
      note: 'Policy allowed instagram.publish (Graph stub — lesson 15)',
      post_id: post.id,
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

// ---------- Instagram (Admin + OAuth Lesson 14) ----------
app.get('/api/admin/instagram', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM instagram_conn ORDER BY id').all() as ReturnType<
    typeof getConn
  >[]
  res.json({
    connections: rows.filter(Boolean).map((r) => publicConn(r!)),
  })
})

app.post('/api/admin/instagram', (req: Request, res: Response) => {
  const body = (req.body || {}) as {
    account_id?: string
    app_id?: string
    client_secret?: string
    redirect_uri?: string
  }
  const app_id = body.app_id || process.env.INSTAGRAM_APP_ID
  const client_secret = body.client_secret || process.env.INSTAGRAM_CLIENT_SECRET
  // Instagram Login requires HTTPS for browser OAuth. Token-paste connect does not.
  const redirect_uri =
    body.redirect_uri ||
    process.env.INSTAGRAM_REDIRECT_URI ||
    (process.env.PUBLIC_API_BASE
      ? `${process.env.PUBLIC_API_BASE.replace(/\/$/, '')}/api/auth/instagram/callback`
      : 'https://localhost/api/auth/instagram/callback')
  // Placeholder until OAuth / token paste resolves the real IG user id.
  const account_id = body.account_id?.trim() || `pending:${crypto.randomUUID()}`

  if (!app_id || !client_secret) {
    return res.status(400).json({
      error: 'app_id and client_secret required (or set INSTAGRAM_* env)',
    })
  }
  const exists = db.prepare('SELECT id FROM instagram_conn WHERE account_id = ?').get(account_id)
  if (exists) return res.status(409).json({ error: 'account already exists' })
  // Credentials stored ≠ Graph connected. Status stays "configured".
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

app.patch('/api/admin/instagram/:id', (req: Request, res: Response) => {
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
    // Manual status=connected is forbidden — only OAuth callback may connect.
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

app.delete('/api/admin/instagram/:id', (req: Request, res: Response) => {
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
 * Instagram rejects http://localhost — use PUBLIC_API_BASE (e.g. cloudflared) or INSTAGRAM_REDIRECT_URI.
 */
app.get('/api/auth/instagram/config', (_req: Request, res: Response) => {
  const publicBase = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '')
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
app.get('/api/auth/instagram/start/:id', (req: Request, res: Response) => {
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
app.get('/api/auth/instagram/callback', async (req: Request, res: Response) => {
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

app.post('/api/auth/instagram/:id/disconnect', (req: Request, res: Response) => {
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
 * Preferred local path when HTTPS callback / tunnels are unavailable.
 */
app.post('/api/auth/instagram/:id/token', async (req: Request, res: Response) => {
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
app.post('/api/auth/instagram/:id/mock-connect', (req: Request, res: Response) => {
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

app.get('/api/admin/instagram/:id/auth-events', (req: Request, res: Response) => {
  const conn = getConn(req.params.id)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  const events = db
    .prepare(
      'SELECT id, conn_id, event, detail, created_at FROM auth_events WHERE conn_id = ? ORDER BY id DESC LIMIT 50'
    )
    .all(req.params.id)
    .map((e) => {
      const row = e as { detail: string }
      try {
        return { ...row, detail: JSON.parse(row.detail) }
      } catch {
        return e
      }
    })
  res.json({ events })
})

// ---------- Durable runs (Chapter 04) + live SSE (Lesson 10) ----------
app.get('/api/runs', (req: Request, res: Response) => {
  const limit = req.query.limit as string | undefined
  const postIdRaw = req.query.post_id
  const postId = postIdRaw != null ? Number(postIdRaw) : undefined
  const runs = listRuns({ limit, postId: Number.isFinite(postId) ? postId : undefined })
  res.json({ runs })
})

app.get('/api/runs/:id', (req: Request, res: Response) => {
  const timeline = getRunWithEvents(Number(req.params.id))
  if (!timeline) return res.status(404).json({ error: 'run not found' })
  res.json(timeline)
})

/**
 * Lesson 10 — Server-Sent Events tail of run_events.
 * Query: ?after=<seq> to resume. Closes after run leaves "running".
 */
app.get('/api/runs/:id/events', (req: Request, res: Response) => {
  const runId = Number(req.params.id)
  const run = getRun(runId)
  if (!run) return res.status(404).json({ error: 'run not found' })

  let afterSeq = Number(req.query.after || 0)
  if (!Number.isFinite(afterSeq) || afterSeq < 0) afterSeq = 0

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === 'function') {
    ;(res as Response & { flushHeaders: () => void }).flushHeaders()
  }

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  send('run_meta', {
    id: run.id,
    status: run.status,
    model: run.model,
    post_id: run.post_id,
    kind: run.kind,
  })

  for (const ev of listEventsAfter(runId, afterSeq)) {
    send('run_event', ev)
    afterSeq = Math.max(afterSeq, ev.seq)
  }

  // Already finished — one shot then close.
  if (run.status !== 'running') {
    send('run_done', { id: run.id, status: run.status, error: run.error })
    return res.end()
  }

  const started = Date.now()
  const maxMs = Number(process.env.SSE_MAX_MS || 10 * 60 * 1000)
  const tickMs = Number(process.env.SSE_POLL_MS || 500)

  const timer = setInterval(() => {
    try {
      if (Date.now() - started > maxMs) {
        send('run_done', { id: runId, status: 'timeout', error: 'SSE max duration reached' })
        clearInterval(timer)
        return res.end()
      }

      for (const ev of listEventsAfter(runId, afterSeq)) {
        send('run_event', ev)
        afterSeq = Math.max(afterSeq, ev.seq)
      }

      const latest = getRun(runId)
      if (!latest) {
        send('run_done', { id: runId, status: 'missing', error: 'run disappeared' })
        clearInterval(timer)
        return res.end()
      }
      if (latest.status !== 'running') {
        send('run_done', { id: latest.id, status: latest.status, error: latest.error })
        clearInterval(timer)
        return res.end()
      }

      // Heartbeat so proxies keep the stream open.
      res.write(`: ping ${Date.now()}\n\n`)
    } catch (e) {
      console.error('[sse]', e)
      clearInterval(timer)
      try {
        res.end()
      } catch {
        /* closed */
      }
    }
  }, tickMs)

  req.on('close', () => {
    clearInterval(timer)
  })
})

// ---------- Errors (Lesson 08 contract) ----------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  sendApiError(res, err)
})

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[content-agent] backend listening on http://localhost:${PORT}`)
  console.log(`[content-agent] db at ${dbPath}`)
})
