import { describe, it, expect } from 'vitest'
import {
  mediaMetricsFor,
  duePeriodLabels,
  MEDIA_POLL_MAX_MS,
  periodDueAfterMs,
} from '../insights/graph-metrics'

describe('Phase 4 graph-metrics', () => {
  it('mediaMetricsFor uses views and never impressions/plays', () => {
    for (const t of ['FEED', 'REELS', 'CAROUSEL_ALBUM', null]) {
      const m = mediaMetricsFor(t)
      expect(m).toContain('views')
      expect(m).not.toMatch(/\bimpressions\b/)
      expect(m).not.toMatch(/\bplays\b/)
    }
  })

  it('duePeriodLabels returns slots by age and stops after 91d', () => {
    const published = new Date('2026-01-01T00:00:00.000Z')
    expect(duePeriodLabels(published, new Date('2026-01-01T00:30:00.000Z'))).toEqual([])
    expect(duePeriodLabels(published, new Date('2026-01-01T01:00:00.000Z'))).toContain('1h')
    expect(duePeriodLabels(published, new Date('2026-01-02T00:00:00.000Z'))).toEqual(
      expect.arrayContaining(['1h', '6h', '24h']),
    )
    expect(duePeriodLabels(published, new Date('2026-01-08T00:00:00.000Z'))).toContain('7d')
    expect(duePeriodLabels(published, new Date(published.getTime() + MEDIA_POLL_MAX_MS + 1))).toEqual(
      [],
    )
  })

  it('weekly slots map to n*7 days', () => {
    expect(periodDueAfterMs('weekly_5')).toBe(5 * 7 * 24 * 3_600_000)
    expect(periodDueAfterMs('weekly_13')).toBe(13 * 7 * 24 * 3_600_000)
  })
})
