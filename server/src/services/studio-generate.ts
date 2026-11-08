/**
 * Studio AI image actions — real generate_media jobs (not prompt:// placeholders).
 */
import crypto from 'crypto'
import db from '../db'
import { ApiError, getPost, updatePostFields } from '../orchestrator'
import { getBrandProfile } from '../brand'
import { openaiImageConfigured, generateOpenAiImageForPost } from '../media/openai-image'
import {
  generateImageWithRunware,
  isRunwareImageConfigured,
} from '../media/runware-image'
import {
  fourVariationBriefs,
  loadPostSceneById,
  runGenerateBackgroundPrompt,
} from '../generation/studio-actions'
import { assertRerollAllowed } from './budget'

export type StudioGenerateAction = 'generate-background' | 'variations'

export type StudioGenerateResult = {
  action: StudioGenerateAction
  costLabel: string
  assets: Array<{ url: string; sha256: string | null; prompt: string }>
  scene_json?: string
  note?: string
}

function upsertAsset(opts: {
  postId: number
  brandId: number | null
  url: string
  prompt: string
  provider: string
}): { url: string; sha256: string } {
  const sha = crypto.createHash('sha256').update(opts.url + '|' + opts.prompt).digest('hex')
  const existing = db.prepare('SELECT url, sha256 FROM assets WHERE sha256 = ?').get(sha) as
    | { url: string; sha256: string }
    | undefined
  if (existing) return existing
  db.prepare(
    `INSERT INTO assets (kind, url, w, h, source, provider, prompt, sha256, post_id, brand_id)
     VALUES ('image', ?, NULL, NULL, 'ai', ?, ?, ?, ?, ?)`,
  ).run(opts.url, opts.provider, opts.prompt, sha, opts.postId, opts.brandId)
  return { url: opts.url, sha256: sha }
}

async function generateOneImage(opts: {
  postId: number
  prompt: string
  negative?: string
  format: string | null
}): Promise<{ url: string; provider: string }> {
  if (openaiImageConfigured()) {
    const generated = await generateOpenAiImageForPost(opts.postId, opts.prompt, {
      format: opts.format,
    })
    return { url: generated.publicUrl, provider: 'openai' }
  }
  if (isRunwareImageConfigured()) {
    const generated = await generateImageWithRunware({
      prompt: opts.prompt,
      negativePrompt: opts.negative,
      tier: 'final',
      postId: opts.postId,
    })
    return { url: generated.publicUrl, provider: 'runware' }
  }
  throw new ApiError(
    503,
    'IMAGE_OPENAI_API_KEY or RUNWARE_API_KEY required for Studio image generation',
  )
}

/** Payload for a generate_media job that runs Studio background/variations. */
export function studioGenerateJobOpts(opts: {
  postId: number
  action: StudioGenerateAction
  brief?: string
}) {
  return {
    kind: 'generate_media' as const,
    post_id: opts.postId,
    payload: {
      post_id: opts.postId,
      studio_action: opts.action,
      brief: opts.brief ?? null,
      actor: { id: 'local-dev', name: 'Local operator' },
    },
    dedupe_key: `studio:${opts.action}:${opts.postId}:${Date.now()}`,
  }
}

/** Worker entry — generate real images and update scene/assets. */
export async function executeStudioGenerateJob(opts: {
  postId: number
  action: StudioGenerateAction
  brief?: string | null
}): Promise<StudioGenerateResult> {
  const post = getPost(opts.postId)
  if (!post) throw new ApiError(404, 'post not found')
  assertRerollAllowed(opts.postId, post.format)

  const format = (post.format as 'feed' | 'reel' | 'carousel') || 'feed'
  let identity: { render_style?: string } = {}
  if (post.brand_profile_id) {
    const brand = getBrandProfile(post.brand_profile_id)
    try {
      identity = brand?.visual_identity ? JSON.parse(brand.visual_identity) : {}
    } catch {
      identity = {}
    }
  }

  if (opts.action === 'generate-background') {
    const built = runGenerateBackgroundPrompt({
      brief: opts.brief || post.image_prompt || post.hook || 'brand scene',
      renderStyle: identity.render_style,
      format,
    })
    const generated = await generateOneImage({
      postId: Number(post.id),
      prompt: built.prompt,
      negative: built.negative,
      format,
    })
    const asset = upsertAsset({
      postId: Number(post.id),
      brandId: post.brand_profile_id,
      url: generated.url,
      prompt: built.prompt,
      provider: generated.provider,
    })

    const doc = loadPostSceneById(Number(post.id))
    const page = doc.pages[0]
    if (page) {
      page.background = {
        kind: 'image',
        assetId: asset.url,
        fit: 'cover',
        focusX: 0.5,
        focusY: 0.5,
      }
    }
    const scene_json = JSON.stringify(doc)
    updatePostFields(post.id, {
      scene_json,
      image_prompt: built.prompt,
    })

    return {
      action: opts.action,
      costLabel: built.costLabel,
      assets: [{ url: asset.url, sha256: asset.sha256, prompt: built.prompt }],
      scene_json,
      note: 'Background generated',
    }
  }

  // variations
  const briefs = fourVariationBriefs(opts.brief || post.hook || 'brand scene')
  const assets: StudioGenerateResult['assets'] = []
  for (const prompt of briefs) {
    const generated = await generateOneImage({
      postId: Number(post.id),
      prompt,
      format,
    })
    const asset = upsertAsset({
      postId: Number(post.id),
      brandId: post.brand_profile_id,
      url: generated.url,
      prompt,
      provider: generated.provider,
    })
    assets.push({ url: asset.url, sha256: asset.sha256, prompt })
  }

  return {
    action: opts.action,
    costLabel: '~$0.08',
    assets,
    note: `${assets.length} variations generated`,
  }
}
