import { Router, type IRouter, type Request, type Response } from 'express'
import type { Actor } from '@instagram-agent/shared'
import { ApiError, getPost, transitionPost, updatePostFields } from '../../orchestrator'
import { assertAllowed, humanFromBody, type PolicyActor } from '../../policy'
import { assertPublishApprovals } from '../../services/approvals'
import { generateReelVideo, runwareConfigured } from '../../media/runware'
import { uploadStagedVideo, readLocalAssetBytes } from '../../media/r2'
import { ensureSlidesForFormat, listSlides, updateSlide } from '../../slides'
import {
  fetchMediaComments,
  fetchMediaInsights,
  publishPostToInstagram,
  recordPublishForAnalytics,
  resolvePublishConn,
  tokenForConn,
  updateLearnEngagement,
} from '../../instagram-publish'
import { sendApiError, normalizeFormat, reelRenderOpts } from '../helpers'

export const instagramPostsRouter: IRouter = Router()

/** @deprecated Lesson 13 — use fetch-media. Kept as alias that starts generating only. */
instagramPostsRouter.post('/:id/publish', (req: Request, res: Response) => {
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
instagramPostsRouter.post('/:id/media-ready', (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Gone — use POST /api/posts/:id/fetch-media for a real asset on disk',
  })
})

/**
 * Lesson 15 — gated publish from staged URLs (local /assets via tunnel, or R2).
 */
instagramPostsRouter.post('/:id/publish-instagram', async (req: Request, res: Response) => {
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

    // Phase 2 HITL: same gate as the job-queue publish path.
    assertPublishApprovals(post_id)

    if (post.status !== 'staged' && !(normalizeFormat(post.format) === 'reel' && post.status === 'media_ready' && post.reel_url)) {
      return res.status(409).json({
        error: `publish-instagram requires status "staged" (approve media first), got "${post.status}"`,
      })
    }

    if (normalizeFormat(post.format) === 'reel') {
      if (!runwareConfigured()) {
        return res.status(503).json({ error: 'RUNWARE_API_KEY required to finalize reel for publish' })
      }
      if (post.reel_quality !== 'final') {
        const prompt = (post.reel_prompt || post.image_prompt || post.hook || '').trim()
        if (!prompt) {
          return res.status(400).json({ error: 'reel_prompt required to generate final reel' })
        }
        try {
          const generated = await generateReelVideo({
            postId: post_id,
            prompt,
            quality: 'final',
            ...reelRenderOpts(post),
          })
          post = updatePostFields(post_id, {
            reel_url: generated.publicUrl,
            reel_quality: 'final',
            media_type: 'reel',
            media_provider: 'runware',
            ...(generated.coverUrl ? { image_url: generated.coverUrl } : {}),
            error: null,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Final reel generation failed'
          return res.status(502).json({ error: message, post })
        }
      }
      if (!post.reel_url?.includes('/staged/')) {
        let bytes = post.reel_url ? readLocalAssetBytes(post.reel_url) : null
        if (!bytes && post.reel_url) {
          const resVid = await fetch(post.reel_url)
          if (!resVid.ok) {
            return res.status(502).json({ error: `Cannot read final reel for staging (HTTP ${resVid.status})` })
          }
          bytes = Buffer.from(await resVid.arrayBuffer())
        }
        if (!bytes) {
          return res.status(400).json({ error: 'reel_url missing bytes for staging' })
        }
        const uploaded = await uploadStagedVideo({ postId: post_id, bytes })
        const slides = ensureSlidesForFormat(Number(post_id), 'reel', post.hook)
        if (slides[0]) updateSlide(slides[0].id, { staged_url: uploaded.publicUrl })
        if (post.status === 'staged') {
          post = updatePostFields(post_id, {
            reel_url: uploaded.publicUrl,
            media_type: 'reel',
            error: null,
          })
        } else {
          post = transitionPost(post_id, 'staged', {
            patch: {
              reel_url: uploaded.publicUrl,
              media_type: 'reel',
              error: null,
            },
          })
        }
      }
    }

    if (post.status !== 'staged') {
      return res.status(409).json({
        error: `publish-instagram requires status "staged", got "${post.status}"`,
      })
    }

    const conn = resolvePublishConn(post.account_id)
    post = transitionPost(post_id, 'pending_upload')
    post = transitionPost(post_id, 'publishing')

    try {
      const result = await publishPostToInstagram({ conn, post })
      const children =
        result.childrenMediaIds?.length
          ? result.childrenMediaIds
          : result.childIds || []
      const updated = transitionPost(post_id, 'published', {
        patch: {
          instagram_media_id: result.mediaId,
          instagram_creation_id: result.creationId,
          instagram_permalink: result.permalink || null,
          instagram_shortcode: result.shortcode || null,
          instagram_published_at: result.publishedAt || new Date().toISOString(),
          instagram_children_ids: children.length ? JSON.stringify(children) : null,
          account_id: conn.account_id,
          error: null,
        },
      })
      const learnId = recordPublishForAnalytics({
        postId: Number(post_id),
        accountId: conn.account_id,
        hook: post.hook,
        caption: post.caption,
        mediaId: result.mediaId,
        creationId: result.creationId,
        permalink: result.permalink,
        shortcode: result.shortcode,
        childrenIds: children,
      })
      res.json({
        post: updated,
        graph: {
          creation_id: result.creationId,
          media_id: result.mediaId,
          permalink: result.permalink || null,
          shortcode: result.shortcode || null,
          children_ids: children,
          learn_id: learnId,
        },
        note: 'Published to Instagram — media id stored for analytics',
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

/** Stored Instagram ids + permalink for a published post. */
instagramPostsRouter.get('/:id/instagram', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  let children: string[] = []
  try {
    children = post.instagram_children_ids
      ? (JSON.parse(post.instagram_children_ids) as string[])
      : []
  } catch {
    children = []
  }
  res.json({
    post_id: post.id,
    account_id: post.account_id,
    media_id: post.instagram_media_id,
    creation_id: post.instagram_creation_id,
    permalink: post.instagram_permalink,
    shortcode: post.instagram_shortcode,
    published_at: post.instagram_published_at,
    children_ids: children,
    status: post.status,
  })
})

/** Live insights from Graph using stored media id; also snapshots into learn.engagement. */
instagramPostsRouter.get('/:id/instagram/insights', async (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    if (!post.instagram_media_id) {
      return res.status(409).json({ error: 'No instagram_media_id — publish first' })
    }
    const conn = resolvePublishConn(post.account_id)
    const token = tokenForConn(conn)
    const insights = await fetchMediaInsights(
      post.instagram_media_id,
      token,
      post.media_type
    )
    updateLearnEngagement(post.id, insights.metrics)
    res.json({
      post_id: post.id,
      media_id: post.instagram_media_id,
      metrics: insights.metrics,
      raw: insights.raw,
      note: insights.note,
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

/** Live comments from Graph using stored media id. */
instagramPostsRouter.get('/:id/instagram/comments', async (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    if (!post.instagram_media_id) {
      return res.status(409).json({ error: 'No instagram_media_id — publish first' })
    }
    const conn = resolvePublishConn(post.account_id)
    const token = tokenForConn(conn)
    const comments = await fetchMediaComments(post.instagram_media_id, token)
    res.json({
      post_id: post.id,
      media_id: post.instagram_media_id,
      comments,
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

instagramPostsRouter.post('/:id/pending-upload', (req: Request, res: Response) => {
  try {
    const existing = getPost(req.params.id)
    if (!existing) return res.status(404).json({ error: 'post not found' })
    const actor = humanFromBody(
      ((req.body || {}) as { actor?: Actor }).actor || {
        id: 'local-dev',
        name: 'Local operator',
      },
    )
    assertAllowed(actor, 'instagram.publish', { type: 'post', post: existing })
    assertPublishApprovals(req.params.id)
    const post = transitionPost(req.params.id, 'pending_upload', { actor })
    res.json({ post })
  } catch (e) {
    sendApiError(res, e)
  }
})

instagramPostsRouter.post('/:id/publishing', (req: Request, res: Response) => {
  try {
    const existing = getPost(req.params.id)
    if (!existing) return res.status(404).json({ error: 'post not found' })
    const actor = humanFromBody(
      ((req.body || {}) as { actor?: Actor }).actor || {
        id: 'local-dev',
        name: 'Local operator',
      },
    )
    assertAllowed(actor, 'instagram.publish', { type: 'post', post: existing })
    assertPublishApprovals(req.params.id)
    const post = transitionPost(req.params.id, 'publishing', { actor })
    res.json({ post })
  } catch (e) {
    sendApiError(res, e)
  }
})

instagramPostsRouter.post('/:id/published', (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Gone — use POST /api/posts/:id/publish-instagram (Lesson 15 gated publish)',
  })
})

/**
 * Lesson 06 checkpoint surface: simulate "model said publish now".
 * Agent role is always denied; deny is stored as a policy run event.
 */
instagramPostsRouter.post('/:id/instagram-publish', (req: Request, res: Response) => {
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

    res.json({
      ok: true,
      note: 'Policy allowed instagram.publish (Graph stub — lesson 15)',
      post_id: post.id,
    })
  } catch (e) {
    sendApiError(res, e)
  }
})
