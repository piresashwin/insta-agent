import { describe, it, expect } from 'vitest'
import { safeZones } from '@instagram-agent/shared'

describe('safeZones', () => {
  it('reel: unsafe bands match the REEL_SAFE percentages', () => {
    const z = safeZones('reel', { w: 1080, h: 1920 })
    expect(z.unsafe).toHaveLength(3)

    const top = z.unsafe.find((r) => r.y === 0 && r.h !== 1920)
    const bottom = z.unsafe.find((r) => r.y !== 0 && r.w === 1080)
    const right = z.unsafe.find((r) => r.h === 1920)

    expect(top).toEqual({ x: 0, y: 0, w: 1080, h: 268.8 }) // 14% of 1920
    expect(bottom).toEqual({ x: 0, y: 1920 - 672, w: 1080, h: 672 }) // 35% of 1920
    expect(right).toEqual({ x: 1080 - 108, y: 0, w: 108, h: 1920 }) // 10% of 1080
  })

  it('reel: safeContent excludes the unsafe bands', () => {
    const z = safeZones('reel', { w: 1080, h: 1920 })
    // side = 6% of 1080 = 64.8
    expect(z.safeContent.x).toBeCloseTo(64.8)
    expect(z.safeContent.y).toBeCloseTo(268.8)
    expect(z.safeContent.w).toBeCloseTo(1080 - 64.8 - 108)
    expect(z.safeContent.h).toBeCloseTo(1920 - 268.8 - 672)
  })

  it('feed: a centered safe-content inset, no reel chrome', () => {
    const z = safeZones('feed', { w: 1080, h: 1350 })
    expect(z.unsafe).toEqual([])
    // 10% margin each side
    expect(z.safeContent).toEqual({ x: 108, y: 135, w: 1080 - 216, h: 1350 - 270 })
  })

  it('carousel: same treatment as feed', () => {
    const feed = safeZones('feed', { w: 1080, h: 1350 })
    const carousel = safeZones('carousel', { w: 1080, h: 1350 })
    expect(carousel).toEqual(feed)
  })

  it('every returned rect stays within the canvas bounds', () => {
    for (const format of ['feed', 'carousel', 'reel'] as const) {
      const size = format === 'reel' ? { w: 1080, h: 1920 } : { w: 1080, h: 1350 }
      const z = safeZones(format, size)
      for (const r of [z.safeContent, ...z.unsafe]) {
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(size.w + 0.001)
        expect(r.y + r.h).toBeLessThanOrEqual(size.h + 0.001)
      }
    }
  })
})
