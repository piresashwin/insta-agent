import { describe, it, expect } from 'vitest'
import { runChecks, findForbiddenTerms } from './checks'
import type { PipelineDraft } from '../src/generation/pipeline'
import type { BrandContextV2 } from '../src/generation/brand-context'

function makeDraft(over: Partial<PipelineDraft> = {}): PipelineDraft {
  return {
    hook: 'Grind finer if your espresso tastes sour',
    hookOnImage: 'Grind finer if it tastes sour',
    caption:
      'Sour espresso usually means the grind is too coarse.\n\nTighten it two notches and pull again.',
    firstLine: 'Sour espresso usually means the grind is too coarse.',
    cta: 'Save this for your next brew',
    hashtags: '#espresso #homebrew #coffeeritual',
    altText: 'A tamped espresso portafilter on a wooden counter',
    altHooks: [],
    format: 'feed',
    ...over,
  }
}

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

function result(results: ReturnType<typeof runChecks>, id: string) {
  return results.find((r) => r.id === id)
}

describe('runChecks', () => {
  it('passes a clean feed draft on every applicable check', () => {
    const results = runChecks(makeDraft(), makeCtx())
    expect(result(results, 'ig_lint')?.passed).toBe(true)
    expect(result(results, 'cta_present')?.passed).toBe(true)
    expect(result(results, 'banned_words')?.passed).toBe(true)
    expect(result(results, 'duplicate_hook')?.passed).toBe(true)
  })

  it('flags banned words from the brand voice rules', () => {
    const results = runChecks(
      makeDraft({ caption: 'Rise and hustle — grind harder every morning.' }),
      makeCtx({ voiceRules: { banned_words: ['hustle'] } }),
    )
    const banned = result(results, 'banned_words')
    expect(banned?.passed).toBe(false)
    expect(banned?.detail).toMatch(/hustle/)
  })

  it('enforces an emoji policy of "none"', () => {
    const results = runChecks(
      makeDraft({ caption: 'Dial in your espresso today ☕️🔥' }),
      makeCtx({ voiceRules: { emoji_policy: 'none' } }),
    )
    expect(result(results, 'emoji_policy')?.passed).toBe(false)
  })

  it('omits the emoji check when no policy is set', () => {
    const results = runChecks(makeDraft({ caption: 'Dial it in ☕️' }), makeCtx())
    expect(result(results, 'emoji_policy')).toBeUndefined()
  })

  it('flags a near-duplicate hook against recent hooks (trigram Jaccard > 0.6)', () => {
    const results = runChecks(
      makeDraft({ hook: 'Grind finer if your espresso tastes sour' }),
      makeCtx({ recentHooks: ['Grind finer when your espresso tastes sour'] }),
    )
    expect(result(results, 'duplicate_hook')?.passed).toBe(false)
  })

  it('allows a distinct hook', () => {
    const results = runChecks(
      makeDraft({ hook: 'Three ways to froth milk without a steam wand' }),
      makeCtx({ recentHooks: ['Grind finer if your espresso tastes sour'] }),
    )
    expect(result(results, 'duplicate_hook')?.passed).toBe(true)
  })
})

describe('findForbiddenTerms', () => {
  it('detects forbidden terms case-insensitively across draft fields', () => {
    const draft = makeDraft({ caption: 'Let Scripture guide your morning brew.' })
    expect(findForbiddenTerms(draft, ['scripture', 'prayer'])).toEqual(['scripture'])
  })

  it('returns an empty array when the draft is clean', () => {
    expect(findForbiddenTerms(makeDraft(), ['scripture', 'prayer'])).toEqual([])
  })

  it('scans slide text too', () => {
    const draft = makeDraft({
      format: 'carousel',
      slides: [{ text: 'Start with a prayer' }, { text: 'Then pour' }],
    })
    expect(findForbiddenTerms(draft, ['prayer'])).toEqual(['prayer'])
  })
})
