import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import type { BrandContextV2 } from '../generation/brand-context'

// brand-context imports the db singleton, which opens a SQLite file on load.
// Point it at a throwaway file so the suite is hermetic and never contends on
// the real content-agent.db under parallel workers. Set before the dynamic
// import below (a static import would be hoisted and open the db too early).
process.env.DB_PATH = path.join(os.tmpdir(), `bc-test-${Math.random().toString(36).slice(2)}.db`)

let renderContext: typeof import('../generation/brand-context').renderContext
let assertVisualIdentityReady: typeof import('../generation/brand-context').assertVisualIdentityReady

beforeAll(async () => {
  const mod = await import('../generation/brand-context')
  renderContext = mod.renderContext
  assertVisualIdentityReady = mod.assertVisualIdentityReady
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

describe('renderContext', () => {
  it('returns an empty string when the context has no content', () => {
    expect(renderContext(makeCtx())).toBe('')
  })

  it('renders the sections that have content', () => {
    const ctx = makeCtx({
      voiceText: 'Calm, practical, no hype.',
      audience: 'Remote workers who brew at home.',
      visualText: 'Warm neutrals, flat-lay brew gear.',
    })
    const out = renderContext(ctx)
    expect(out).toContain('## Voice')
    expect(out).toContain('## Brand')
    expect(out).toContain('## Visual identity')
  })

  it('orders priority-1 sections (voice/audience/visual) before priority-2 (examples)', () => {
    const ctx = makeCtx({
      voiceText: 'Calm and practical.',
      audience: 'Home baristas.',
      visualText: 'Warm neutrals.',
      examples: [{ hook: 'Grind finer if it tastes sour', what_works: 'Specific fix' }],
    })
    const out = renderContext(ctx, ['voice', 'audience', 'examples', 'visual'])
    expect(out.indexOf('## Voice')).toBeLessThan(out.indexOf('## Examples'))
    expect(out.indexOf('## Brand')).toBeLessThan(out.indexOf('## Examples'))
    expect(out.indexOf('## Visual identity')).toBeLessThan(out.indexOf('## Examples'))
  })

  it('drops whole low-priority sections when over budget, never truncating mid-section', () => {
    const voiceText = 'V'.repeat(300)
    const exampleHook = 'E'.repeat(300)
    const ctx = makeCtx({
      voiceText,
      examples: [{ hook: exampleHook }],
    })
    // Budget fits the priority-1 voice section but not the priority-2 examples section.
    const out = renderContext(ctx, ['voice', 'examples'], 350)
    expect(out).toContain('## Voice')
    expect(out).toContain(voiceText) // kept section is intact, not truncated
    expect(out).not.toContain('## Examples') // whole section dropped
    expect(out).not.toContain(exampleHook)
  })
})

describe('assertVisualIdentityReady', () => {
  it('throws 422 when the palette is empty', () => {
    const ctx = makeCtx({ visualIdentity: { palette: {}, render_style: 'photoreal' } })
    try {
      assertVisualIdentityReady(ctx)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as Error & { status?: number }).status).toBe(422)
      expect((e as Error).message).toMatch(/palette/i)
    }
  })

  it('throws 422 when render_style is missing', () => {
    const ctx = makeCtx({ visualIdentity: { palette: { primary: '#111827' } } })
    try {
      assertVisualIdentityReady(ctx)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as Error & { status?: number }).status).toBe(422)
      expect((e as Error).message).toMatch(/render_style/i)
    }
  })

  it('passes when both a palette colour and render_style are present', () => {
    const ctx = makeCtx({
      visualIdentity: { palette: { primary: '#111827' }, render_style: 'photoreal' },
    })
    expect(() => assertVisualIdentityReady(ctx)).not.toThrow()
  })
})
