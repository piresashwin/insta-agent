/**
 * Safe-zone guides for the Studio canvas — Instagram UI chrome regions to keep
 * content clear of, plus a recommended safe-content inset. Pure geometry, no
 * rendering dependency, so it is shared between the editor overlay and tests.
 *
 * REEL_SAFE percentages are the single source of truth, also used by
 * server/src/instagram-rules.ts (IG.reelSafe) for image-generation prompts —
 * both must stay in sync with the real Reels UI (caption/audio band at bottom,
 * action rail at right).
 */
import type { PostFormat } from '../index'

export const REEL_SAFE = { topPct: 14, bottomPct: 35, sidePct: 6, rightPct: 10 } as const

/** Safe-content margin for feed/carousel, matching the renderedMarginPct(10) convention. */
const FEED_SAFE_MARGIN_PCT = 10

export type SafeRect = { x: number; y: number; w: number; h: number }

export type SafeZones = {
  /** Recommended inset where text/content should stay (always present). */
  safeContent: SafeRect
  /** Platform UI chrome regions to avoid — populated for reel, empty otherwise. */
  unsafe: SafeRect[]
}

/**
 * Compute safe-zone guides for a format at a given canvas size.
 * All returned rects are within [0, w] x [0, h].
 */
export function safeZones(format: PostFormat, size: { w: number; h: number }): SafeZones {
  const { w, h } = size

  if (format === 'reel') {
    const { topPct, bottomPct, sidePct, rightPct } = REEL_SAFE
    const top = h * (topPct / 100)
    const bottom = h * (bottomPct / 100)
    const side = w * (sidePct / 100)
    const right = w * (rightPct / 100)

    return {
      safeContent: {
        x: side,
        y: top,
        w: w - side - right,
        h: h - top - bottom,
      },
      unsafe: [
        { x: 0, y: 0, w, h: top }, // top UI band
        { x: 0, y: h - bottom, w, h: bottom }, // caption/audio band
        { x: w - right, y: 0, w: right, h }, // right action rail
      ],
    }
  }

  // feed / carousel: a centered safe-content inset; no platform chrome to avoid.
  const marginX = w * (FEED_SAFE_MARGIN_PCT / 100)
  const marginY = h * (FEED_SAFE_MARGIN_PCT / 100)
  return {
    safeContent: {
      x: marginX,
      y: marginY,
      w: w - marginX * 2,
      h: h - marginY * 2,
    },
    unsafe: [],
  }
}
