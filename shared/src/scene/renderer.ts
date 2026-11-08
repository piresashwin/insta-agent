/**
 * Shared Canvas 2D renderer for SceneDoc pages.
 * Used by the server (via @napi-rs/canvas). The Studio editor paints with
 * Konva independently — parity is tested with golden fixtures, not by
 * sharing this Canvas 2D path with the browser.
 */

import type {
  SceneDoc,
  ScenePage,
  SceneLayer,
  SceneTextLayer,
  SceneImageLayer,
  SceneShapeLayer,
  SceneGroupLayer,
  SceneBackground,
  BrandTokens,
} from './schema'
import { resolveToken, fitText } from './resolve'

// ── Minimal Canvas 2D interface ───────────────────────────────────────────────
// Using a structural type so both browser CanvasRenderingContext2D and
// @napi-rs/canvas's context satisfy it without casting.

/** Opaque gradient object returned by createLinearGradient. */
export type Ctx2DGradient = { addColorStop(offset: number, color: string): void }

export type Ctx2D = {
  canvas: { width: number; height: number }
  fillStyle: string | Ctx2DGradient | object
  strokeStyle: string | Ctx2DGradient | object
  globalAlpha: number
  font: string
  textAlign: string
  textBaseline: string
  lineWidth: number
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  beginPath(): void
  arc(x: number, y: number, r: number, start: number, end: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, start: number, end: number): void
  rect(x: number, y: number, w: number, h: number): void
  roundRect?(x: number, y: number, w: number, h: number, r: number | number[]): void
  fill(): void
  stroke(): void
  clip(): void
  closePath(): void
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  drawImage(img: unknown, x: number, y: number, w: number, h: number): void
  drawImage(img: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Ctx2DGradient
  measureText(text: string): { width: number }
}

// ── Load image abstraction ────────────────────────────────────────────────────

export type LoadedImage = {
  width: number
  height: number
  img: unknown
}

export type LoadImageFn = (url: string) => Promise<LoadedImage>

// ── Background rendering ──────────────────────────────────────────────────────

function renderBackground(
  ctx: Ctx2D,
  bg: SceneBackground,
  tokens: BrandTokens,
  w: number,
  h: number,
): void {
  ctx.save()
  if (bg.kind === 'color') {
    ctx.fillStyle = resolveToken(bg.color, tokens)
    ctx.fillRect(0, 0, w, h)
  } else if (bg.kind === 'gradient') {
    const angle = ((bg.angle ?? 0) * Math.PI) / 180
    const cx = w / 2
    const cy = h / 2
    const len = Math.sqrt(w * w + h * h) / 2
    const x0 = cx - Math.cos(angle) * len
    const y0 = cy - Math.sin(angle) * len
    const x1 = cx + Math.cos(angle) * len
    const y1 = cy + Math.sin(angle) * len
    const grad = ctx.createLinearGradient(x0, y0, x1, y1)
    for (const stop of bg.stops ?? []) {
      grad.addColorStop(stop.offset, resolveToken(stop.color, tokens))
    }
    ctx.fillStyle = grad as unknown as string
    ctx.fillRect(0, 0, w, h)
  } else if (bg.kind === 'image') {
    // Image backgrounds are drawn in renderPage after async load
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.restore()
}

// ── Layer rendering ───────────────────────────────────────────────────────────

function renderTextLayer(ctx: Ctx2D, layer: SceneTextLayer, tokens: BrandTokens): void {
  const {
    x, y, w, h,
    text,
    fontSize,
    fontFamily,
    fontWeight = 400,
    color,
    align = 'left',
    lineHeight = 1.25,
    shadow,
    uppercase,
  } = layer

  const resolvedColor = resolveToken(color, tokens)
  const resolvedFont = fontFamily ? resolveToken(fontFamily, tokens) : 'sans-serif'
  const displayText = uppercase ? text.toUpperCase() : text

  const { lines, fontSize: fittedSize } = fitText({
    text: displayText,
    maxWidth: w,
    maxHeight: h,
    fontSize,
    lineHeight,
    measure: (t, size) => {
      ctx.font = `${fontWeight} ${size}px ${resolvedFont}`
      return ctx.measureText(t).width
    },
  })

  ctx.save()
  ctx.translate(x, y)
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180)

  ctx.font = `${fontWeight} ${fittedSize}px ${resolvedFont}`
  ctx.fillStyle = resolvedColor
  ctx.textAlign = align
  ctx.textBaseline = 'top'

  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 4
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 2
  }

  const lineHeightPx = fittedSize * lineHeight
  const textX = align === 'center' ? w / 2 : align === 'right' ? w : 0

  let lineY = 0
  for (const line of lines) {
    if (lineY + lineHeightPx > h + lineHeightPx) break
    ctx.fillText(line, textX, lineY)
    lineY += lineHeightPx
  }

  ctx.restore()
}

function renderShapeLayer(ctx: Ctx2D, layer: SceneShapeLayer, tokens: BrandTokens, canvasH: number): void {
  const { x, y, w, h, shape, fill, stroke, strokeWidth = 1, cornerRadius = 0, scrim } = layer

  ctx.save()
  ctx.translate(x, y)
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180)
  ctx.globalAlpha = layer.opacity ?? 1

  if (scrim && scrim !== 'none') {
    // Scrim gradient overlay
    const gradH = scrim === 'full' ? canvasH : canvasH * 0.45
    const gradY = scrim === 'full' ? 0 : canvasH * 0.55
    const grad = ctx.createLinearGradient(0, gradY, 0, gradY + gradH)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.75)')
    ctx.fillStyle = grad as unknown as string
    ctx.fillRect(0, scrim === 'full' ? -y : gradY - y, w, gradH)
    ctx.restore()
    return
  }

  const resolvedFill = fill ? resolveToken(fill, tokens) : undefined
  const resolvedStroke = stroke ? resolveToken(stroke, tokens) : undefined

  if (shape === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    if (resolvedFill) { ctx.fillStyle = resolvedFill; ctx.fill() }
    if (resolvedStroke) { ctx.strokeStyle = resolvedStroke; ctx.lineWidth = strokeWidth; ctx.stroke() }
  } else {
    // rect
    ctx.beginPath()
    if (cornerRadius > 0 && ctx.roundRect) {
      ctx.roundRect(0, 0, w, h, cornerRadius)
    } else {
      ctx.rect(0, 0, w, h)
    }
    if (resolvedFill) { ctx.fillStyle = resolvedFill; ctx.fill() }
    if (resolvedStroke) { ctx.strokeStyle = resolvedStroke; ctx.lineWidth = strokeWidth; ctx.stroke() }
  }

  ctx.restore()
}

async function renderImageLayer(
  ctx: Ctx2D,
  layer: SceneImageLayer,
  loadImageFn: LoadImageFn,
): Promise<void> {
  const url = layer.url
  if (!url) return

  try {
    const loaded = await loadImageFn(url)
    ctx.save()
    ctx.translate(layer.x, layer.y)
    if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180)
    ctx.globalAlpha = layer.opacity ?? 1

    const fit = layer.fit ?? 'cover'
    const { width: iw, height: ih } = loaded
    const { w, h } = layer

    let sx = 0, sy = 0, sw = iw, sh = ih
    if (fit === 'cover') {
      const scale = Math.max(w / iw, h / ih)
      sw = w / scale; sh = h / scale
      sx = (iw - sw) / 2; sy = (ih - sh) / 2
    } else if (fit === 'contain') {
      const scale = Math.min(w / iw, h / ih)
      sw = w / scale; sh = h / scale
    }

    if (layer.cornerRadius) {
      ctx.beginPath()
      if (ctx.roundRect) {
        ctx.roundRect(0, 0, w, h, layer.cornerRadius)
      } else {
        ctx.rect(0, 0, w, h)
      }
      ctx.clip()
    }

    ctx.drawImage(loaded.img, sx, sy, sw, sh, 0, 0, w, h)
    ctx.restore()
  } catch {
    // Image load failed — render a placeholder rect
    ctx.save()
    ctx.translate(layer.x, layer.y)
    ctx.fillStyle = '#374151'
    ctx.fillRect(0, 0, layer.w, layer.h)
    ctx.restore()
  }
}

async function renderGroupLayer(
  ctx: Ctx2D,
  layer: SceneGroupLayer,
  tokens: BrandTokens,
  loadImageFn: LoadImageFn,
  canvasH: number,
): Promise<void> {
  ctx.save()
  ctx.translate(layer.x, layer.y)
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180)
  ctx.globalAlpha = layer.opacity ?? 1
  for (const child of layer.children) {
    await renderLayer(ctx, child, tokens, loadImageFn, canvasH)
  }
  ctx.restore()
}

async function renderLayer(
  ctx: Ctx2D,
  layer: SceneLayer,
  tokens: BrandTokens,
  loadImageFn: LoadImageFn,
  canvasH: number,
): Promise<void> {
  if (layer.visible === false) return
  switch (layer.type) {
    case 'text':  renderTextLayer(ctx, layer, tokens); break
    case 'shape': renderShapeLayer(ctx, layer, tokens, canvasH); break
    case 'image': await renderImageLayer(ctx, layer, loadImageFn); break
    case 'group': await renderGroupLayer(ctx, layer, tokens, loadImageFn, canvasH); break
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Render one page of a SceneDoc onto the given Canvas 2D context.
 * The context must already have the right width/height.
 */
export async function renderPage(
  ctx: Ctx2D,
  page: ScenePage,
  doc: SceneDoc,
  loadImageFn: LoadImageFn,
): Promise<void> {
  const { w, h } = doc.size
  const { tokens } = doc

  // Clear
  ctx.clearRect(0, 0, w, h)

  // Background
  renderBackground(ctx, page.background, tokens, w, h)

  // Layers (bottom to top = array order)
  for (const layer of page.layers) {
    await renderLayer(ctx, layer, tokens, loadImageFn, h)
  }
}
