/**
 * Runware image generation for Instagram feed posts and carousels.
 *
 * Uses Runware's imageInference task. Generates at native 4:5 (1080×1350)
 * instead of 2:3 + crop, so no aspect-ratio loss.
 *
 * Env:
 *   RUNWARE_API_KEY          (required)
 *   RUNWARE_API_BASE_URL     (default https://api.runware.ai/v1)
 *   RUNWARE_IMAGE_MODEL      (overrides the tier selection)
 *
 * Model tiers (overridable via env RUNWARE_MEDIA_TIER_<TIER>):
 *   draft    — FLUX 3 Image Klein  ($0.003 at 512², more at 1080×1350)
 *   final    — Seedream 5.0 Flash  ($0.019)
 *   hero     — Seedream 5.0 Pro    ($0.048 at 1.5K)
 *   art_text — Ideogram 4.5        ($0.008, only when model renders text)
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { assetsRoot } from './stock'
import { publicApiBase } from './r2'
import db from '../db'

export type ImageTier = 'draft' | 'final' | 'hero' | 'art_text'

export type GeneratedImage = {
  provider: 'runware'
  model: string
  tier: ImageTier
  width: number
  height: number
  absolutePath: string
  relativePath: string
  publicUrl: string
  prompt: string
  taskUUID: string
  costUsd: number | null
}

/** Default model IDs per tier. Override with RUNWARE_MEDIA_TIER_<UPPER>. */
export const MEDIA_MODELS: Record<ImageTier, string> = {
  draft: process.env.RUNWARE_MEDIA_TIER_DRAFT ?? 'civitai:flux-dev@flux-1-dev',
  final: process.env.RUNWARE_MEDIA_TIER_FINAL ?? 'seedream:5.0-flash',
  hero: process.env.RUNWARE_MEDIA_TIER_HERO ?? 'seedream:5.0-pro',
  art_text: process.env.RUNWARE_MEDIA_TIER_ART_TEXT ?? 'ideogram:4.5',
}

/** Native 4:5 dimensions for Instagram feed (1080×1350 when the model supports it). */
const IMAGE_DIMS: Record<ImageTier, { width: number; height: number }> = {
  draft: { width: 512, height: 640 },   // cheaper at draft stage
  final: { width: 1080, height: 1350 },
  hero: { width: 1080, height: 1350 },
  art_text: { width: 1080, height: 1350 },
}

function apiBase(): string {
  return (process.env.RUNWARE_API_BASE_URL || 'https://api.runware.ai/v1').replace(/\/$/, '')
}

export function isRunwareImageConfigured(): boolean {
  return !!process.env.RUNWARE_API_KEY?.trim()
}

type RunwareImageTask = {
  taskType: 'imageInference'
  taskUUID: string
  positivePrompt: string
  negativePrompt?: string
  model: string
  width: number
  height: number
  numberResults: 1
  steps?: number
  CFGScale?: number
  includeCost?: boolean
}

type RunwareImageResult = {
  taskUUID: string
  imageURL: string
  imageBase64DataURI?: string
  cost?: number
}

export async function generateImageWithRunware(opts: {
  prompt: string
  negativePrompt?: string
  tier?: ImageTier
  postId?: number
}): Promise<GeneratedImage> {
  const { prompt, negativePrompt, tier = 'final', postId } = opts

  const key = process.env.RUNWARE_API_KEY?.trim()
  if (!key) throw new Error('RUNWARE_API_KEY not set. Add it to .env.local to generate images.')

  const modelId = process.env.RUNWARE_IMAGE_MODEL ?? MEDIA_MODELS[tier]
  const dims = IMAGE_DIMS[tier]

  const taskUUID = crypto.randomUUID()
  const task: RunwareImageTask = {
    taskType: 'imageInference',
    taskUUID,
    positivePrompt: prompt.slice(0, 2000),
    ...(negativePrompt ? { negativePrompt } : {}),
    model: modelId,
    width: dims.width,
    height: dims.height,
    numberResults: 1,
    includeCost: true,
  }

  const res = await fetch(`${apiBase()}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify([task]),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Runware image API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as { data?: RunwareImageResult[] }
  const result = json.data?.[0]
  if (!result?.imageURL) {
    throw new Error(`Runware returned no image URL. Response: ${JSON.stringify(json).slice(0, 300)}`)
  }

  // Download the image to the local assets directory
  const imgRes = await fetch(result.imageURL)
  if (!imgRes.ok) throw new Error(`Failed to download image from Runware: ${imgRes.status}`)

  const buffer = Buffer.from(await imgRes.arrayBuffer())
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12)
  const filename = `runware-${tier}-${hash}.jpg`
  const absDir = assetsRoot()
  fs.mkdirSync(absDir, { recursive: true })
  const absPath = path.join(absDir, filename)
  fs.writeFileSync(absPath, buffer)

  const relPath = `assets/${filename}`
  const publicUrl = `${publicApiBase()}/${relPath}`

  const costUsd = result.cost ?? null

  // Record spend
  if (costUsd && costUsd > 0) {
    try {
      db.prepare(
        `INSERT INTO spend_ledger (kind, provider, model, cost_usd, post_id, estimated, budget_scope)
         VALUES ('image', 'runware', ?, ?, ?, 0, 'prod')`,
      ).run(modelId, costUsd, postId ?? null)
    } catch {
      // non-fatal
    }
  }

  return {
    provider: 'runware',
    model: modelId,
    tier,
    width: dims.width,
    height: dims.height,
    absolutePath: absPath,
    relativePath: relPath,
    publicUrl,
    prompt,
    taskUUID: result.taskUUID,
    costUsd,
  }
}
