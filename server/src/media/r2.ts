/**
 * Stage baked PNGs for Graph publish.
 * Default: local disk under server/assets. Stored URLs are always localhost.
 * PUBLIC_API_BASE / DB publish tunnel is used only when rewriting URLs for Instagram publish.
 * Optional: MEDIA_STORAGE=r2 + R2_* for Cloudflare.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getSetting, SETTING_PUBLISH_TUNNEL_BASE } from '../settings'
import { assetsRoot } from './stock'

export type StagedUploadResult = {
  key: string
  publicUrl: string
  storage: 'r2' | 'local'
}

export function r2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_BASE_URL
  )
}

/** Prefer local until you explicitly opt into R2. */
export function preferR2Storage(): boolean {
  return process.env.MEDIA_STORAGE === 'r2' && r2Configured()
}

/** Local origin for stored asset URLs (preview / same-machine). Never the tunnel. */
export function localApiBase(): string {
  return `http://127.0.0.1:${process.env.PORT || 3001}`.replace(/\/$/, '')
}

/**
 * HTTPS origin Meta must fetch during publish only.
 * Prefer app_settings.publish_tunnel_base (Admin → Generate tunnel; live, no restart),
 * then PUBLIC_API_BASE env.
 */
export function publishApiBase(): string | null {
  const fromDb = getSetting(SETTING_PUBLISH_TUNNEL_BASE)
  if (fromDb?.startsWith('https://')) return fromDb.replace(/\/$/, '')
  const base = (process.env.PUBLIC_API_BASE || '').trim().replace(/\/$/, '')
  if (!base) return null
  if (!base.startsWith('https://')) return null
  return base
}

/**
 * @deprecated Prefer localApiBase() for storage and publishApiBase() for Graph.
 * Kept as local so callers stop baking the tunnel into staged URLs.
 */
export function publicApiBase(): string {
  return localApiBase()
}

/**
 * Rewrite a stored /assets/... URL onto the live publish tunnel (PUBLIC_API_BASE).
 * Used only by Instagram publish — not when generating or staging media.
 */
export function rewriteAssetPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const idx = u.pathname.indexOf('/assets/')
    if (idx === -1) return url
    const publish = publishApiBase()
    if (!publish) {
      throw new Error(
        'Publish tunnel missing: use Accounts → Generate tunnel (or set PUBLIC_API_BASE). Generation/staging use localhost.'
      )
    }
    return `${publish}${u.pathname.slice(idx)}${u.search}`
  } catch (e) {
    if (e instanceof Error && e.message.includes('Publish tunnel missing')) throw e
    return url
  }
}

function client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID!
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

async function uploadPngToR2(opts: {
  postId: number | string
  position: number
  bytes: Buffer
}): Promise<StagedUploadResult> {
  const hash = crypto.createHash('sha256').update(opts.bytes).digest('hex').slice(0, 12)
  const key = `posts/${opts.postId}/slides/${opts.position}-${hash}.png`
  const bucket = process.env.R2_BUCKET!
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: opts.bytes,
      ContentType: 'image/png',
    })
  )
  const base = process.env.R2_PUBLIC_BASE_URL!.replace(/\/$/, '')
  return { key, publicUrl: `${base}/${key}`, storage: 'r2' }
}

function savePngLocally(opts: {
  postId: number | string
  position: number
  bytes: Buffer
}): StagedUploadResult {
  const hash = crypto.createHash('sha256').update(opts.bytes).digest('hex').slice(0, 12)
  const dir = path.join(assetsRoot(), 'posts', String(opts.postId), 'staged')
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${opts.position}-${hash}.png`
  fs.writeFileSync(path.join(dir, filename), opts.bytes)
  const key = `posts/${opts.postId}/staged/${filename}`
  return {
    key,
    publicUrl: `${localApiBase()}/assets/${key}`,
    storage: 'local',
  }
}

/** Local disk by default; R2 only when MEDIA_STORAGE=r2. */
export async function uploadStagedPng(opts: {
  postId: number | string
  position: number
  bytes: Buffer
}): Promise<StagedUploadResult> {
  if (preferR2Storage()) return uploadPngToR2(opts)
  return savePngLocally(opts)
}

async function uploadVideoToR2(opts: {
  postId: number | string
  bytes: Buffer
  filenameHint?: string
}): Promise<StagedUploadResult> {
  const hash = crypto.createHash('sha256').update(opts.bytes).digest('hex').slice(0, 12)
  const key = `posts/${opts.postId}/staged/reel-${hash}.mp4`
  const bucket = process.env.R2_BUCKET!
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: opts.bytes,
      ContentType: 'video/mp4',
    })
  )
  const base = process.env.R2_PUBLIC_BASE_URL!.replace(/\/$/, '')
  return { key, publicUrl: `${base}/${key}`, storage: 'r2' }
}

function saveVideoLocally(opts: {
  postId: number | string
  bytes: Buffer
}): StagedUploadResult {
  const hash = crypto.createHash('sha256').update(opts.bytes).digest('hex').slice(0, 12)
  const dir = path.join(assetsRoot(), 'posts', String(opts.postId), 'staged')
  fs.mkdirSync(dir, { recursive: true })
  const filename = `reel-${hash}.mp4`
  fs.writeFileSync(path.join(dir, filename), opts.bytes)
  const key = `posts/${opts.postId}/staged/${filename}`
  return {
    key,
    publicUrl: `${localApiBase()}/assets/${key}`,
    storage: 'local',
  }
}

/** Stage an MP4 for Graph Reels publish (local or R2). */
export async function uploadStagedVideo(opts: {
  postId: number | string
  bytes: Buffer
}): Promise<StagedUploadResult> {
  if (preferR2Storage()) return uploadVideoToR2(opts)
  return saveVideoLocally(opts)
}

/**
 * Resolve a stored /assets/... URL (or absolute path under assets) to bytes.
 * Used to re-stage reel drafts for publish.
 */
export function readLocalAssetBytes(urlOrPath: string): Buffer | null {
  try {
    let pathname = urlOrPath
    try {
      const u = new URL(urlOrPath)
      pathname = u.pathname
    } catch {
      /* already a path */
    }
    const idx = pathname.indexOf('/assets/')
    const rel = idx >= 0 ? pathname.slice(idx + '/assets/'.length) : pathname.replace(/^\/+/, '')
    const root = assetsRoot()
    // Resolve and confirm the final path stays inside the assets root.
    // path.join normalises '..', so an adversarial '../../../etc/passwd' would
    // escape the folder without this check.
    const abs = path.resolve(root, rel.split('/').join(path.sep))
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      console.warn('[r2] readLocalAssetBytes: path escape attempt blocked:', urlOrPath)
      return null
    }
    if (!fs.existsSync(abs)) return null
    return fs.readFileSync(abs)
  } catch {
    return null
  }
}
