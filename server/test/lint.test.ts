import { describe, expect, it } from 'vitest'
import { lintDraft, type LintInput } from '../src/agent/lint'

const goodFeed: LintInput = {
  format: 'feed',
  hook_on_image: 'Grind finer if your espresso tastes sour',
  caption: 'Sour espresso? Your grind is probably too coarse.\n\nGo one step finer and pull again.',
  first_line: 'Sour espresso? Your grind is probably too coarse.',
  hashtags: '#espresso #homebarista #coffeetips',
  cta: 'Save this for your next shot.',
}

const goodCarousel: LintInput = {
  ...goodFeed,
  format: 'carousel',
  slides: [
    { text: 'Fix sour espresso in 3 steps', role: 'cover' },
    { text: 'Grind one step finer', role: 'step' },
    { text: 'Save this for your next shot', role: 'cta' },
  ],
}

const goodReel: LintInput = {
  ...goodFeed,
  format: 'reel',
  duration_sec: 10,
  beats: [
    { t_start: 0, on_screen_text_intent: 'Sour espresso?' },
    { t_start: 2.5, on_screen_text_intent: 'Grind finer' },
    { t_start: 5, on_screen_text_intent: 'Pull again' },
    { t_start: 7.5, on_screen_text_intent: 'Follow for more' },
  ],
}

describe('lintDraft', () => {
  it('passes clean drafts', () => {
    expect(lintDraft(goodFeed)).toEqual([])
    expect(lintDraft(goodCarousel)).toEqual([])
    expect(lintDraft(goodReel)).toEqual([])
  })

  it('on-image word cap', () => {
    const r = lintDraft({ ...goodFeed, hook_on_image: 'one two three four five six seven eight nine ten eleven twelve thirteen' })
    expect(r.join()).toMatch(/On-image hook has 13 words/)
  })

  it('first line length', () => {
    const r = lintDraft({ ...goodFeed, first_line: 'x'.repeat(130) })
    expect(r.join()).toMatch(/First line is 130 chars/)
  })

  it('caption + hashtags length', () => {
    const r = lintDraft({ ...goodFeed, caption: 'word '.repeat(500) })
    expect(r.join()).toMatch(/Caption \+ hashtags/)
  })

  it('hashtag count + generic tags', () => {
    const r = lintDraft({ ...goodFeed, hashtags: '#a #b #c #d #e #f #love' })
    expect(r.join()).toMatch(/7 hashtags/)
    expect(r.join()).toMatch(/Generic hashtags.*#love/)
  })

  it('engagement bait', () => {
    const r = lintDraft({ ...goodFeed, cta: 'Comment YES below!' })
    expect(r.join()).toMatch(/Engagement bait/)
  })

  it('carousel slide count, cover words, Save/Share CTA', () => {
    const r = lintDraft({
      ...goodCarousel,
      slides: [
        { text: 'one two three four five six seven eight nine ten eleven' },
        { text: 'The end' },
      ],
    })
    const s = r.join(' | ')
    expect(s).toMatch(/Carousel has 2 slides/)
    expect(s).toMatch(/Slide 1 text has 11 words/)
    expect(s).toMatch(/Last carousel slide must say Save or Share/)
  })

  it('reel duration, late hook, beats past clip, gaps', () => {
    const r = lintDraft({
      ...goodReel,
      duration_sec: 30,
      beats: [
        { t_start: 3, on_screen_text_intent: 'Late hook' },
        { t_start: 9, on_screen_text_intent: 'Big gap' },
        { t_start: 31, on_screen_text_intent: 'Past end' },
      ],
    })
    const s = r.join(' | ')
    expect(s).toMatch(/duration 30s outside/)
    expect(s).toMatch(/First beat starts at 3s/)
    expect(s).toMatch(/Gap of 6.0s after beat 1/)
    expect(s).toMatch(/Beat 3 at 31s is past/)
  })
})
