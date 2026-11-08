/**
 * Generate media helpers: compile prompts onto post/slides, stage provider assets as-is.
 * Overlay bake is no longer on the happy path — model paints text; scene render is the fallback.
 */
import type { Post, PostFormat, PromptVars, VisualIdentity } from '@instagram-agent/shared'
import {
  canvasDocFromPromptVars,
  compilePromptPreview,
  emptyCanvasDoc,
  extractBrandHandle,
  brandMarkFromIdentity,
  identityFromBrand,
  parsePromptVars,
  seedPromptVars,
  type CompileContext,
} from '../prompts/format-templates'
import { getBrandProfile } from '../brand'
import { listSlides, updateSlide, ensureSlidesForFormat } from '../slides'
import { uploadStagedPng, uploadStagedVideo } from './r2'
import { upgradeCanvasDoc, newLayerId, SCENE_SIZES, type SceneDoc } from '@instagram-agent/shared'
import { renderScenePage } from '../render/scene-render'
import { compositeReelFromScene } from '../render/reel-composite'
import { assetsRoot } from './stock'
import { normalizeImageUrlToInstagramSize, exportSizeForFormat } from './instagram-size'
import { updatePostFields, transitionPost, getPost } from '../orchestrator'
import path from 'path'
import fs from 'fs'

/** Write compiled generation prompts onto post / slide prompt fields (SoT for media). */
export function applyPlatePromptsFromVars(
  postId: number | string,
  vars: PromptVars,
  identity: VisualIdentity = {},
  ctx: CompileContext & { visualBrief?: string | null } = {}
) {
  const compileCtx: CompileContext = {
    angle: ctx.angle,
    brandHandle: ctx.brandHandle ?? extractBrandHandle(ctx.visualBrief),
    brandMark: ctx.brandMark ?? brandMarkFromIdentity(identity),
  }
  const preview = compilePromptPreview(vars, identity, compileCtx)
  const format = (vars.format || 'feed') as PostFormat
  const empty = emptyCanvasDoc(format)

  if (vars.format === 'feed') {
    updatePostFields(postId, {
      image_prompt: preview.compiled[0] || '',
      canvas_json: JSON.stringify(empty),
    })
    return
  }

  if (vars.format === 'reel') {
    updatePostFields(postId, {
      reel_prompt: preview.compiled[0] || '',
      canvas_json: JSON.stringify(empty),
    })
    return
  }

  // carousel — write per-slide image_prompt from compiled plates
  const slides = listSlides(Number(postId))
  for (const slide of slides) {
    const prompt = preview.compiled[slide.position]
    if (!prompt) continue
    const s = vars.slides[slide.position]
    updateSlide(slide.id, {
      image_prompt: prompt,
      text: s?.on_image_text || slide.text,
      canvas_json: JSON.stringify(empty),
    })
    if (slide.position === 0) {
      updatePostFields(postId, {
        image_prompt: prompt,
        canvas_json: JSON.stringify(empty),
      })
    }
  }
}

/**
 * Stage provider assets without overlay bake (model-baked text already in pixels).
 */
export async function stagePassThroughPost(postId: number | string): Promise<{
  post: Post
  note: string
}> {
  let post = getPost(postId)
  if (!post) throw new Error('post not found')

  const format = (post.format || 'feed') as PostFormat
  const empty = emptyCanvasDoc(format)

  if (format === 'reel') {
    if (!post.reel_url) throw new Error('Generate reel video first')
    const slides = ensureSlidesForFormat(Number(postId), 'reel', post.hook)
    if (slides[0]) {
      updateSlide(slides[0].id, {
        staged_url: post.reel_url,
        canvas_json: JSON.stringify(empty),
      })
    }
    const updated = transitionPost(postId, 'staged', {
      patch: {
        reel_url: post.reel_url,
        media_type: 'reel',
        canvas_json: JSON.stringify(empty),
        error: null,
      },
    })
    return { post: updated, note: 'Reel staged as generated (model-baked text, no ASS burn)' }
  }

  const slides = ensureSlidesForFormat(Number(postId), format, post.hook)
  if (!slides.length) throw new Error('No slides to stage')

  const target = exportSizeForFormat(format)
  let firstUrl: string | null = null
  for (const slide of slides) {
    const source =
      slide.source_image_url ||
      (slide.position === 0 ? post.source_image_url || post.image_url : null)
    if (!source) {
      throw new Error(
        `Slide ${slide.position} missing source media — run Generate media first`
      )
    }
    // Normalize to Instagram export pixels even if provider already cropped once
    const png = await normalizeImageUrlToInstagramSize(source, format)
    const uploaded = await uploadStagedPng({
      postId,
      position: slide.position,
      bytes: png,
    })
    updateSlide(slide.id, {
      staged_url: uploaded.publicUrl,
      canvas_json: JSON.stringify(empty),
    })
    if (slide.position === 0 || firstUrl == null) firstUrl = uploaded.publicUrl
  }

  const updated = transitionPost(postId, 'staged', {
    patch: {
      image_url: firstUrl,
      canvas_json: JSON.stringify(empty),
      media_type: format === 'carousel' ? 'carousel' : 'image',
      error: null,
    },
  })

  return {
    post: updated,
    note: `Media staged at ${target.width}×${target.height} (model-baked text, Instagram export size)`,
  }
}

function sceneFromCanvasWithPlate(canvasDoc: ReturnType<typeof canvasDocFromPromptVars>, sourceUrl: string): SceneDoc {
  const scene = upgradeCanvasDoc(canvasDoc)
  const { w, h } = SCENE_SIZES[scene.format]
  scene.pages[0].layers = [
    {
      id: newLayerId(),
      type: 'image',
      name: 'Plate',
      x: 0,
      y: 0,
      w,
      h,
      url: sourceUrl,
      fit: 'cover',
    },
    ...scene.pages[0].layers,
  ]
  return scene
}

/**
 * Scene-based bake path. Prefer generate-media → stagePassThroughPost when the model
 * already paints text; use this when overlays must be composited.
 */
export async function bakeAndStagePost(postId: number | string): Promise<{
  post: Post
  note: string
}> {
  let post = getPost(postId)
  if (!post) throw new Error('post not found')

  const brand = post.brand_profile_id ? getBrandProfile(post.brand_profile_id) : null
  const identity = identityFromBrand(brand)
  let vars = parsePromptVars(post.prompt_vars)
  if (!vars) {
    vars = seedPromptVars(post, identity)
    updatePostFields(postId, { prompt_vars: JSON.stringify(vars) })
    post = getPost(postId)!
  }

  const format = (post.format || vars.format || 'feed') as PostFormat

  if (format === 'reel') {
    if (!post.reel_url) throw new Error('Generate reel plate video first (fetch-media / Runware)')
    const canvas = canvasDocFromPromptVars(vars)
    const scene = upgradeCanvasDoc(canvas)
    updatePostFields(postId, {
      canvas_json: JSON.stringify(canvas),
      scene_json: JSON.stringify(scene),
    })
    const rel = path.join('posts', String(postId), `reel-baked-${Date.now()}.mp4`)
    const abs = path.join(assetsRoot(), rel)
    await compositeReelFromScene({ reelUrl: post.reel_url, doc: scene, outPath: abs })
    const bytes = fs.readFileSync(abs)
    const uploaded = await uploadStagedVideo({ postId, bytes })
    const slides = ensureSlidesForFormat(Number(postId), 'reel', post.hook)
    if (slides[0])
      updateSlide(slides[0].id, {
        staged_url: uploaded.publicUrl,
        canvas_json: JSON.stringify(canvas),
      })
    const updated = transitionPost(postId, 'staged', {
      patch: {
        reel_url: uploaded.publicUrl,
        media_type: 'reel',
        canvas_json: JSON.stringify(canvas),
        scene_json: JSON.stringify(scene),
        error: null,
      },
    })
    return {
      post: updated,
      note:
        uploaded.storage === 'local'
          ? 'Reel composited + staged under /assets'
          : 'Reel composited + staged to R2',
    }
  }

  const slides = ensureSlidesForFormat(Number(postId), format, post.hook)
  if (!slides.length) throw new Error('No slides to bake')

  let firstUrl: string | null = null
  let usedLocal = false
  let coverScene: SceneDoc | null = null

  for (const slide of slides) {
    const source =
      slide.source_image_url ||
      (slide.position === 0 ? post.source_image_url || post.image_url : null)
    if (!source) {
      throw new Error(
        `Slide ${slide.position} missing source plate — run Generate media / fetch-media first`,
      )
    }
    const canvas = canvasDocFromPromptVars(vars, slide.position)
    if (slide.text?.trim() && canvas.layers[0]) {
      canvas.layers[0].text = slide.text.trim()
    }
    const scene = sceneFromCanvasWithPlate(canvas, source)
    if (slide.position === 0) coverScene = scene
    const png = await renderScenePage(scene)
    const uploaded = await uploadStagedPng({
      postId,
      position: slide.position,
      bytes: png,
    })
    if (uploaded.storage === 'local') usedLocal = true
    updateSlide(slide.id, {
      staged_url: uploaded.publicUrl,
      canvas_json: JSON.stringify(canvas),
    })
    if (slide.position === 0 || firstUrl == null) firstUrl = uploaded.publicUrl
  }

  const coverDoc = canvasDocFromPromptVars(vars, 0)
  const updated = transitionPost(postId, 'staged', {
    patch: {
      image_url: firstUrl,
      canvas_json: JSON.stringify(coverDoc),
      ...(coverScene ? { scene_json: JSON.stringify(coverScene) } : {}),
      media_type: format === 'carousel' ? 'carousel' : 'image',
      error: null,
    },
  })

  return {
    post: updated,
    note: usedLocal
      ? 'Scene rendered + staged under /assets'
      : 'Scene rendered + staged to R2',
  }
}
