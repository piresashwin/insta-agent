/**
 * OPTIONAL spike — client↔server PNG golden parity.
 *
 * Committed Chunk B deliverable is endpoint + hash + server pixel regression.
 * This browser capture is gated so CI stays green without Playwright.
 *
 * Requires: pnpm --filter server add -D playwright && npx playwright install chromium
 *   GOLDEN=1 pnpm --filter server test:golden
 */

import { describe, it, expect } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderScenePage } from '../scene-render'
import type { SceneDoc } from '@instagram-agent/shared'

const runGolden = process.env.GOLDEN === '1'

/** Fixture without text — avoids font AA differences between engines. */
function fixtureDoc(): SceneDoc {
  return {
    version: 2,
    format: 'feed',
    size: { w: 1080, h: 1350 },
    tokens: { colors: {}, fonts: {} },
    pages: [
      {
        id: 'p_golden',
        background: { kind: 'color', color: '#1a1a2e' },
        layers: [
          {
            id: 'l_rect',
            type: 'shape',
            shape: 'rect',
            x: 100,
            y: 200,
            w: 400,
            h: 300,
            fill: '#00ff88',
          },
        ],
      },
    ],
  }
}

function pixelDiffPercent(
  a: Uint8ClampedArray | Buffer,
  b: Uint8ClampedArray | Buffer,
  threshold = 16,
): number {
  const len = Math.min(a.length, b.length)
  let diff = 0
  const pixels = len / 4
  for (let i = 0; i < len; i += 4) {
    const dr = Math.abs(a[i] - b[i])
    const dg = Math.abs(a[i + 1] - b[i + 1])
    const db = Math.abs(a[i + 2] - b[i + 2])
    if (dr > threshold || dg > threshold || db > threshold) diff++
  }
  return diff / pixels
}

describe.skipIf(!runGolden)('golden parity (GOLDEN=1)', () => {
  it('server vs browser canvas PNG differs by <1% of pixels', async () => {
    // Dynamic import — playwright is optional; only needed when GOLDEN=1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let playwrightMod: any
    try {
      // Avoid a hard compile-time dependency on the optional playwright package.
      const name = 'playwright'
      playwrightMod = await import(name)
    } catch {
      throw new Error(
        'GOLDEN=1 requires playwright. Install with: pnpm --filter server add -D playwright && npx playwright install chromium',
      )
    }

    const scale = 0.25
    const doc = fixtureDoc()
    const serverPng = await renderScenePage(doc, { scale })
    const serverImg = await loadImage(serverPng)
    const serverCanvas = createCanvas(serverImg.width, serverImg.height)
    const serverCtx = serverCanvas.getContext('2d')
    serverCtx.drawImage(serverImg, 0, 0)
    const serverData = serverCtx.getImageData(0, 0, serverImg.width, serverImg.height).data

    const w = Math.round(doc.size.w * scale)
    const h = Math.round(doc.size.h * scale)

    const browser = await playwrightMod.chromium.launch()
    try {
      const page = await browser.newPage()
      // Draw the same fixture with browser Canvas 2D (mirrors shared renderer for color+rect).
      const browserPngB64: string = await page.evaluate(
        `(() => {
          const width = ${w};
          const height = ${h};
          const s = ${scale};
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.scale(s, s);
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(0, 0, 1080, 1350);
          ctx.fillStyle = '#00ff88';
          ctx.fillRect(100, 200, 400, 300);
          return canvas.toDataURL('image/png').replace(/^data:image\\/png;base64,/, '');
        })()`,
      )

      const browserPng = Buffer.from(browserPngB64, 'base64')
      const browserImg = await loadImage(browserPng)
      const browserCanvas = createCanvas(browserImg.width, browserImg.height)
      const browserCtx = browserCanvas.getContext('2d')
      browserCtx.drawImage(browserImg, 0, 0)
      const browserData = browserCtx.getImageData(0, 0, browserImg.width, browserImg.height).data

      expect(browserImg.width).toBe(serverImg.width)
      expect(browserImg.height).toBe(serverImg.height)

      const pct = pixelDiffPercent(serverData, browserData)
      expect(pct).toBeLessThan(0.01)
    } finally {
      await browser.close()
    }
  })
})
