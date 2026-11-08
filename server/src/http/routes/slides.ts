import { Router, type IRouter, type Request, type Response } from 'express'
import type { PromptVars } from '@instagram-agent/shared'
import { ApiError, getPost, updatePostFields } from '../../orchestrator'
import { getBrandProfile, resolveBrandContext } from '../../brand'
import {
  addSlide,
  ensureSlidesForFormat,
  listSlides,
  removeSlide,
  updateSlide,
} from '../../slides'
import {
  applyPlatePromptsFromVars,
} from '../../media/autogen'
import {
  compilePromptPreview,
  emptyCanvasDoc,
  extractBrandHandle,
  brandMarkFromIdentity,
  identityFromBrand,
  parsePromptVars,
  seedPromptVars,
} from '../../prompts/format-templates'
import { sendApiError, normalizeFormat } from '../helpers'

export const slidesRouter: IRouter = Router()

/** Slides list / add */
slidesRouter.get('/:id/slides', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  res.json({ slides: listSlides(post.id) })
})

slidesRouter.post('/:id/slides', (req: Request, res: Response) => {
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

slidesRouter.delete('/:id/slides/:slideId', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const slides = removeSlide(post.id, Number(req.params.slideId))
    res.json({ slides })
  } catch (e) {
    sendApiError(res, e)
  }
})

slidesRouter.patch('/:id/slides/:slideId', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const existing = listSlides(post.id).find((s) => s.id === Number(req.params.slideId))
    if (!existing) return res.status(404).json({ error: 'slide not on this post' })
    const body = (req.body || {}) as {
      canvas_json?: string
      source_image_url?: string
      text?: string
      image_prompt?: string
      stock_search_query?: string
    }
    const slide = updateSlide(existing.id, {
      canvas_json: body.canvas_json,
      source_image_url: body.source_image_url,
      text: body.text,
      image_prompt: body.image_prompt,
      stock_search_query: body.stock_search_query,
    })
    res.json({ slide })
  } catch (e) {
    sendApiError(res, e)
  }
})

/** Prompt review gate — assembled plates + editable vars. */
slidesRouter.get('/:id/prompt-preview', (req: Request, res: Response) => {
  try {
    let post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const brand = post.brand_profile_id ? getBrandProfile(post.brand_profile_id) : null
    const identity = identityFromBrand(brand)
    let vars = parsePromptVars(post.prompt_vars)
    if (!vars) {
      vars = seedPromptVars(post, identity)
      updatePostFields(post.id, { prompt_vars: JSON.stringify(vars) })
    }
    const needsPrompt =
      (vars.format === 'reel' && !post.reel_prompt?.trim()) ||
      (vars.format !== 'reel' && !post.image_prompt?.trim())
    const brandCtx = resolveBrandContext(post)
    const compileCtx = {
      angle: post.angle,
      visualBrief: brandCtx.visualBrief,
      brandHandle: extractBrandHandle(brandCtx.visualBrief),
      brandMark: brandMarkFromIdentity(brandCtx.visualIdentity),
    }
    if (needsPrompt) {
      applyPlatePromptsFromVars(post.id, vars, identity, compileCtx)
      post = getPost(post.id)!
    }
    const preview = compilePromptPreview(vars, identity, compileCtx)
    res.json({
      post_id: post.id,
      status: post.status,
      ...preview,
      image_prompt: post.image_prompt,
      reel_prompt: post.reel_prompt,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'prompt-preview failed'
    res.status(400).json({ error: message })
  }
})

slidesRouter.patch('/:id/prompt-preview', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    const body = (req.body || {}) as { vars?: PromptVars; reset?: boolean }
    const brand = post.brand_profile_id ? getBrandProfile(post.brand_profile_id) : null
    const identity = identityFromBrand(brand)

    let vars: PromptVars
    if (body.reset === true) {
      vars = seedPromptVars(post, identity)
    } else if (body.vars && typeof body.vars === 'object') {
      vars = body.vars
    } else {
      return res.status(400).json({ error: 'vars object required (or reset: true)' })
    }

    updatePostFields(post.id, {
      prompt_vars: JSON.stringify(vars),
      canvas_json: JSON.stringify(emptyCanvasDoc(vars.format)),
    })
    const brandCtx = resolveBrandContext(post)
    const compileCtx = {
      angle: post.angle,
      visualBrief: brandCtx.visualBrief,
      brandHandle: extractBrandHandle(brandCtx.visualBrief),
      brandMark: brandMarkFromIdentity(brandCtx.visualIdentity),
    }
    applyPlatePromptsFromVars(post.id, vars, identity, compileCtx)

    if (vars.format === 'carousel') {
      for (const s of listSlides(post.id)) {
        const slideVars = vars.slides[s.position]
        if (!slideVars) continue
        updateSlide(s.id, {
          text: slideVars.on_image_text || s.text,
          canvas_json: JSON.stringify(emptyCanvasDoc('carousel')),
        })
      }
    }

    const preview = compilePromptPreview(vars, identity, compileCtx)
    res.json({
      post_id: post.id,
      status: getPost(post.id)?.status,
      ...preview,
    })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'prompt-preview patch failed'
    res.status(400).json({ error: message })
  }
})
