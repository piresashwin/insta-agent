/**
 * Phase 2 — generate_media job body (shared with the HTTP route).
 */
import type { Actor } from '@instagram-agent/shared'
import { ApiError, getPost, transitionPost, updatePostFields } from '../orchestrator'
import { assertAllowed, humanFromBody } from '../policy'
import { getBrandProfile, resolveBrandContext } from '../brand'
import {
  generateOpenAiImageForPost,
  imagePromptFromPost,
  openaiImageConfigured,
} from '../media/openai-image'
import { generateReelVideo, runwareConfigured, type ReelVideoQuality } from '../media/runware'
import { clearStagedUrls, ensureSlidesForFormat, listSlides, updateSlide } from '../slides'
import { applyPlatePromptsFromVars } from '../media/autogen'
import {
  extractBrandHandle,
  brandMarkFromIdentity,
  identityFromBrand,
  parsePromptVars,
  seedPromptVars,
} from '../prompts/format-templates'
import { normalizeFormat, reelRenderOpts } from '../http/helpers'
import { assertRerollAllowed } from './budget'

export type GenerateMediaOpts = {
  postId: string | number
  actor?: { id?: string; name?: string }
  provider?: string
  quality?: string
  bake_only?: boolean
  tier?: 'full' | 'downgraded' | 'floor'
}

/** Enqueue a generate_media job (HTTP / MCP entry). */
export function enqueueGenerateMedia(opts: GenerateMediaOpts): number {
  // Dynamic import avoids circular dependency with jobs.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { enqueueJob } = require('../jobs') as typeof import('../jobs')
  return enqueueJob({
    kind: 'generate_media',
    post_id: Number(opts.postId),
    payload: {
      post_id: Number(opts.postId),
      provider: opts.provider,
      quality: opts.quality,
      bake_only: opts.bake_only === true,
      budget_tier: opts.tier ?? 'full',
      actor: opts.actor || { id: 'local-dev', name: 'Local operator' },
    },
    dedupe_key: `generate_media:${opts.postId}`,
  })
}

function fireVisionQa(postId: string | number): void {
  // Lazy require — avoid circular graph with orchestrator during typecheck.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../media/vision-qa') as { queueVisionQa?: (id: string | number) => void }
  mod.queueVisionQa?.(postId)
}

/** Execute generate-media (job worker or inline fallback). */
export async function executeGenerateMediaJob(opts: GenerateMediaOpts): Promise<{
  post: ReturnType<typeof getPost>
  slides: ReturnType<typeof listSlides>
  note: string
}> {
  const post_id = opts.postId
  let post = getPost(post_id)
  if (!post) throw new ApiError(404, 'post not found')
  const actor = humanFromBody(
    (opts.actor || { id: 'local-dev', name: 'Local operator' }) as Actor,
  )

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
  const bakeOnly = opts.bake_only === true
  const tier = opts.tier ?? 'full'

  if (!bakeOnly) {
    assertRerollAllowed(post_id, format)
    if (post.status === 'approved') {
      assertAllowed(actor, 'post.start_publish', { type: 'post', post })
      post = transitionPost(post_id, 'media_generating')
    } else if (post.status === 'media_ready' || post.status === 'staged') {
      clearStagedUrls(Number(post_id))
      post = transitionPost(post_id, 'media_generating', { patch: { error: null } })
    } else if (post.status !== 'media_generating') {
      throw new ApiError(
        409,
        `generate-media needs approved, media_ready, staged, or media_generating (got "${post.status}")`,
      )
    }

    assertAllowed(actor, 'media.search', { type: 'post', post })

    let provider = (opts.provider || '').toLowerCase()
    if (!provider) provider = format === 'reel' ? 'runware' : 'openai'
    if (provider === 'pexels') {
      throw new ApiError(
        400,
        'Pexels cannot bake on-image typography. Use OpenAI (stills) or Runware (reels).',
      )
    }

    post = getPost(post_id)!

    if (provider === 'runware' && format === 'reel') {
      if (!runwareConfigured()) throw new ApiError(503, 'Runware not configured')
      const qualityRaw = (opts.quality || 'draft').toLowerCase()
      const quality: ReelVideoQuality = qualityRaw === 'final' ? 'final' : 'draft'
      const prompt = (post.reel_prompt || post.image_prompt || post.hook || post.topic || '').trim()
      if (!prompt) throw new ApiError(400, 'reel_prompt required')
      const renderOpts = reelRenderOpts(post)
      const generated = await generateReelVideo({
        postId: post_id,
        prompt,
        quality,
        ...renderOpts,
        ...(tier !== 'full' ? { duration: 6 } : {}),
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
      fireVisionQa(post_id)
    } else if (provider === 'openai' || format !== 'reel') {
      if (!openaiImageConfigured()) throw new ApiError(503, 'OpenAI image not configured')
      const brandCtx = resolveBrandContext(getPost(post_id)!)
      const slides = ensureSlidesForFormat(Number(post_id), format, post.hook)
      let targets = format === 'carousel' ? slides : slides[0] ? [slides[0]] : []
      if (format === 'carousel' && tier === 'downgraded') targets = targets.slice(0, 2)
      if (format === 'carousel' && tier === 'floor') targets = targets.slice(0, 1)

      let coverUrl: string | null = null
      for (const slide of targets) {
        const basePrompt = (slide.image_prompt || post.image_prompt || '').trim()
        if (!basePrompt) {
          throw new ApiError(400, `Missing generation prompt for slide ${slide.position}`)
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
        if (slide.position === 0) coverUrl = generated.publicUrl
      }
      // Do not updatePostFields while media_generating — assertEditable locks that status.
      // Attach asset URLs on the media_ready transition instead.
      transitionPost(post_id, 'media_ready', {
        patch: {
          ...(coverUrl
            ? {
                source_image_url: coverUrl,
                image_url: coverUrl,
                media_provider: 'openai',
                media_type: format === 'carousel' ? 'carousel' : 'image',
              }
            : {}),
          error: null,
        },
      })
      fireVisionQa(post_id)
    } else {
      throw new ApiError(400, `Unsupported provider "${provider}" for format "${format}"`)
    }
  } else if (post.status !== 'media_ready' && post.status !== 'staged') {
    throw new ApiError(409, 'bake_only requires media_ready or staged')
  }

  // Phase 2 HITL: stop at media_ready — staging requires explicit approve-media.
  const fresh = getPost(post_id)!
  return {
    post: fresh,
    slides: listSlides(Number(post_id)),
    note:
      fresh.status === 'media_ready'
        ? 'Media generated — approve-media to stage for publish'
        : `Media job finished (status=${fresh.status})`,
  }
}
