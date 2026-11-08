/**
 * Phase 4 — PerformanceDigest per brand.
 */
import type {
  DigestPost,
  DigestResult,
  LiftBucket,
  PerformanceDigest,
} from '@instagram-agent/shared'
import db from '../db'

type ScoredRow = {
  post_id: number
  hook: string | null
  caption: string | null
  format: string | null
  pillar: string | null
  permalink: string | null
  reach: number
  saved: number
  shares: number
  follows: number
  score: number
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function liftBuckets(
  rows: ScoredRow[],
  keyOf: (r: ScoredRow) => string | null,
  overallMedian: number,
): LiftBucket[] {
  const groups = new Map<string, number[]>()
  for (const r of rows) {
    const k = keyOf(r)
    if (!k) continue
    const arr = groups.get(k) || []
    arr.push(r.score)
    groups.set(k, arr)
  }
  return [...groups.entries()]
    .map(([key, scores]) => {
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length
      return {
        key,
        mean_score: mean,
        lift_vs_median: overallMedian > 0 ? mean / overallMedian - 1 : 0,
        count: scores.length,
      }
    })
    .sort((a, b) => b.mean_score - a.mean_score)
}

function toDigestPost(r: ScoredRow): DigestPost {
  const first =
    (r.caption || '')
      .split(/\n/)
      .map((s) => s.trim())
      .find(Boolean) || null
  return {
    post_id: r.post_id,
    hook: r.hook,
    first_line: first,
    format: r.format,
    pillar: r.pillar,
    score: r.score,
    reach: r.reach,
    saved: r.saved,
    shares: r.shares,
    follows: r.follows,
    permalink: r.permalink,
  }
}

export function computePerformanceDigest(brandProfileId: number): DigestResult {
  const rows = db
    .prepare(
      `SELECT p.id AS post_id, p.hook, p.caption, p.format, p.pillar,
              p.instagram_permalink AS permalink,
              m.reach, m.saved, m.shares, m.follows, m.period_label
       FROM posts p
       JOIN ig_media im ON im.post_id = p.id
       JOIN ig_media_metrics m ON m.media_id = im.id
       WHERE p.brand_profile_id = ?
         AND p.status = 'published'
         AND m.reach IS NOT NULL AND m.reach > 0
       ORDER BY p.id ASC, CASE m.period_label WHEN '7d' THEN 0 ELSE 1 END, m.measured_at DESC`,
    )
    .all(brandProfileId) as Array<{
    post_id: number
    hook: string | null
    caption: string | null
    format: string | null
    pillar: string | null
    permalink: string | null
    reach: number
    saved: number | null
    shares: number | null
    follows: number | null
    period_label: string
  }>

  // Prefer 7d metrics; fall back to latest available period per post.
  const best = new Map<number, (typeof rows)[0]>()
  for (const r of rows) {
    const existing = best.get(r.post_id)
    if (!existing) {
      best.set(r.post_id, r)
      continue
    }
    if (existing.period_label !== '7d' && r.period_label === '7d') {
      best.set(r.post_id, r)
    }
  }

  const scored: ScoredRow[] = []
  for (const r of best.values()) {
    const reach = Number(r.reach) || 0
    if (reach <= 0) continue
    const saved = Number(r.saved) || 0
    const shares = Number(r.shares) || 0
    const follows = Number(r.follows) || 0
    const score = (saved + 1.5 * shares + 3 * follows) / reach
    scored.push({
      post_id: r.post_id,
      hook: r.hook,
      caption: r.caption,
      format: r.format,
      pillar: r.pillar,
      permalink: r.permalink,
      reach,
      saved,
      shares,
      follows,
      score,
    })
  }

  // Cap to last 30 scored posts for median / lift
  const recent = scored.slice(-30)
  if (recent.length < 8) {
    return { insufficientData: true, count: recent.length, needed: 8 }
  }

  const med = median(recent.map((r) => r.score))
  const ranked = [...recent].sort((a, b) => b.score - a.score)
  const top = ranked.slice(0, 5).map(toDigestPost)
  const bottom = ranked.slice(-5).reverse().map(toDigestPost)
  const lift_by_format = liftBuckets(recent, (r) => r.format, med)
  const lift_by_pillar = liftBuckets(recent, (r) => r.pillar, med)

  const topFmt = lift_by_format[0]
  const topPost = top[0]
  const finding_line = topFmt
    ? `${topFmt.key} posts are ${(topFmt.lift_vs_median * 100).toFixed(0)}% above your median lift${
        topPost?.hook ? ` — top hook: “${topPost.hook.slice(0, 60)}”` : ''
      }`
    : topPost?.hook
      ? `Top recent hook: “${topPost.hook.slice(0, 80)}”`
      : 'Performance signals are correlational — treat as hints, not proof.'

  const digest: PerformanceDigest = {
    brand_profile_id: brandProfileId,
    correlational: true,
    post_count: recent.length,
    median_score: med,
    top,
    bottom,
    lift_by_format,
    lift_by_pillar,
    finding_line,
  }
  return digest
}

/** Short prose for planner/judge prompts. */
export function summarizeDigestForPrompt(result: DigestResult): string | null {
  if ('insufficientData' in result && result.insufficientData) return null
  const d = result as PerformanceDigest
  const lines = [
    `Performance (correlational, last ${d.post_count} posts): ${d.finding_line}`,
  ]
  if (d.lift_by_format[0]) {
    lines.push(
      `Format lift: ${d.lift_by_format
        .slice(0, 3)
        .map((b) => `${b.key} ${(b.lift_vs_median * 100).toFixed(0)}%`)
        .join(', ')}.`,
    )
  }
  if (d.top[0]?.hook) {
    lines.push(`Strong recent hook: “${d.top[0].hook}”.`)
  }
  lines.push('Suggest at most ±1 change to format mix; do not force changes.')
  return lines.join(' ')
}
