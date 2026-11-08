import { describe, it, expect } from 'vitest'
import { lintDraft } from '../agent/lint'

describe('lintDraft', () => {
  it('passes a valid feed post', () => {
    const errors = lintDraft({
      format: 'feed',
      caption: 'Short caption that is definitely under the limit.',
      first_line: 'Short hook line.',
      hashtags: '#lifestyle #wellness #health',
    })
    expect(errors).toHaveLength(0)
  })

  it('flags an empty caption', () => {
    const errors = lintDraft({ format: 'feed', caption: '', hashtags: '#test' })
    expect(errors.some((e) => /caption is empty/i.test(e))).toBe(true)
  })

  it('flags a first line over 125 chars', () => {
    const longLine = 'A'.repeat(130)
    const errors = lintDraft({ format: 'feed', caption: longLine, first_line: longLine, hashtags: '#test' })
    expect(errors.some((e) => /first line/i.test(e))).toBe(true)
  })

  it('flags too many hashtags', () => {
    const tags = Array.from({ length: 32 }, (_, i) => `#tag${i}`).join(' ')
    const errors = lintDraft({ format: 'feed', caption: 'Caption.', hashtags: tags })
    expect(errors.some((e) => /hashtag/i.test(e))).toBe(true)
  })

  it('flags caption + hashtags over 2200 chars', () => {
    const longCaption = 'Word '.repeat(450)  // ~2250 chars
    const errors = lintDraft({ format: 'feed', caption: longCaption, hashtags: '#tag' })
    expect(errors.some((e) => /2200|captionMax/i.test(e) || /chars/i.test(e))).toBe(true)
  })

  it('flags engagement bait', () => {
    const errors = lintDraft({
      format: 'feed',
      caption: 'Follow for more tips!',
      hashtags: '#test',
      cta: 'Tag a friend who needs this',
    })
    expect(errors.some((e) => /bait/i.test(e))).toBe(true)
  })

  it('flags a carousel with too many slides', () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({ text: `Slide ${i}` }))
    const errors = lintDraft({ format: 'carousel', caption: 'Caption.', hashtags: '#tag', slides })
    expect(errors.some((e) => /slides/i.test(e))).toBe(true)
  })

  it('flags on-image text over 12 words', () => {
    const longHook = Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ')
    const errors = lintDraft({
      format: 'feed',
      caption: 'Caption.',
      hashtags: '#tag',
      hook_on_image: longHook,
    })
    expect(errors.some((e) => /on-image/i.test(e))).toBe(true)
  })
})
