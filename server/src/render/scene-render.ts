/**
 * Server-side SceneDoc renderer.
 * Uses @napi-rs/canvas as the canvas backend — pure native bindings,
 * no system Cairo dependency required.
 *
 * Renderer architecture (Phase 3): this is deliberately NOT the same code path
 * as the live Studio editor. The editor (client/src/routes/StudioScreen.tsx)
 * is built on react-konva for interactivity (selection, drag, transform,
 * snapping) — porting that to the shared Canvas-2D `renderPage` would mean
 * re-implementing all of Konva's hit-testing and transform UI. `renderPage`
 * (shared/src/scene/renderer.ts) is instead the single *export/approval*
 * renderer, called only from here, so every published asset — regardless of
 * which tool produced the scene — goes through one code path.
 *
 * The golden-parity spike (render-endpoint tests, GOLDEN=1) checks this
 * renderer's output against a minimal hand-drawn browser <canvas> fixture as
 * a parity proxy — it does not mount the live react-konva editor. Treat the
 * editor's on-canvas preview as "close enough to compose by eye"; the PNG
 * this module produces is the one source of truth for what gets published.
 */

import { createCanvas, Image } from '@napi-rs/canvas'
import type { SceneDoc, Ctx2D, LoadImageFn, LoadedImage } from '@instagram-agent/shared'
import { renderPage } from '@instagram-agent/shared'

// ── Image loader for @napi-rs/canvas ─────────────────────────────────────────

const imageCache = new Map<string, LoadedImage>()

const serverLoadImage: LoadImageFn = async (url: string): Promise<LoadedImage> => {
  if (imageCache.has(url)) return imageCache.get(url)!

  return new Promise<LoadedImage>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const loaded: LoadedImage = { width: img.width, height: img.height, img }
      imageCache.set(url, loaded)
      resolve(loaded)
    }
    img.onerror = (err) => reject(new Error(`Failed to load image: ${url} — ${err}`))
    img.src = url
  })
}

// ── Main export ───────────────────────────────────────────────────────────────

export type RenderOptions = {
  pageIndex?: number
  /** Scale factor for the output canvas. 1 = native (1080px wide), 0.5 = half. */
  scale?: number
}

/**
 * Render one page of a SceneDoc to a PNG Buffer.
 */
export async function renderScenePage(
  doc: SceneDoc,
  options: RenderOptions = {},
): Promise<Buffer> {
  const { pageIndex = 0, scale = 1 } = options
  const page = doc.pages[pageIndex]
  if (!page) throw new Error(`Page ${pageIndex} not found (doc has ${doc.pages.length} pages)`)

  const { w, h } = doc.size
  const pw = Math.round(w * scale)
  const ph = Math.round(h * scale)

  const canvas = createCanvas(pw, ph)
  const ctx = canvas.getContext('2d') as unknown as Ctx2D

  if (scale !== 1) {
    ctx.scale(scale, scale)
  }

  await renderPage(ctx, page, doc, serverLoadImage)

  return canvas.toBuffer('image/png')
}

/**
 * Render all pages of a SceneDoc (e.g. a carousel) to PNG Buffers.
 */
export async function renderSceneAllPages(
  doc: SceneDoc,
  options: Omit<RenderOptions, 'pageIndex'> = {},
): Promise<Buffer[]> {
  const results: Buffer[] = []
  for (let i = 0; i < doc.pages.length; i++) {
    results.push(await renderScenePage(doc, { ...options, pageIndex: i }))
  }
  return results
}
