import { Router, type IRouter, type Request, type Response } from 'express'
import type { Actor } from '@instagram-agent/shared'
import db from '../../db'
import { ApiError, getPost, MAX_REVISIONS, transitionPost, updatePostFields } from '../../orchestrator'
import {
  AGENT_PIPELINE,
  assertAllowed,
  humanFromBody,
  type PolicyActor,
} from '../../policy'
import { startAgentRunOnPost } from '../../agent/start-run'
import {
  judgeFailedRequiresOverride,
  recordApproval,
} from '../../services/approvals'
import { diffVersions, listProposedVersions, listVersions } from '../../services/versions'
import { historyActorFrom } from '../../services/attribution'
import { downloadStockForPost, mediaQueryFromPost } from '../../media/stock'
import {
  generateOpenAiImageForPost,
  imagePromptFromPost,
  openaiImageConfigured,
} from '../../media/openai-image'
import { generateReelVideo, runwareConfigured, type ReelVideoQuality } from '../../media/runware'
import { resolveBrandContext } from '../../brand'
import { queueVisionQa } from '../../media/vision-qa'
import {
  archiveSlidesForPost,
  clearStagedUrls,
  ensureSlidesForFormat,
  listSlides,
  slidePlanFromPost,
  updateSlide,
} from '../../slides'
import { sendApiError, normalizeFormat, reelRenderOpts } from '../helpers'

export const postActionsRouter: IRouter = Router()

// ---------- Agent loop (cognition) → pending_approval ----------
postActionsRouter.post('/:id/agent-run', (req: Request, res: Response) => {
  try {
    const actor = ((req.body || {}) as { actor?: Actor }).actor || ({} as Actor)
    const result = startAgentRunOnPost(req.params.id, {
      initiator: actor.id ? humanFromBody(actor) : null,
    })
    res.status(202).json(result)
  } catch (e) {
    if (e instanceof ApiError && (e as ApiError & { run_id?: number }).run_id != null) {
      return res.status(e.status).json({
        error: e.message,
        run_id: (e as ApiError & { run_id?: number }).run_id,
      })
    }
    sendApiError(res, e)
  }
})

// ---------- Approvals ----------
postActionsRouter.post('/:id/approve', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const body = (req.body || {}) as { actor?: Actor; override_reason?: string; comment?: string }
    const actor = body.actor || ({} as Actor)
    assertAllowed(humanFromBody(actor), 'post.approve', { type: 'post', post })

    if (judgeFailedRequiresOverride(req.params.id) && !body.override_reason?.trim()) {
      return res.status(400).json({
        error: 'Judge failed this version — override_reason is required to approve',
      })
    }

    const hist = historyActorFrom({ id: actor.id, name: actor.name })
    recordApproval({
      postId: req.params.id,
      stage: 'copy',
      actor: hist,
      comment: body.comment ?? null,
      overrideReason: body.override_reason ?? null,
    })
    const updated = transitionPost(req.params.id, 'approved', { actor })
    res.json({ post: updated })
  } catch (e) {
    sendApiError(res, e)
  }
})

postActionsRouter.get('/:id/versions', (req: Request, res: Response) => {
  try {
    if (!getPost(req.params.id)) return res.status(404).json({ error: 'post not found' })
    const versions = listVersions(req.params.id)
    const proposed = listProposedVersions(req.params.id)
    res.json({ versions, proposed })
  } catch (e) {
    sendApiError(res, e)
  }
})

postActionsRouter.get('/:id/diff', (req: Request, res: Response) => {
  try {
    if (!getPost(req.params.id)) return res.status(404).json({ error: 'post not found' })
    const from = Number(req.query.from)
    const to = Number(req.query.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return res.status(400).json({ error: 'from and to version numbers required' })
    }
    res.json(diffVersions(req.params.id, from, to))
  } catch (e) {
    sendApiError(res, e)
  }
})

// ---------- Revisions / iterations (Lesson 07 HITL) ----------
postActionsRouter.post('/:id/request-changes', (req: Request, res: Response) => {
  try {
    const post_id = req.params.id
    const post = getPost(post_id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as {
      author?: Actor
      comment?: string
      target?: 'hook' | 'caption' | 'visual' | 'hashtags'
      rerun?: boolean
    }
    const author = body.author
    if (!author?.id) return res.status(400).json({ error: 'author.id required' })
    if (
      body.target != null &&
      !['hook', 'caption', 'visual', 'hashtags'].includes(body.target)
    ) {
      return res.status(400).json({ error: 'invalid target' })
    }

    assertAllowed(humanFromBody(author), 'post.request_changes', { type: 'post', post })

    const comment = body.comment || ''
    const info = db
      .prepare('INSERT INTO iterations (post_id, author, comment, target) VALUES (?, ?, ?, ?)')
      .run(post_id, author.id, comment, body.target ?? null)
    const existingComments = JSON.parse(post.revision_comments || '[]') as unknown[]
    const revisionComments = JSON.stringify([
      ...existingComments,
      { id: info.lastInsertRowid, author: author.id, comment, target: body.target ?? null },
    ])

    const afterInsert = getPost(post_id)
    const revisionCount = afterInsert?.revisions ?? post.revisions + 1
    const next = revisionCount >= MAX_REVISIONS ? 'needs_revision' : 'changes_requested'

    const updated = transitionPost(post_id, next, {
      actor: author,
      patch: { revision_comments: revisionComments },
    })

    let run_id: number | undefined
    let job_id: number | undefined
    let rerun_error: string | undefined
    if (body.rerun === true && next === 'changes_requested') {
      try {
        const started = startAgentRunOnPost(post_id, {
          initiator: humanFromBody(author),
        })
        run_id = started.run_id
        job_id = started.job_id
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const status = (err as { status?: number }).status
        if (status === 409) rerun_error = msg
        else throw err
      }
    }

    res.json({
      post: updated,
      note:
        next === 'needs_revision'
          ? `Revision cap (${MAX_REVISIONS}) reached — restart from draft to continue`
          : undefined,
      run_id,
      job_id,
      rerun_error,
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

/**
 * Restart to draft. body.clear=true (default) wipes generated copy/media so agent can regenerate.
 * Keeps topic, brand, schedule, format, pillar, background_style.
 */
postActionsRouter.post('/:id/restart', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    if (post.status === 'publishing' || post.status === 'published') {
      return res.status(409).json({ error: `Cannot restart from status "${post.status}"` })
    }
    const body = (req.body || {}) as { actor?: Actor; clear?: boolean }
    const actor = body.actor
    if (!actor?.id) return res.status(400).json({ error: 'actor.id required' })
    assertAllowed(humanFromBody(actor), 'post.request_changes', { type: 'post', post })
    const clear = body.clear !== false
    const patch: Record<string, string | number | null> | undefined = clear
      ? {
          hook: null,
          hook_alternates: null,
          caption: null,
          hashtags: null,
          image_prompt: null,
          stock_search_query: null,
          reel_prompt: null,
          image_url: null,
          source_image_url: null,
          reel_url: null,
          reel_quality: null,
          media_type: null,
          media_provider: null,
          canvas_json: null,
          agent_output: null,
          error: null,
          instagram_media_id: null,
          instagram_creation_id: null,
          instagram_permalink: null,
          instagram_shortcode: null,
          instagram_published_at: null,
          instagram_children_ids: null,
          approved_by: null,
          approved_at: null,
          revision_comments: null,
        }
      : undefined
    if (clear) {
      archiveSlidesForPost(req.params.id)
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE iterations SET archived_at = ? WHERE post_id = ? AND archived_at IS NULL`,
      ).run(now, Number(req.params.id))
      db.prepare('UPDATE posts SET revisions = 0 WHERE id = ?').run(Number(req.params.id))
    }

    let updated = post
    if (post.status !== 'draft') {
      updated = transitionPost(req.params.id, 'draft', {
        actor,
        patch,
      })!
    } else if (patch) {
      updatePostFields(req.params.id, patch)
      updated = getPost(req.params.id)!
    }

    if (clear && updated) {
      const format = normalizeFormat(updated.format)
      ensureSlidesForFormat(updated.id, format, updated.hook)
    }
    res.json({
      post: getPost(req.params.id),
      note: clear
        ? 'Cleared to draft — ready to regenerate with agent-run'
        : 'Restarted to draft — agent-run allowed again',
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

postActionsRouter.get('/:id/review', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  const review = db
    .prepare(
      'SELECT * FROM post_reviews WHERE post_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(Number(req.params.id)) as Record<string, unknown> | undefined
  if (!review) return res.json({ review: null })
  const scores = typeof review.scores_json === 'string'
    ? JSON.parse(review.scores_json) as unknown
    : null
  const items = typeof review.items_json === 'string'
    ? JSON.parse(review.items_json) as unknown
    : null
  res.json({ review: { ...review, scores, items } })
})

postActionsRouter.get('/:id/iterations', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  const iterations = db
    .prepare(
      `SELECT id, post_id, author, comment, created_at FROM iterations
       WHERE post_id = ? AND archived_at IS NULL
       ORDER BY id ASC`
    )
    .all(req.params.id)
  res.json({ iterations, revisions: post.revisions, max_revisions: MAX_REVISIONS })
})

/**
 * Media → disk + slide source_image_url → media_ready.
 * provider: pexels | openai.
 * body.slide_id → one slide; omit on carousel → fill every slide (per-slide briefs from agent_output).
 */
postActionsRouter.post('/:id/fetch-media', async (req: Request, res: Response) => {
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
      quality?: string
      slide_id?: number
      /** Default true — enqueue a fetch_media job (single SQLite writer). */
      async?: boolean
    }

    if (body.async !== false) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { enqueueJob } = require('../../jobs') as typeof import('../../jobs')
      const jobId = enqueueJob({
        kind: 'fetch_media',
        post_id: Number(post_id),
        payload: {
          post_id: Number(post_id),
          actor: body.actor || { id: 'local-dev', name: 'Local operator' },
          as: body.as,
          query: body.query,
          prompt: body.prompt,
          provider: body.provider,
          quality: body.quality,
          slide_id: body.slide_id,
        },
        dedupe_key: `fetch_media:${post_id}`,
      })
      return res.status(202).json({
        job_id: jobId,
        post: getPost(post_id),
        note: 'fetch_media job queued',
      })
    }

    const isAgent = body.as === 'agent'
    const human = humanFromBody(body.actor || { id: 'local-dev', name: 'Local operator' })
    const principal: PolicyActor = isAgent ? { ...AGENT_PIPELINE } : human
    const provider = (body.provider || 'pexels').toLowerCase()
    if (provider !== 'pexels' && provider !== 'openai' && provider !== 'runware') {
      return res.status(400).json({
        error: `provider must be "pexels", "openai", or "runware" (got "${provider}")`,
      })
    }
    if (provider === 'openai' && !openaiImageConfigured()) {
      return res.status(503).json({
        error:
          'OpenAI image gen not configured. Set IMAGE_OPENAI_API_KEY in .env.local (separate from chat OPENAI_*).',
      })
    }
    if (provider === 'runware' && !runwareConfigured()) {
      return res.status(503).json({
        error: 'Runware not configured. Set RUNWARE_API_KEY in .env.local.',
      })
    }

    const formatEarly = normalizeFormat(post.format)
    if (provider === 'runware' && formatEarly !== 'reel') {
      return res.status(400).json({
        error: 'provider "runware" is only for format=reel posts',
      })
    }

    if (provider === 'runware') {
      const promptCandidate = (body.prompt?.trim() || post.reel_prompt || post.image_prompt || post.hook || post.topic || '').trim()
      if (!promptCandidate) {
        return res.status(400).json({
          error: 'reel_prompt (or image_prompt) required before Runware generation',
        })
      }
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
        patch: {
          error: null,
          ...(provider === 'runware' ? {} : { image_url: null }),
        },
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

    // ── Runware reel video (model-native 9:16; H3 Max draft 480×832 / final 768×1344) ─
    if (provider === 'runware') {
      const qualityRaw = (body.quality || 'draft').toLowerCase()
      const quality: ReelVideoQuality = qualityRaw === 'final' ? 'final' : 'draft'
      if (body.prompt?.trim()) {
        updatePostFields(post_id, { reel_prompt: body.prompt.trim() })
        post = getPost(post_id)!
      }
      const prompt = (post.reel_prompt || post.image_prompt || post.hook || post.topic || '').trim()
      if (!prompt) {
        return res.status(400).json({
          error: 'reel_prompt (or image_prompt) required before Runware generation',
        })
      }
      try {
        const generated = await generateReelVideo({
          postId: post_id,
          prompt,
          quality,
          ...reelRenderOpts(post),
        })
        ensureSlidesForFormat(Number(post_id), 'reel', post.hook)
        const updated = transitionPost(post_id, 'media_ready', {
          patch: {
            reel_url: generated.publicUrl,
            reel_quality: generated.quality,
            media_type: 'reel',
            media_provider: 'runware',
            ...(generated.coverUrl ? { image_url: generated.coverUrl } : {}),
            error: null,
          },
        })
        queueVisionQa(post_id)
        return res.json({
          post: updated,
          slides: listSlides(Number(post_id)),
          media: {
            provider: generated.provider,
            model: generated.model,
            url: generated.publicUrl,
            path: generated.relativePath,
            prompt: generated.prompt,
            quality: generated.quality,
            width: generated.width,
            height: generated.height,
            duration: generated.duration,
          },
          note:
            quality === 'final'
              ? `Final ${generated.width}×${generated.height} reel on disk — Approve media to stage, then publish`
              : `Draft ${generated.width}×${generated.height} reel on disk — Generate final before publish`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Runware video failed'
        console.error('[media/runware]', message)
        try {
          const failed = transitionPost(post_id, 'media_ready', {
            patch: { error: message },
          })
          return res.status(502).json({ error: message, post: failed })
        } catch {
          try {
            updatePostFields(post_id, { error: message })
          } catch {
            /* ignore */
          }
          return res.status(502).json({ error: message })
        }
      }
    }

    let slides = ensureSlidesForFormat(Number(post_id), format, post.hook)
    const slidePlan = slidePlanFromPost({ id: Number(post_id), agent_output: post.agent_output })
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
    const usedStockIds = new Set<string>()
    let fillError: string | null = null

    for (const target of targets) {
      try {
        const brief = slidePlan[target.position]
        let asset: Omit<FilledAsset, 'slide_id'>

        if (provider === 'openai') {
          const base =
            (targets.length === 1 && body.prompt) ||
            brief?.image_prompt ||
            post.image_prompt ||
            ''
          const prompt = imagePromptFromPost({
            ...post,
            image_prompt: String(base).trim() || post.image_prompt,
            background_style: brandCtx.backgroundStyle,
            brandVisual: brandCtx.visualBrief,
            imagePromptExtra: brandCtx.overrides.image_prompt_extra,
          }).trim()
          const generated = await generateOpenAiImageForPost(post_id, prompt, { format })
          asset = {
            provider: generated.provider,
            publicUrl: generated.publicUrl,
            relativePath: generated.relativePath,
            model: generated.model,
            prompt: generated.prompt,
          }
        } else {
          const baseQuery =
            (targets.length === 1 && body.query) ||
            brief?.stock_search_query ||
            post.stock_search_query ||
            ''
          const query = mediaQueryFromPost({
            ...post,
            stock_search_query: String(baseQuery).trim() || post.stock_search_query,
            background_style: brandCtx.backgroundStyle,
          }).trim()
          const stock = await downloadStockForPost(post_id, query, {
            excludeId: [...usedStockIds],
          })
          if (stock.hit?.id) usedStockIds.add(String(stock.hit.id))
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
      } catch (slideErr) {
        fillError =
          slideErr instanceof Error ? slideErr.message : 'Slide media fetch failed'
        console.error('[media] slide', target.position, fillError)
        break
      }
    }

    const cover = filled[0]
    const updated = transitionPost(post_id, 'media_ready', {
      patch: {
        image_url: cover?.publicUrl || null,
        source_image_url: cover?.publicUrl || null,
        media_type:
          format === 'carousel' ? 'carousel' : format === 'reel' ? 'reel' : 'image',
        media_provider: cover?.provider || provider,
        error: fillError,
      },
    })
    queueVisionQa(post_id)

    if (!cover) {
      return res.status(502).json({
        error: fillError || 'Media fetch failed',
        post: updated,
        slides: listSlides(Number(post_id)),
      })
    }

    res.json({
      post: updated,
      slides: listSlides(Number(post_id)),
      media: {
        provider: cover.provider,
        model: cover.model,
        url: cover.publicUrl,
        path: cover.relativePath,
        prompt: cover.prompt,
        query: cover.query,
        photographer: cover.photographer,
        slide_id: cover.slide_id,
        slides_filled: filled.length,
      },
      note: fillError
        ? `Filled ${filled.length}/${targets.length} slides then failed: ${fillError}. Open Compose to retry remaining slides.`
        : format === 'carousel' && filled.length > 1
          ? `Filled ${filled.length} carousel slides — switch slides in canvas, then Approve media`
          : provider === 'openai'
            ? 'AI image on disk — compose in canvas, then Approve media to stage'
            : 'Stock image on disk — compose in canvas, then Approve media to stage',
    })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Media fetch failed'
    console.error('[media]', message)
    try {
      const partial = listSlides(Number(post_id)).some((s) => !!s.source_image_url)
      if (partial) {
        const recovered = transitionPost(post_id, 'media_ready', {
          patch: { error: message },
        })
        return res.status(502).json({
          error: message,
          post: recovered,
          slides: listSlides(Number(post_id)),
        })
      }
    } catch {
      /* ignore recovery errors */
    }
    res.status(502).json({ error: message })
  }
})
