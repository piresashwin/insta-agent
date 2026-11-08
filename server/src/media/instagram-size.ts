/**
 * Normalize stills to Instagram export pixels (FORMAT_EXPORT).
 * OpenAI etc. often return 1024×1536 (2:3); we cover-crop to 4:5 / 9:16 at full export size.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { PostFormat } from '@instagram-agent/shared'
import { FORMAT_EXPORT } from '@instagram-agent/shared'
import { readLocalAssetBytes } from './r2'

export function exportSizeForFormat(format: string | null | undefined): {
  width: number
  height: number
  aspect: string
  key: PostFormat
} {
  const f = (format || 'feed').toLowerCase()
  const key: PostFormat =
    f === 'reel' ? 'reel' : f === 'carousel' ? 'carousel' : 'feed'
  const size = FORMAT_EXPORT[key]
  return { ...size, key }
}

/** Cover-crop image bytes to exact Instagram export dimensions; returns PNG. */
export async function coverCropToInstagramSize(
  imageBytes: Buffer,
  format: string | null | undefined
): Promise<Buffer> {
  const { width, height } = exportSizeForFormat(format)
  const img = await loadImage(imageBytes)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, width, height)

  const scale = Math.max(width / img.width, height / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  // Center crop (Instagram-safe; keep subject mid-frame)
  const dx = (width - dw) / 2
  const dy = (height - dh) / 2
  ctx.drawImage(img, dx, dy, dw, dh)

  return canvas.toBuffer('image/png')
}

/** Load local /assets URL or remote URL → bytes. */
export async function loadImageBytes(urlOrPath: string): Promise<Buffer> {
  const local = readLocalAssetBytes(urlOrPath)
  if (local) return local
  if (/^https?:\/\//i.test(urlOrPath)) {
    const res = await fetch(urlOrPath)
    if (!res.ok) throw new Error(`Failed to fetch image HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error(`Cannot load image bytes from ${urlOrPath}`)
}

/** Fetch/load + cover-crop to Instagram size. */
export async function normalizeImageUrlToInstagramSize(
  urlOrPath: string,
  format: string | null | undefined
): Promise<Buffer> {
  const raw = await loadImageBytes(urlOrPath)
  return coverCropToInstagramSize(raw, format)
}
