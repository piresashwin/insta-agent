import { Router, type IRouter, type Request, type Response } from 'express'
import type { Actor } from '@instagram-agent/shared'
import { ApiError, getPost, transitionPost, updatePostFields } from '../../orchestrator'
import { assertAllowed, humanFromBody } from '../../policy'
import { getBrandProfile, resolveBrandContext } from '../../brand'
import {
  generateOpenAiImageForPost,
  imagePromptFromPost,
  openaiImageConfigured,
} from '../../media/openai-image'
import { generateReelVideo, runwareConfigured, type ReelVideoQuality } from '../../media/runware'
import { uploadStagedPng, uploadStagedVideo, readLocalAssetBytes } from '../../media/r2'
import { queueVisionQa } from '../../media/vision-qa'
import { clearStagedUrls, ensureSlidesForFormat, listSlides, updateSlide } from '../../slides'
import {
  extractBrandHandle,
  brandMarkFromIdentity,
  identityFromBrand,
  parsePromptVars,
  seedPromptVars,
} from '../../prompts/format-templates'
import { applyPlatePromptsFromVars } from '../../media/autogen'
import { sendApiError, normalizeFormat, reelRenderOpts } from '../helpers'
import { computeArtifactHash, recordApproval } from '../../services/approvals'
import { historyActorFrom } from '../../services/attribution'
import { enqueueGenerateMedia } from '../../services/generate-media'

export const mediaRouter: IRouter = Router()

/**
 * One-click Generate media: generative provider → stage as-is (model-baked text).
 * Body: { actor?, provider?, quality?, bake_only?: boolean }
 * bake_only: skip fetch; stage existing source/reel URLs without overlay bake.
 */
mediaRouter.post('/:id/generate-media', async (req: Request, res: Response) => {
  const post_id = req.params.id
  try {
    let post = getPost(post_id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const body = (req.body || {}) as {
      actor?: Actor
      provider?: string
      quality?: string
      bake_only?: boolean
      /** When true (default), enqueue a generate_media job instead of running inline. */
      async?: boolean
    }
    const actor = humanFromBody(body.actor || { id: 'local-dev', name: 'Local operator' })

    // Phase 2: default path goes through the job runner (single SQLite writer).
    if (body.async !== false) {
      const jobId = enqueueGenerateMedia({
        postId: post_id,
        actor: { id: actor.id, name: actor.name },
        provider: body.provider,
        quality: body.quality,
        bake_only: body.bake_only === true,
      })
      return res.status(202).json({
        job_id: jobId,
        post: getPost(post_id),
        note: 'generate_media job queued',
      })
    }

    const brand = post.brand_profile_id ? getBrandProfile(post.brand_profile_id) : null
    const identity = identityFromBrand(brand)
    let vars = parsePromptVars(post.prompt_vars)
    if (!vars) {
      vars = seedPromptVars(post, identity)
      updatePostFields(post_id, { prompt_vars: JSON.stringify(vars) })
      post = getPost(post_id)!
    }
    const needsCompile =
      (vars.format === 'reel' && !post.reel_prompt?.trim()) ||
      (vars.format !== 'reel' && !post.image_prompt?.trim())
    if (needsCompile) {
      const brandCtx = resolveBrandContext(post)
      applyPlatePromptsFromVars(post_id, vars, identity, {
        angle: post.angle,
        visualBrief: brandCtx.visualBrief,
        brandHandle: extractBrandHandle(brandCtx.visualBrief),
        brandMark: brandMarkFromIdentity(brandCtx.visualIdentity),
      })
      post = getPost(post_id)!
    }

    const format = normalizeFormat(post.format || vars.format)
    const bakeOnly = body.bake_only === true

    if (!bakeOnly) {
      if (post.status === 'approved') {
        assertAllowed(actor, 'post.start_publish', { type: 'post', post })
        post = transitionPost(post_id, 'media_generating')
      } else if (post.status === 'media_ready' || post.status === 'staged') {
        clearStagedUrls(Number(post_id))
        post = transitionPost(post_id, 'media_generating', {
          patch: { error: null },
        })
      } else if (post.status !== 'media_generating') {
        return res.status(409).json({
          error: `generate-media needs approved, media_ready, staged, or media_generating (got "${post.status}")`,
        })
      }

      assertAllowed(actor, 'media.search', { type: 'post', post })

      let provider = (body.provider || '').toLowerCase()
      if (!provider) {
        provider = format === 'reel' ? 'runware' : 'openai'
      }
      if (provider === 'pexels') {
        return res.status(400).json({
          error:
            'Pexels cannot bake on-image typography. Use OpenAI (stills) or Runware (reels).',
        })
      }

      post = getPost(post_id)!

      if (provider === 'runware' && format === 'reel') {
        if (!runwareConfigured()) {
          return res.status(503).json({ error: 'Runware not configured' })
        }
        const qualityRaw = (body.quality || 'draft').toLowerCase()
        const quality: ReelVideoQuality = qualityRaw === 'final' ? 'final' : 'draft'
        const prompt = (post.reel_prompt || post.image_prompt || post.hook || post.topic || '').trim()
        if (!prompt) return res.status(400).json({ error: 'reel_prompt required' })
        const generated = await generateReelVideo({
          postId: post_id,
          prompt,
          quality,
          ...reelRenderOpts(post),
        })
        ensureSlidesForFormat(Number(post_id), 'reel', post.hook)
        transitionPost(post_id, 'media_ready', {
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
      } else if (provider === 'openai' || format !== 'reel') {
        if (!openaiImageConfigured()) {
          return res.status(503).json({ error: 'OpenAI image not configured' })
        }
        const brandCtx = resolveBrandContext(getPost(post_id)!)
        const slides = ensureSlidesForFormat(Number(post_id), format, post.hook)
        const targets = format === 'carousel' ? slides : slides[0] ? [slides[0]] : []
        for (const slide of targets) {
          const basePrompt = (slide.image_prompt || post.image_prompt || '').trim()
          if (!basePrompt) {
            return res.status(400).json({
              error: `Missing generation prompt for slide ${slide.position}`,
            })
          }
          const prompt = imagePromptFromPost({
            ...getPost(post_id)!,
            image_prompt: basePrompt,
            background_style: brandCtx.backgroundStyle,
            brandVisual: brandCtx.visualBrief,
            imagePromptExtra: brandCtx.overrides.image_prompt_extra,
          }).trim()
          const generated = await generateOpenAiImageForPost(post_id, prompt, { format })
          updateSlide(slide.id, {
            source_image_url: generated.publicUrl,
            image_prompt: basePrompt,
          })
          if (slide.position === 0) {
            updatePostFields(post_id, {
              source_image_url: generated.publicUrl,
              image_url: generated.publicUrl,
              media_provider: 'openai',
              media_type: format === 'carousel' ? 'carousel' : 'image',
            })
          }
        }
        transitionPost(post_id, 'media_ready', { patch: { error: null } })
        queueVisionQa(post_id)
      } else {
        return res.status(400).json({
          error: `Unsupported provider "${provider}" for format "${format}"`,
        })
      }
    } else if (post.status !== 'media_ready' && post.status !== 'staged') {
      return res.status(409).json({
        error: 'bake_only requires media_ready or staged',
      })
    }

    // Phase 2 HITL: leave at media_ready; approve-media stages.
    const freshPost = getPost(post_id)!
    res.json({
      post: freshPost,
      slides: listSlides(Number(post_id)),
      note:
        freshPost.status === 'media_ready'
          ? 'Media generated — approve-media to stage for publish'
          : `Generate finished (status=${freshPost.status})`,
    })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'generate-media failed'
    console.error('[generate-media]', message)
    try {
      const stuck = getPost(post_id)
      if (stuck?.status === 'media_generating') {
        transitionPost(post_id, 'media_ready', { patch: { error: message } })
      } else {
        updatePostFields(post_id, { error: message })
      }
    } catch {
      /* ignore recovery errors */
    }
    res.status(502).json({ error: message, post: getPost(post_id) })
  }
})

/**
 * Approve media — client-baked PNG slides → R2 → status staged.
 * Reels: stage reel_url MP4 (optional slides PNGs ignored when stage_reel / reel_url present).
 * Body: { actor, canvas_json?, slides?: [...], stage_reel?: boolean }
 */
mediaRouter.post('/:id/approve-media', async (req: Request, res: Response) => {
  const post_id = req.params.id
  try {
    const post = getPost(post_id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as {
      actor?: Actor
      as?: 'agent' | 'human'
      canvas_json?: string
      stage_reel?: boolean
      slides?: Array<{ position: number; png_base64: string; canvas_json?: string }>
    }
    if (body.as === 'agent') {
      return res.status(403).json({ error: 'Agent cannot media.approve' })
    }
    const actor = humanFromBody(body.actor || { id: 'local-dev', name: 'Local operator' })
    assertAllowed(actor, 'media.approve', { type: 'post', post })

    const format = normalizeFormat(post.format)

    // ── Reel: stage MP4 without PNG bake ────────────────────────────────
    if (format === 'reel' && (body.stage_reel || post.reel_url)) {
      if (!post.reel_url) {
        return res.status(400).json({
          error: 'reel_url missing — Generate draft/final video first',
        })
      }
      let bytes = readLocalAssetBytes(post.reel_url)
      if (!bytes) {
        try {
          const resVid = await fetch(post.reel_url)
          if (!resVid.ok) throw new Error(`HTTP ${resVid.status}`)
          bytes = Buffer.from(await resVid.arrayBuffer())
        } catch (err) {
          return res.status(400).json({
            error: `Cannot read reel file for staging: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }
      const uploaded = await uploadStagedVideo({ postId: post_id, bytes })
      if (body.canvas_json) {
        updatePostFields(post_id, { canvas_json: body.canvas_json })
      }
      const slides = ensureSlidesForFormat(Number(post_id), 'reel', post.hook)
      if (slides[0]) {
        updateSlide(slides[0].id, { staged_url: uploaded.publicUrl })
      }
      recordApproval({
        postId: post_id,
        stage: 'media',
        actor: historyActorFrom({ id: actor.id, name: actor.name }),
        artifactHash: computeArtifactHash(post_id, {
          reel_url: uploaded.publicUrl,
          staged_urls: [uploaded.publicUrl],
        }),
      })
      const updated = transitionPost(post_id, 'staged', {
        actor: { id: actor.id, name: actor.name },
        patch: {
          reel_url: uploaded.publicUrl,
          media_type: 'reel',
          error: null,
        },
      })
      return res.json({
        post: updated,
        slides: listSlides(Number(post_id)),
        note:
          uploaded.storage === 'local'
            ? 'Reel staged on localhost /assets. PUBLIC_API_BASE tunnel is used only at Instagram publish.'
            : 'Reel staged to R2 — ready to publish',
      })
    }

    const dbSlides = ensureSlidesForFormat(Number(post_id), format, post.hook)
    const payloads = body.slides || []

    // Stage from already-generated media (PostScreen HITL — no client PNG bake).
    if (payloads.length === 0) {
      const sources = dbSlides.map((s, i) => {
        const url =
          s.source_image_url ||
          s.staged_url ||
          (i === 0 ? post.image_url || post.source_image_url : null)
        return { slide: s, url }
      })
      if (sources.some((s) => !s.url)) {
        return res.status(400).json({
          error:
            'slides[] with png_base64 required (or generate media first so source images exist)',
        })
      }
      if (format === 'carousel' && sources.length < 2) {
        return res.status(400).json({ error: 'carousel approve-media needs ≥2 slides' })
      }

      let firstUrl: string | null = null
      let usedLocal = false
      for (const { slide, url } of sources) {
        let bytes = readLocalAssetBytes(url!)
        if (!bytes) {
          try {
            const resImg = await fetch(url!)
            if (!resImg.ok) throw new Error(`HTTP ${resImg.status}`)
            bytes = Buffer.from(await resImg.arrayBuffer())
          } catch (err) {
            return res.status(400).json({
              error: `Cannot read media for staging: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }
        const uploaded = await uploadStagedPng({
          postId: post_id,
          position: slide.position,
          bytes,
        })
        if (uploaded.storage === 'local') usedLocal = true
        updateSlide(slide.id, { staged_url: uploaded.publicUrl })
        if (slide.position === 0 || firstUrl == null) firstUrl = uploaded.publicUrl
      }

      recordApproval({
        postId: post_id,
        stage: 'media',
        actor: historyActorFrom({ id: actor.id, name: actor.name }),
        artifactHash: computeArtifactHash(post_id, { image_url: firstUrl }),
      })
      const updated = transitionPost(post_id, 'staged', {
        actor: { id: actor.id, name: actor.name },
        patch: {
          image_url: firstUrl,
          error: null,
          media_type: format === 'carousel' ? 'carousel' : 'image',
        },
      })
      return res.json({
        post: updated,
        slides: listSlides(Number(post_id)),
        note: usedLocal
          ? 'Media staged on localhost /assets. PUBLIC_API_BASE tunnel is used only at Instagram publish.'
          : 'Media approved and uploaded to R2 — ready to publish',
      })
    }
    if (format === 'carousel' && payloads.length < 2) {
      return res.status(400).json({ error: 'carousel approve-media needs ≥2 slide PNGs' })
    }
    if (payloads.length < dbSlides.length) {
      return res.status(400).json({
        error: `approve-media needs a PNG for every slide (${payloads.length}/${dbSlides.length} provided)`,
      })
    }
    const positions = new Set(payloads.map((p) => p.position))
    for (const s of dbSlides) {
      if (!positions.has(s.position)) {
        return res.status(400).json({
          error: `Missing PNG for slide position ${s.position}`,
        })
      }
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

    recordApproval({
      postId: post_id,
      stage: 'media',
      actor: historyActorFrom({ id: actor.id, name: actor.name }),
      artifactHash: computeArtifactHash(post_id, { image_url: firstUrl }),
    })
    const updated = transitionPost(post_id, 'staged', {
      actor: { id: actor.id, name: actor.name },
      patch: {
        image_url: firstUrl,
        error: null,
        media_type:
          format === 'carousel' ? 'carousel' : format === 'reel' ? 'reel' : 'image',
      },
    })

    res.json({
      post: updated,
      slides: listSlides(Number(post_id)),
      note: usedLocal
        ? 'Media staged on localhost /assets. PUBLIC_API_BASE tunnel is used only at Instagram publish.'
        : 'Media approved and uploaded to R2 — ready to publish',
    })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Approve media failed'
    console.error('[approve-media]', message)
    res.status(502).json({ error: message })
  }
})
