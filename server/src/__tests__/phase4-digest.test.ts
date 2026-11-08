import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `p4-digest-${Math.random().toString(36).slice(2)}.db`)

let computePerformanceDigest: typeof import('../insights/digest').computePerformanceDigest
let summarizeDigestForPrompt: typeof import('../insights/digest').summarizeDigestForPrompt
let db: typeof import('../db').default

beforeAll(async () => {
  db = (await import('../db')).default
  const mod = await import('../insights/digest')
  computePerformanceDigest = mod.computePerformanceDigest
  summarizeDigestForPrompt = mod.summarizeDigestForPrompt
})

function seedBrand(): number {
  return Number(
    db.prepare(`INSERT INTO brand_profiles (name) VALUES ('Digest Brand')`).run().lastInsertRowid,
  )
}

function seedScoredPost(opts: {
  brandId: number
  hook: string
  format: string
  pillar: string
  reach: number
  saved: number
  shares: number
  follows: number
  period?: string
}): number {
  const postId = Number(
    db
      .prepare(
        `INSERT INTO posts (status, format, hook, caption, pillar, brand_profile_id, account_id, instagram_media_id)
         VALUES ('published', ?, ?, 'First line of caption', ?, ?, 'acct1', ?)`,
      )
      .run(
        opts.format,
        opts.hook,
        opts.pillar,
        opts.brandId,
        `media_${Math.random().toString(36).slice(2)}`,
      ).lastInsertRowid,
  )
  const mediaId = (
    db.prepare('SELECT instagram_media_id FROM posts WHERE id = ?').get(postId) as {
      instagram_media_id: string
    }
  ).instagram_media_id
  db.prepare(
    `INSERT INTO ig_media (id, account_id, post_id, media_product_type, timestamp, is_imported)
     VALUES (?, 'acct1', ?, 'FEED', CURRENT_TIMESTAMP, 0)`,
  ).run(mediaId, postId)
  db.prepare(
    `INSERT INTO ig_media_metrics (media_id, period_label, measured_at, reach, saved, shares, follows)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
  ).run(mediaId, opts.period ?? '7d', opts.reach, opts.saved, opts.shares, opts.follows)
  return postId
}

describe('computePerformanceDigest', () => {
  it('returns insufficientData under 8 scored posts', () => {
    const brandId = seedBrand()
    for (let i = 0; i < 5; i++) {
      seedScoredPost({
        brandId,
        hook: `h${i}`,
        format: 'feed',
        pillar: 'edu',
        reach: 100,
        saved: 10,
        shares: 2,
        follows: 1,
      })
    }
    const result = computePerformanceDigest(brandId)
    expect(result).toMatchObject({ insufficientData: true, count: 5, needed: 8 })
    expect(summarizeDigestForPrompt(result)).toBeNull()
  })

  it('excludes reach=0 from scoring without crashing', () => {
    const brandId = seedBrand()
    seedScoredPost({
      brandId,
      hook: 'zero',
      format: 'feed',
      pillar: 'edu',
      reach: 0,
      saved: 99,
      shares: 9,
      follows: 9,
    })
    for (let i = 0; i < 8; i++) {
      seedScoredPost({
        brandId,
        hook: `ok${i}`,
        format: i % 2 === 0 ? 'reel' : 'feed',
        pillar: 'edu',
        reach: 100,
        saved: 10 + i,
        shares: 1,
        follows: 0,
      })
    }
    const result = computePerformanceDigest(brandId)
    expect('insufficientData' in result && result.insufficientData).toBeFalsy()
    if ('post_count' in result) {
      expect(result.post_count).toBe(8)
      expect(result.correlational).toBe(true)
      expect(result.top).toHaveLength(5)
      expect(result.bottom).toHaveLength(5)
    }
  })

  it('ranks top/bottom and reports format lift with ≥8 posts', () => {
    const brandId = seedBrand()
    // Reels get higher lift (more saves/shares relative to reach)
    for (let i = 0; i < 5; i++) {
      seedScoredPost({
        brandId,
        hook: `reel-hook-${i}`,
        format: 'reel',
        pillar: 'product',
        reach: 100,
        saved: 40,
        shares: 10,
        follows: 5,
      })
    }
    for (let i = 0; i < 5; i++) {
      seedScoredPost({
        brandId,
        hook: `feed-hook-${i}`,
        format: 'feed',
        pillar: 'edu',
        reach: 200,
        saved: 2,
        shares: 0,
        follows: 0,
      })
    }
    const result = computePerformanceDigest(brandId)
    expect('insufficientData' in result).toBe(false)
    if (!('top' in result)) throw new Error('expected digest')
    expect(result.top[0]!.format).toBe('reel')
    expect(result.lift_by_format.find((b) => b.key === 'reel')!.lift_vs_median).toBeGreaterThan(0)
    expect(result.finding_line.length).toBeGreaterThan(0)
    const summary = summarizeDigestForPrompt(result)
    expect(summary).toContain('correlational')
    expect(summary).toMatch(/±1/)
  })
})
