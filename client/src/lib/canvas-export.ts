import type { CanvasDoc, PostFormat } from '@instagram-agent/shared'
import { FORMAT_EXPORT } from './canvas-doc'

/** Prefer same-origin /assets path so Vite proxy avoids CORS-tainted canvas. */
export function bakeSourceUrl(src: string): string {
  try {
    const u = new URL(src, window.location.origin)
    if (u.pathname.startsWith('/assets/')) {
      return `${u.pathname}${u.search}`
    }
    // http://127.0.0.1:3001/assets/... → /assets/...
    if (u.pathname.includes('/assets/')) {
      const idx = u.pathname.indexOf('/assets/')
      return `${u.pathname.slice(idx)}${u.search}`
    }
  } catch {
    /* keep src */
  }
  return src
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load image for bake: ${src}`))
    img.src = bakeSourceUrl(src)
  })
}

function drawImageFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  fit: 'cover' | 'contain',
  focusX: number,
  focusY: number
) {
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, w, h)
  const scale =
    fit === 'contain'
      ? Math.min(w / img.naturalWidth, h / img.naturalHeight)
      : Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const dw = img.naturalWidth * scale
  const dh = img.naturalHeight * scale
  const dx = (w - dw) * focusX
  const dy = (h - dh) * focusY
  ctx.drawImage(img, dx, dy, dw, dh)
}

function drawScrim(ctx: CanvasRenderingContext2D, doc: CanvasDoc, width: number, height: number) {
  const mode = doc.scrim || 'none'
  if (mode === 'none') return
  if (mode === 'full') {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(0, 0, width, height)
    return
  }
  const grad = ctx.createLinearGradient(0, height * 0.45, 0, height)
  grad.addColorStop(0, 'rgba(0,0,0,0)')
  grad.addColorStop(1, 'rgba(0,0,0,0.65)')
  ctx.fillStyle = grad
  ctx.fillRect(0, height * 0.45, width, height * 0.55)
}

function drawLayers(
  ctx: CanvasRenderingContext2D,
  doc: CanvasDoc,
  width: number,
  height: number
) {
  for (const layer of doc.layers) {
    const fontPx = Math.max(12, layer.fontSize * height)
    ctx.font = `${layer.weight} ${fontPx}px "Source Sans 3", system-ui, sans-serif`
    ctx.textAlign = layer.align
    ctx.textBaseline = 'top'
    const maxW = layer.w * width
    const x =
      layer.align === 'center'
        ? (layer.x + layer.w / 2) * width
        : layer.align === 'right'
          ? (layer.x + layer.w) * width
          : layer.x * width
    const y = layer.y * height

    const words = (layer.text || '').split(/\s+/)
    const lines: string[] = []
    let line = ''
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line)
        line = word
      } else {
        line = test
      }
    }
    if (line) lines.push(line)

    lines.forEach((ln, i) => {
      const ly = y + i * fontPx * 1.2
      if (layer.shadow) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fillText(ln, x + 2, ly + 2, maxW)
      }
      ctx.fillStyle = layer.color || '#ffffff'
      ctx.fillText(ln, x, ly, maxW)
    })
  }
}

export async function bakeSlidePng(
  sourceUrl: string,
  doc: CanvasDoc,
  format: PostFormat
): Promise<Blob> {
  const { width, height } = FORMAT_EXPORT[format === 'carousel' ? 'carousel' : format]
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable')

  const img = await loadImage(sourceUrl)
  const bg = doc.background || { fit: 'cover' as const, focusX: 0.5, focusY: 0.5 }
  drawImageFit(
    ctx,
    img,
    width,
    height,
    bg.fit || 'cover',
    bg.focusX ?? 0.5,
    bg.focusY ?? 0.5
  )
  drawScrim(ctx, doc, width, height)
  drawLayers(ctx, doc, width, height)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/png'
    )
  })
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
