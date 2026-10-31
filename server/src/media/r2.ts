/**
 * Stage baked PNGs for Graph publish.
 * Default: local disk under server/assets (tunnel via PUBLIC_API_BASE later).
 * Optional: MEDIA_STORAGE=r2 + R2_* for Cloudflare.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
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

/**
 * Base URL Graph (and the browser) use to fetch /assets/*.
 * Set PUBLIC_API_BASE to a cloudflared/ngrok HTTPS origin to tunnel the images folder.
 */
export function publicApiBase(): string {
  const base =
    process.env.PUBLIC_API_BASE ||
    `http://127.0.0.1:${process.env.PORT || 3001}`
  return base.replace(/\/$/, '')
}

/** Rewrite a stored asset URL onto the current PUBLIC_API_BASE (e.g. after starting a tunnel). */
export function rewriteAssetPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const idx = u.pathname.indexOf('/assets/')
    if (idx === -1) return url
    return `${publicApiBase()}${u.pathname.slice(idx)}${u.search}`
  } catch {
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
    publicUrl: `${publicApiBase()}/assets/${key}`,
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
