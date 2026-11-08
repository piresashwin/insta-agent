import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import type { BrandContextV2 } from '../generation/brand-context'

process.env.DB_PATH = path.join(os.tmpdir(), `p4-bc-${Math.random().toString(36).slice(2)}.db`)

let renderContext: typeof import('../generation/brand-context').renderContext

beforeAll(async () => {
  const mod = await import('../generation/brand-context')
  renderContext = mod.renderContext
})

function makeCtx(over: Partial<BrandContextV2> = {}): BrandContextV2 {
  return {
    profile: null,
    voiceRules: {},
    voiceText: '',
    examples: [],
    audience: '',
    pillars: [],
    hashtagSets: [],
    visualIdentity: {},
    visualText: '',
    backgroundStyle: null,
    rubric: null,
    recentHooks: [],
    format: 'feed',
    maxSlides: 5,
    timezone: 'UTC',
    ...over,
  }
}

describe('renderPerformance / performance section', () => {
  it('omits performance when summary is empty', () => {
    const out = renderContext(makeCtx({ performanceSummary: null }), ['performance'])
    expect(out).not.toContain('## Performance')
  })

  it('renders performance prose when summary is present', () => {
    const out = renderContext(
      makeCtx({ performanceSummary: 'Reels beat feed by 40% — correlational.' }),
      ['performance'],
    )
    expect(out).toContain('## Performance (correlational)')
    expect(out).toContain('Reels beat feed')
  })

  it('drops performance first under a tight budget', () => {
    const voiceText = 'V'.repeat(200)
    const out = renderContext(
      makeCtx({
        voiceText,
        performanceSummary: 'P'.repeat(200),
      }),
      ['voice', 'performance'],
      250,
    )
    expect(out).toContain('## Voice')
    expect(out).not.toContain('## Performance')
  })
})
