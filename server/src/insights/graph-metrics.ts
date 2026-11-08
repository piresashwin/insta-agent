/**
 * Phase 4 — Instagram insights metric sets (views, not deprecated impressions/plays).
 */

export function mediaMetricsFor(mediaProductType: string | null | undefined): string {
  const t = (mediaProductType || '').toUpperCase()
  // FEED / CAROUSEL_ALBUM / REELS — current Graph API uses `views` for all.
  void t
  return [
    'views',
    'reach',
    'saved',
    'shares',
    'likes',
    'comments',
    'total_interactions',
    'profile_visits',
    'follows',
  ].join(',')
}

export function accountMetricsFields(): string {
  return [
    'reach',
    'views',
    'accounts_engaged',
    'likes',
    'comments',
    'shares',
    'saves',
    'follower_count',
  ].join(',')
}

/** Period slots for per-post insight polling (F5). */
export const MEDIA_PERIOD_SLOTS = [
  '1h',
  '6h',
  '24h',
  '72h',
  '7d',
  '28d',
  ...Array.from({ length: 9 }, (_, i) => `weekly_${i + 5}`), // weekly_5 .. weekly_13
] as const

export type MediaPeriodLabel = (typeof MEDIA_PERIOD_SLOTS)[number]

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Elapsed ms required before each slot is due. */
export function periodDueAfterMs(label: string): number | null {
  if (label === '1h') return 1 * HOUR_MS
  if (label === '6h') return 6 * HOUR_MS
  if (label === '24h') return 24 * HOUR_MS
  if (label === '72h') return 72 * HOUR_MS
  if (label === '7d') return 7 * DAY_MS
  if (label === '28d') return 28 * DAY_MS
  const m = /^weekly_(\d+)$/.exec(label)
  if (m) {
    const n = Number(m[1])
    return n * 7 * DAY_MS
  }
  return null
}

/** Max age we keep polling (91 days ≈ weekly_13). */
export const MEDIA_POLL_MAX_MS = 91 * DAY_MS

export function duePeriodLabels(publishedAt: Date, now = new Date()): string[] {
  const elapsed = now.getTime() - publishedAt.getTime()
  if (elapsed < 0 || elapsed > MEDIA_POLL_MAX_MS) return []
  return MEDIA_PERIOD_SLOTS.filter((label) => {
    const due = periodDueAfterMs(label)
    return due != null && elapsed >= due
  })
}

export class RateLimitError extends Error {
  readonly status = 429
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}
