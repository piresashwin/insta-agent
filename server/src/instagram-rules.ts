/**
 * Instagram platform rules — single source of truth for skills, prompt compiler,
 * deterministic lint, and Graph publish.
 *
 * Hashtag cap: Instagram announced a 5-hashtag limit (Dec 2025); reports conflict
 * on whether 30 is still accepted, so 5 is the safe default (override via IG_HASHTAG_MAX).
 * Reel safe zones are approximate community-measured values for the Reels UI overlay.
 */

import { REEL_SAFE } from '@instagram-agent/shared'

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export const IG = {
  captionMax: 2200,
  /** Visible before "… more" in the feed. */
  firstLineMax: 125,
  get hashtagMax(): number {
    return envInt('IG_HASHTAG_MAX', 5)
  },
  hashtagMin: 3,
  altTextMax: 1000,
  /** Graph API carousel item limit. */
  carouselMaxApi: 10,
  carouselMinSlides: 3,
  onImageMaxWords: 12,
  coverMaxWords: 10,
  feed: { w: 1080, h: 1350 },
  reel: { w: 1080, h: 1920 },
  /**
   * % of frame covered by Reels UI (caption/audio row at bottom, action rail at right).
   * Single source of truth: shared/src/scene/safe-zones.ts (also used by the Studio guide overlay).
   */
  reelSafe: REEL_SAFE,
  /** One Runware clip. */
  reelDuration: { min: 6, max: 15, default: 10 },
  /** Engagement bait Meta demotes. */
  baitPatterns: [
    /\bcomment\s+["“']?(yes|below\s+if|if\s+you|amen|1|a\s+heart)\b/i,
    /\btag\s+(\d+|a|three|two|five)\s+(friends?|people)\b/i,
    /\blike\s+(this\s+)?if\b/i,
    /\bshare\s+if\s+you\b/i,
    /\blink\s+in\s+bio\b/i,
    /\bfollow\s+for\s+follow\b|\bf4f\b|\bl4l\b/i,
  ] as RegExp[],
  /** Generic tags with no search value. */
  genericHashtags: new Set([
    '#love',
    '#instagood',
    '#photooftheday',
    '#instagram',
    '#follow',
    '#like',
    '#likeforlike',
    '#followforfollow',
    '#picoftheday',
    '#viral',
    '#explore',
    '#explorepage',
    '#fyp',
    '#reels',
  ]),
}

/**
 * Percent cut from EACH of top/bottom when the still provider's render (default
 * 1024×1536, 2:3) is center-cropped to 4:5. 0 when the render is already ≤4:5 tall.
 */
export function stillCropPctPerSide(sizeRaw = process.env.IMAGE_OPENAI_SIZE || '1024x1536'): number {
  const m = sizeRaw.match(/(\d+)\s*x\s*(\d+)/i)
  if (!m) return 0
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return 0
  const keptH = (w * IG.feed.h) / IG.feed.w
  if (keptH >= h) return 0
  return ((h - keptH) / 2 / h) * 100
}

/** Convert a desired margin in the final 4:5 frame into a margin in the rendered frame. */
export function renderedMarginPct(finalPct: number, cropPct = stillCropPctPerSide()): number {
  return Math.round(cropPct + (finalPct * (100 - 2 * cropPct)) / 100)
}

export function clampReelDuration(raw: unknown): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return IG.reelDuration.default
  return Math.min(IG.reelDuration.max, Math.max(IG.reelDuration.min, n))
}

/** Return matched bait phrases in text (empty when clean). */
export function findBait(text: string | null | undefined): string[] {
  const t = text || ''
  const hits: string[] = []
  for (const re of IG.baitPatterns) {
    const m = t.match(re)
    if (m) hits.push(m[0])
  }
  return hits
}

/** Split any hashtag string ("#a #b", "a, b", "#a#b") into raw tags. */
export function parseHashtags(raw: string | null | undefined): string[] {
  return (raw || '')
    .split(/[\s,]+|(?=#)/)
    .map((t) => t.trim().replace(/^#+/, ''))
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
}

/** #-prefix, dedupe (case-insensitive), drop generic tags, cap at `max`. */
export function normalizeHashtags(raw: string | null | undefined, max = IG.hashtagMax): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of parseHashtags(raw)) {
    const tag = `#${t}`
    const key = tag.toLowerCase()
    if (seen.has(key) || IG.genericHashtags.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= max) break
  }
  return out.join(' ')
}

/** Trim at the last sentence (preferred) or word boundary that fits `limit`. */
function trimAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'))
  if (sentence > limit * 0.6) return cut.slice(0, sentence + 1).trim()
  const word = cut.lastIndexOf(' ')
  const base = (word > limit * 0.6 ? cut.slice(0, word) : cut.slice(0, limit - 1)).replace(/[\s,;:–—-]+$/, '')
  return `${base}…`
}

/**
 * Caption + hashtags joined for Graph, guaranteed ≤ captionMax.
 * Trims the caption (never the hashtags) at a clean boundary.
 */
export function fitCaption(caption: string | null | undefined, hashtags: string | null | undefined): string {
  const tags = (hashtags || '').trim()
  const body = (caption || '').trim()
  if (!tags) return trimAtBoundary(body, IG.captionMax)
  if (!body) return tags.slice(0, IG.captionMax)
  const sep = '\n\n'
  const budget = IG.captionMax - tags.length - sep.length
  if (budget < 50) return trimAtBoundary(body, IG.captionMax)
  return `${trimAtBoundary(body, budget)}${sep}${tags}`
}

export function wordCount(text: string | null | undefined): number {
  return (text || '').trim().split(/\s+/).filter(Boolean).length
}

/** Clean alt text: single line, ≤ altTextMax. */
export function normalizeAltText(raw: string | null | undefined): string {
  const t = (raw || '').replace(/\s+/g, ' ').trim()
  return t.length <= IG.altTextMax ? t : trimAtBoundary(t, IG.altTextMax)
}
