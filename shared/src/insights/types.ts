/** Phase 4 — insights + performance digest shapes (server + client). */

export type MediaMetricsRow = {
  media_id: string
  period_label: string
  measured_at: string
  views: number | null
  reach: number | null
  saved: number | null
  shares: number | null
  likes: number | null
  comments: number | null
  total_interactions: number | null
  profile_visits: number | null
  follows: number | null
  watch_time: number | null
}

export type AccountMetricsDailyRow = {
  account_id: string
  date: string
  followers: number | null
  reach: number | null
  views: number | null
  accounts_engaged: number | null
  link_taps: number | null
  final: boolean
}

export type AudienceSnapshot = {
  account_id: string
  captured_at: string
  follower_count_at_capture: number | null
  demographics_json: string | null
}

export type DigestPost = {
  post_id: number
  hook: string | null
  first_line: string | null
  format: string | null
  pillar: string | null
  score: number
  reach: number
  saved: number
  shares: number
  follows: number
  permalink: string | null
}

export type LiftBucket = {
  key: string
  mean_score: number
  lift_vs_median: number
  count: number
}

export type PerformanceDigest = {
  brand_profile_id: number
  correlational: true
  post_count: number
  median_score: number
  top: DigestPost[]
  bottom: DigestPost[]
  lift_by_format: LiftBucket[]
  lift_by_pillar: LiftBucket[]
  finding_line: string
}

export type InsufficientDigest = {
  insufficientData: true
  count: number
  needed: number
}

export type DigestResult = PerformanceDigest | InsufficientDigest

export function isInsufficientDigest(d: DigestResult): d is InsufficientDigest {
  return 'insufficientData' in d && d.insufficientData === true
}
