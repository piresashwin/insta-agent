/**
 * Phase 3 spike: server-side SceneDoc rendering.
 *
 * Goals:
 * 1. Confirm @napi-rs/canvas can produce a valid PNG from a SceneDoc.
 * 2. Verify specific pixel colours are in the right place (colour regression).
 * 3. Establish the golden-image baseline for browser comparison.
 *
 * Golden comparison methodology (for CI):
 *   - Run the StudioScreen client in Playwright, capture the Konva stage as PNG.
 *   - Load server PNG from this test, compare with pixelmatch.
 *   - Require < 1% differing pixels (sub-pixel AA tolerance).
 *   This browser step is in client/tests/studio-golden.spec.ts (Phase 3, week 2).
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createCanvas } from '@napi-rs/canvas'
import { renderScenePage } from '../scene-render'
import {
  defaultSceneDoc,
  newLayerId,
  newPageId,
  type SceneDoc,
  type SceneTextLayer,
  type SceneShapeLayer,
  type SceneImageLayer,
} from '@instagram-agent/shared'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sample a pixel at (x, y) from a PNG Buffer using @napi-rs/canvas. */
async function samplePixel(pngBuf: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  // loadImage is in @napi-rs/canvas but we can use createCanvas + drawImage
  const { loadImage } = await import('@napi-rs/canvas')
  const img = await loadImage(pngBuf)
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(x, y, 1, 1).data
  return [d[0], d[1], d[2], d[3]]
}

/** Percentage of pixels in a PNG Buffer that differ from a solid colour. */
async function solidColorAccuracy(
  pngBuf: Buffer,
  expected: [number, number, number],
  tolerance = 10,
): Promise<number> {
  const { loadImage } = await import('@napi-rs/canvas')
  const img = await loadImage(pngBuf)
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height)
  let match = 0
  const total = width * height
  for (let i = 0; i < data.length; i += 4) {
    const dr = Math.abs(data[i] - expected[0])
    const dg = Math.abs(data[i + 1] - expected[1])
    const db = Math.abs(data[i + 2] - expected[2])
    if (dr <= tolerance && dg <= tolerance && db <= tolerance) match++
  }
  return match / total
}

/** Max pixel brightness (R+G+B) in a rectangular region. */
async function maxBrightness(
  pngBuf: Buffer,
  x: number, y: number, w: number, h: number,
): Promise<number> {
  const { loadImage } = await import('@napi-rs/canvas')
  const img = await loadImage(pngBuf)
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(x, y, w, h)
  let max = 0
  for (let i = 0; i < data.length; i += 4) {
    const b = data[i] + data[i + 1] + data[i + 2]
    if (b > max) max = b
  }
  return max
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('renderScenePage', () => {
  it('produces a valid PNG buffer', async () => {
    const doc = defaultSceneDoc('feed')
    const buf = await renderScenePage(doc)
    // PNG magic bytes: 89 50 4e 47
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4e)
    expect(buf[3]).toBe(0x47)
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('output has correct dimensions (feed = 1080×1350)', async () => {
    const doc = defaultSceneDoc('feed')
    const buf = await renderScenePage(doc)
    const { loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(buf)
    expect(img.width).toBe(1080)
    expect(img.height).toBe(1350)
  })

  it('output has correct dimensions when scaled to 0.5', async () => {
    const doc = defaultSceneDoc('feed')
    const buf = await renderScenePage(doc, { scale: 0.5 })
    const { loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(buf)
    expect(img.width).toBe(540)
    expect(img.height).toBe(675)
  })

  it('renders a solid colour background accurately (≥99% matching pixels)', async () => {
    const doc: SceneDoc = {
      ...defaultSceneDoc('feed'),
      pages: [{
        id: newPageId(),
        background: { kind: 'color', color: '#ff5500' },
        layers: [],
      }],
    }
    const buf = await renderScenePage(doc, { scale: 0.1 })
    // #ff5500 = [255, 85, 0]
    const pct = await solidColorAccuracy(buf, [255, 85, 0])
    expect(pct).toBeGreaterThan(0.99)
  })

  it('renders a gradient background (top pixel and bottom pixel differ)', async () => {
    const doc: SceneDoc = {
      ...defaultSceneDoc('feed'),
      pages: [{
        id: newPageId(),
        background: {
          kind: 'gradient',
          // angle:90 in our convention = top-to-bottom (sin(90°)=1 drives y axis)
          angle: 90,
          stops: [
            { offset: 0, color: '#ffffff' },
            { offset: 1, color: '#000000' },
          ],
        },
        layers: [],
      }],
    }
    const buf = await renderScenePage(doc, { scale: 0.1 })
    const top = await samplePixel(buf, 1, 1)
    const bottom = await samplePixel(buf, 1, 134)
    // Top should be near white, bottom near black
    expect(top[0]).toBeGreaterThan(200)
    expect(bottom[0]).toBeLessThan(50)
  })

  it('renders text layer — text region is visually distinct from background', async () => {
    const textLayer: SceneTextLayer = {
      id: newLayerId(),
      type: 'text',
      x: 0, y: 540, w: 1080, h: 200,
      text: 'Hello World',
      fontSize: 80,
      color: '#ffffff',
      fontFamily: 'sans-serif',
      fontWeight: 700,
    }
    const doc: SceneDoc = {
      ...defaultSceneDoc('feed'),
      pages: [{
        id: newPageId(),
        background: { kind: 'color', color: '#1a1a2e' },
        layers: [textLayer],
      }],
    }
    const buf = await renderScenePage(doc, { scale: 0.1 })
    // At 0.1 scale: text layer starts at y=54, height 20px (200*0.1)
    // Scan the text region for the brightest pixel — white text should be 765 (255*3)
    const textMax = await maxBrightness(buf, 0, 54, 108, 20)
    // Background area well above text — should be dark (#1a1a2e ≈ 98)
    const bgMax = await maxBrightness(buf, 0, 5, 108, 10)
    // Text region must have at least one white-ish pixel
    expect(textMax).toBeGreaterThan(500)
    // Background region should be uniformly dark
    expect(bgMax).toBeLessThan(200)
  })

  it('renders a shape layer — rect fills the expected region', async () => {
    const shapeLayer: SceneShapeLayer = {
      id: newLayerId(),
      type: 'shape',
      shape: 'rect',
      x: 100, y: 100, w: 300, h: 300,
      fill: '#00ff00',
    }
    const doc: SceneDoc = {
      ...defaultSceneDoc('feed'),
      pages: [{
        id: newPageId(),
        background: { kind: 'color', color: '#1a1a2e' },
        layers: [shapeLayer],
      }],
    }
    const buf = await renderScenePage(doc, { scale: 0.1 })
    // At 0.1 scale: shape at (10,10) with size (30,30)
    const inside = await samplePixel(buf, 15, 15)
    const outside = await samplePixel(buf, 2, 2)
    // Inside the rect: #00ff00 = [0, 255, 0]
    expect(inside[1]).toBeGreaterThan(200) // green channel high
    expect(inside[0]).toBeLessThan(50)     // red channel low
    // Outside: background colour #1a1a2e ≈ [26, 26, 46] — not green
    expect(outside[1]).toBeLessThan(50)
  })

  it('resolves brand token colours correctly', async () => {
    const doc: SceneDoc = {
      version: 2,
      format: 'feed',
      size: { w: 1080, h: 1350 },
      tokens: {
        colors: { brand: '#b8336a' },
        fonts: {},
      },
      pages: [{
        id: newPageId(),
        background: { kind: 'color', color: 'token:brand' },
        layers: [],
      }],
    }
    const buf = await renderScenePage(doc, { scale: 0.1 })
    // #b8336a = [184, 51, 106]
    const pct = await solidColorAccuracy(buf, [184, 51, 106])
    expect(pct).toBeGreaterThan(0.99)
  })

  it('renders reel format at correct 9:16 dimensions', async () => {
    const doc = defaultSceneDoc('reel')
    const buf = await renderScenePage(doc, { scale: 0.1 })
    const { loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(buf)
    expect(img.width).toBe(108)
    expect(img.height).toBe(192)
  })

  it('renders a reel cover at full 1080×1920', async () => {
    const doc = defaultSceneDoc('reel')
    const buf = await renderScenePage(doc)
    const { loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(buf)
    expect(img.width).toBe(1080)
    expect(img.height).toBe(1920)
  })

  it('renders an image layer inside its box', async () => {
    // Solid magenta 40×40 PNG written to a temp file for the server image loader.
    const tile = createCanvas(40, 40)
    const tctx = tile.getContext('2d')
    tctx.fillStyle = '#ff00ff'
    tctx.fillRect(0, 0, 40, 40)
    const tilePath = path.join(os.tmpdir(), `scene-img-${Date.now()}.png`)
    fs.writeFileSync(tilePath, tile.toBuffer('image/png'))

    const imageLayer: SceneImageLayer = {
      id: newLayerId(),
      type: 'image',
      x: 200,
      y: 300,
      w: 400,
      h: 400,
      url: tilePath,
      fit: 'fill',
    }
    const doc: SceneDoc = {
      ...defaultSceneDoc('feed'),
      pages: [{
        id: newPageId(),
        background: { kind: 'color', color: '#000000' },
        layers: [imageLayer],
      }],
    }

    const buf = await renderScenePage(doc, { scale: 0.1 })
    // At 0.1 scale: image at (20,30) size 40×40
    const inside = await samplePixel(buf, 25, 35)
    const outside = await samplePixel(buf, 2, 2)
    expect(inside[0]).toBeGreaterThan(200) // magenta red channel
    expect(inside[2]).toBeGreaterThan(200) // magenta blue channel
    expect(outside[0]).toBeLessThan(20)
    expect(outside[1]).toBeLessThan(20)
    expect(outside[2]).toBeLessThan(20)

    fs.unlinkSync(tilePath)
  })

  it('scrim darkens the lower region of the page', async () => {
    const scrimLayer: SceneShapeLayer = {
      id: newLayerId(),
      type: 'shape',
      shape: 'rect',
      x: 0,
      y: 0,
      w: 1080,
      h: 1350,
      scrim: 'bottom',
    }
    const doc: SceneDoc = {
      ...defaultSceneDoc('feed'),
      pages: [{
        id: newPageId(),
        background: { kind: 'color', color: '#ffffff' },
        layers: [scrimLayer],
      }],
    }
    const buf = await renderScenePage(doc, { scale: 0.1 })
    // At 0.1 scale height 135; bottom scrim starts ~55% → y≈74
    const top = await samplePixel(buf, 50, 10)
    const bottom = await samplePixel(buf, 50, 120)
    const topBright = top[0] + top[1] + top[2]
    const bottomBright = bottom[0] + bottom[1] + bottom[2]
    expect(topBright).toBeGreaterThan(700)
    expect(bottomBright).toBeLessThan(topBright - 50)
  })
})

describe('renderScenePage — performance', () => {
  it('renders a feed page under 500ms', async () => {
    const doc = defaultSceneDoc('feed')
    const start = Date.now()
    await renderScenePage(doc)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })
})
