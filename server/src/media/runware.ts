/**
 * Runware video generation for Instagram Reels.
 *
 * Width/height must be an exact pair the model accepts (not free-form Instagram
 * 1080×1920). Default model `minimax:h3@max-turbo` (H3 Max) 9:16 pairs:
 *   draft  → 480×832  (480p)
 *   final  → 768×1344 (768p)
 * Full H3 (`minimax:h3`) uses 768×1344 / 1440×2560 — override via
 * RUNWARE_REEL_DRAFT_SIZE / RUNWARE_REEL_FINAL_SIZE as WxH.
 *
 * Env:
 *   RUNWARE_API_KEY
 *   RUNWARE_API_BASE_URL (default https://api.runware.ai/v1)
 *   RUNWARE_VIDEO_MODEL (default minimax:h3@max-turbo)
 *   RUNWARE_VIDEO_DURATION (default 8, clamped 5–15)
 *   RUNWARE_REEL_DRAFT_SIZE (optional WxH, default 480x832)
 *   RUNWARE_REEL_FINAL_SIZE (optional WxH, default 768x1344)
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { assetsRoot } from './stock'
import { publicApiBase } from './r2'
import { extractReelCover } from './reel-burn'

export type ReelVideoQuality = 'draft' | 'final'

export type GeneratedReelVideo = {
  provider: 'runware'
  model: string
  quality: ReelVideoQuality
  width: number
  height: number
  duration: number
  absolutePath: string
  relativePath: string
  publicUrl: string
  /** Extracted cover frame (JPEG) when ffmpeg is available. */
  coverUrl: string | null
  prompt: string
  taskUUID: string
  videoURL: string
}

/** H3 Max turbo text-to-video 9:16 pairs (see runware.ai/docs/models/minimax-h3-max). */
const DEFAULT_QUALITY_DIMS: Record<ReelVideoQuality, { width: number; height: number }> = {
  draft: { width: 480, height: 832 },
  final: { width: 768, height: 1344 },
}

function parseWxH(
  raw: string | undefined,
  fallback: { width: number; height: number }
): { width: number; height: number } {
  const m = (raw || '').trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i)
  if (!m) return fallback
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) {
    return fallback
  }
  return { width, height }
}

const QUALITY_DIMS: Record<ReelVideoQuality, { width: number; height: number }> = {
  draft: parseWxH(process.env.RUNWARE_REEL_DRAFT_SIZE, DEFAULT_QUALITY_DIMS.draft),
  final: parseWxH(process.env.RUNWARE_REEL_FINAL_SIZE, DEFAULT_QUALITY_DIMS.final),
}

function apiBase(): string {
  return (process.env.RUNWARE_API_BASE_URL || 'https://api.runware.ai/v1').replace(/\/$/, '')
}

function videoModel(): string {
  return process.env.RUNWARE_VIDEO_MODEL || 'minimax:h3@max-turbo'
}

function videoDuration(override?: number): number {
  const raw = override ?? Number(process.env.RUNWARE_VIDEO_DURATION || 8)
  if (!Number.isFinite(raw)) return 8
  return Math.min(15, Math.max(5, Math.round(raw)))
}

export function runwareConfigured(): boolean {
  return !!process.env.RUNWARE_API_KEY?.trim()
}

export function runwareConfig() {
  return {
    configured: runwareConfigured(),
    baseUrl: apiBase(),
    model: videoModel(),
    duration: videoDuration(),
    draft: QUALITY_DIMS.draft,
    final: QUALITY_DIMS.final,
  }
}

export function dimsForQuality(quality: ReelVideoQuality) {
  return QUALITY_DIMS[quality]
}

type RunwareDataItem = {
  taskType?: string
  taskUUID?: string
  status?: string
  videoURL?: string
  videoUUID?: string
  error?: string | { message?: string; code?: string }
  cost?: number
}

type RunwareResponse = {
  data?: RunwareDataItem[]
  errors?: Array<{ message?: string; code?: string }>
  error?: string | { message?: string }
}

async function runwarePost(tasks: Record<string, unknown>[]): Promise<RunwareDataItem[]> {
  const key = process.env.RUNWARE_API_KEY?.trim()
  if (!key) throw new Error('RUNWARE_API_KEY not set')

  const res = await fetch(apiBase(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(tasks),
  })
  const json = (await res.json()) as RunwareResponse
  if (!res.ok) {
    const msg =
      (typeof json.error === 'string' ? json.error : json.error?.message) ||
      json.errors?.[0]?.message ||
      `Runware HTTP ${res.status}`
    throw new Error(msg)
  }
  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message || 'Runware task error')
  }
  return json.data || []
}

function itemError(item: RunwareDataItem | undefined): string | null {
  if (!item) return null
  if (typeof item.error === 'string' && item.error) return item.error
  if (item.error && typeof item.error === 'object' && item.error.message) {
    return item.error.message
  }
  if (item.status === 'error' || item.status === 'failed') {
    return `Runware status=${item.status}`
  }
  return null
}

async function pollVideoResult(
  taskUUID: string,
  opts?: { timeoutMs?: number; initialDelayMs?: number }
): Promise<RunwareDataItem> {
  const timeoutMs = opts?.timeoutMs ?? Number(process.env.RUNWARE_POLL_TIMEOUT_MS || 600_000)
  const initialDelayMs = opts?.initialDelayMs ?? 4_000
  const started = Date.now()
  await new Promise((r) => setTimeout(r, initialDelayMs))

  let delay = 2_000
  while (Date.now() - started < timeoutMs) {
    const data = await runwarePost([{ taskType: 'getResponse', taskUUID }])
    const item = data.find((d) => d.taskUUID === taskUUID) || data[0]
    const err = itemError(item)
    if (err) throw new Error(err)
    if (item?.videoURL) return item
    const status = (item?.status || '').toLowerCase()
    if (status === 'success' && !item?.videoURL) {
      throw new Error('Runware reported success without videoURL')
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(12_000, Math.round(delay * 1.35))
  }
  throw new Error(`Runware video timed out after ${Math.round(timeoutMs / 1000)}s (taskUUID=${taskUUID})`)
}

export async function generateReelVideo(opts: {
  postId: number | string
  prompt: string
  quality: ReelVideoQuality
  /** Clip length in seconds (from prompt_vars.duration); falls back to RUNWARE_VIDEO_DURATION. */
  duration?: number
  /** When set, extract a cover JPEG at this second (first-cue midpoint). */
  coverAtSec?: number | null
}): Promise<GeneratedReelVideo> {
  if (!runwareConfigured()) {
    throw new Error('RUNWARE_API_KEY not set. Add it to .env.local to generate Reels video.')
  }
  const prompt = opts.prompt.trim()
  if (!prompt) {
    throw new Error('reel_prompt (or image_prompt) required for Runware video generation')
  }

  const model = videoModel()
  const duration = videoDuration(opts.duration)
  const { width, height } = dimsForQuality(opts.quality)
  const taskUUID = crypto.randomUUID()
  // Prompt may instruct on-screen typography for the model to bake into pixels.
  const positivePrompt = prompt.trim().slice(0, 2000)

  const submitted = await runwarePost([
    {
      taskType: 'videoInference',
      taskUUID,
      model,
      positivePrompt,
      width,
      height,
      duration,
      deliveryMethod: 'async',
      includeCost: true,
    },
  ])

  const ack = submitted.find((d) => d.taskUUID === taskUUID) || submitted[0]
  const submitErr = itemError(ack)
  if (submitErr) throw new Error(submitErr)

  // Sync path may return videoURL immediately
  const done =
    ack?.videoURL
      ? ack
      : await pollVideoResult(ack?.taskUUID || taskUUID)

  const remoteUrl = done.videoURL
  if (!remoteUrl) throw new Error('Runware completed without videoURL')

  const vidRes = await fetch(remoteUrl)
  if (!vidRes.ok) {
    throw new Error(`Failed to download Runware video HTTP ${vidRes.status}`)
  }
  const bytes = Buffer.from(await vidRes.arrayBuffer())
  if (bytes.length < 1000) {
    throw new Error('Downloaded Runware video looks empty')
  }

  const dir = path.join(assetsRoot(), 'posts', String(opts.postId))
  fs.mkdirSync(dir, { recursive: true })
  const filename = `reel-${opts.quality}-${crypto.randomBytes(4).toString('hex')}.mp4`
  const absolutePath = path.join(dir, filename)
  fs.writeFileSync(absolutePath, bytes)
  const relativePath = path.join('posts', String(opts.postId), filename)
  const publicUrl = `${publicApiBase()}/assets/${relativePath.split(path.sep).join('/')}`

  // Cover frame for Graph cover_url (hook on screen). Best effort — publish falls back to thumb_offset.
  let coverUrl: string | null = null
  if (opts.coverAtSec != null) {
    const coverName = filename.replace(/\.mp4$/, '-cover.jpg')
    const coverAbs = await extractReelCover({
      videoPath: absolutePath,
      atSec: Math.min(opts.coverAtSec, Math.max(0, duration - 0.5)),
      outPath: path.join(dir, coverName),
    })
    if (coverAbs) {
      coverUrl = `${publicApiBase()}/assets/${path.join('posts', String(opts.postId), coverName).split(path.sep).join('/')}`
    }
  }

  return {
    provider: 'runware',
    model,
    quality: opts.quality,
    width,
    height,
    duration,
    absolutePath,
    relativePath,
    publicUrl,
    coverUrl,
    prompt,
    taskUUID: done.taskUUID || taskUUID,
    videoURL: remoteUrl,
  }
}
