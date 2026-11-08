/**
 * OpenAI GPT Image generation — separate from LM Studio / chat OPENAI_* config.
 *
 * Env (all optional except key when using provider=openai):
 *   IMAGE_OPENAI_API_KEY   — OpenAI API key for images (do not reuse LM Studio key)
 *   IMAGE_OPENAI_BASE_URL  — default https://api.openai.com/v1
 *   IMAGE_OPENAI_MODEL     — default gpt-image-2 (e.g. gpt-image-2.5-flare, gpt-image-1-mini)
 *   IMAGE_OPENAI_SIZE      — optional override; else format-based
 *   IMAGE_OPENAI_QUALITY   — low | medium | high | auto (default auto)
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { BACKGROUND_STYLES } from '@instagram-agent/shared'
import { localApiBase } from './r2'
import { assetsRoot } from './stock'
import { coverCropToInstagramSize, exportSizeForFormat } from './instagram-size'

export type GeneratedImageAsset = {
  provider: 'openai'
  model: string
  absolutePath: string
  relativePath: string
  publicUrl: string
  mime: string
  prompt: string
}

export function openaiImageConfigured(): boolean {
  return !!process.env.IMAGE_OPENAI_API_KEY?.trim()
}

export function openaiImageConfig() {
  return {
    configured: openaiImageConfigured(),
    baseUrl: (process.env.IMAGE_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
      /\/$/,
      ''
    ),
    model: process.env.IMAGE_OPENAI_MODEL || 'gpt-image-2',
    quality: process.env.IMAGE_OPENAI_QUALITY || 'auto',
    sizeOverride: process.env.IMAGE_OPENAI_SIZE || null,
  }
}

/**
 * Map post format → OpenAI Images API size (API-limited).
 * We always cover-crop afterward to FORMAT_EXPORT (1080×1350 / 1080×1920).
 * Portrait 1024×1536 is the closest tall size the API offers.
 */
export function sizeForFormat(format: string | null | undefined): string {
  if (process.env.IMAGE_OPENAI_SIZE?.trim()) return process.env.IMAGE_OPENAI_SIZE.trim()
  const f = (format || 'feed').toLowerCase()
  if (f === 'reel' || f === 'feed' || f === 'carousel') return '1024x1536'
  return '1024x1024'
}

/** Full generation prompt from post.image_prompt (+ optional style + brand visual). */
export function imagePromptFromPost(post: {
  image_prompt?: string | null
  topic?: string | null
  hook?: string | null
  background_style?: string | null
  format?: string | null
  brandVisual?: string | null
  imagePromptExtra?: string | null
}): string {
  let prompt = (post.image_prompt || '').trim()
  if (!prompt) {
    const topic = (post.topic || '').trim()
    const hook = (post.hook || '').trim()
    prompt = [topic && `Instagram visual for: ${topic}`, hook && `Hook mood: ${hook}`]
      .filter(Boolean)
      .join('. ')
  }
  if (!prompt) prompt = 'Lifestyle Instagram photograph, natural light, editorial'

  const style = BACKGROUND_STYLES.find((s) => s.id === post.background_style)
  if (style?.keywords) {
    prompt = `${prompt}. Visual style: ${style.keywords}`
  }
  if (post.brandVisual?.trim()) {
    prompt = `${prompt}. Brand visual direction: ${post.brandVisual.trim()}`
  }
  if (post.imagePromptExtra?.trim()) {
    prompt = `${prompt}. Extra direction: ${post.imagePromptExtra.trim()}`
  }

  const format = (post.format || 'feed').toLowerCase()
  if (format === 'reel') {
    prompt = `${prompt}. Vertical 9:16 composition suitable for Instagram Reels.`
  } else {
    prompt = `${prompt}. Vertical 4:5 Instagram feed composition.`
  }
  // On-image typography is instructed in the generation prompt when needed.

  return prompt.slice(0, 30000)
}

type ImagesApiResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  error?: { message?: string; code?: string; type?: string }
}

export async function generateOpenAiImageForPost(
  postId: number | string,
  prompt: string,
  opts?: { format?: string | null }
): Promise<GeneratedImageAsset> {
  const cfg = openaiImageConfig()
  if (!cfg.configured) {
    throw new Error(
      'IMAGE_OPENAI_API_KEY not set. Add it to .env.local (separate from LM Studio OPENAI_*).'
    )
  }

  const size = sizeForFormat(opts?.format)
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    n: 1,
    size,
  }
  // GPT image models: quality + always return b64 (response_format unsupported / ignored).
  if (cfg.quality && cfg.quality !== 'auto') {
    body.quality = cfg.quality
  }

  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.IMAGE_OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const json = (await res.json().catch(() => ({}))) as ImagesApiResponse
  if (!res.ok || json.error) {
    throw new Error(
      json.error?.message || `OpenAI Images HTTP ${res.status}`
    )
  }

  const item = json.data?.[0]
  let bytes: Buffer
  if (item?.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64')
  } else if (item?.url) {
    const imgRes = await fetch(item.url)
    if (!imgRes.ok) throw new Error(`Failed to download generated image HTTP ${imgRes.status}`)
    bytes = Buffer.from(await imgRes.arrayBuffer())
  } else {
    throw new Error('OpenAI Images response had no b64_json or url')
  }

  // Cover-crop to Instagram export pixels (feed/carousel 1080×1350, reel 1080×1920)
  const format = opts?.format || 'feed'
  bytes = await coverCropToInstagramSize(bytes, format)
  const target = exportSizeForFormat(format)
  const mime = 'image/png'

  const dir = path.join(assetsRoot(), 'posts', String(postId))
  fs.mkdirSync(dir, { recursive: true })
  const filename = `openai-${target.width}x${target.height}-${crypto.randomBytes(4).toString('hex')}.png`
  const absolutePath = path.join(dir, filename)
  fs.writeFileSync(absolutePath, bytes)
  const relativePath = path.join('posts', String(postId), filename)
  const publicUrl = `${localApiBase()}/assets/${relativePath.split(path.sep).join('/')}`

  return {
    provider: 'openai',
    model: cfg.model,
    absolutePath,
    relativePath,
    publicUrl,
    mime,
    prompt,
  }
}
