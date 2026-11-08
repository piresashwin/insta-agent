import { describe, expect, it } from 'vitest'
import type { CarouselPromptVars, FeedPromptVars, ReelPromptVars } from '@instagram-agent/shared'
import {
  REEL_PROMPT_MAX,
  compileCarouselPlate,
  compileFeedPlate,
  compileReelPlate,
} from '../src/prompts/format-templates'

const feed: FeedPromptVars = {
  format: 'feed',
  hook_on_image: 'Grind finer if espresso tastes sour',
  caption: '',
  hashtags: '',
  subject: 'espresso puck and grinder dial on a counter',
  setting: 'home kitchen',
  lighting: 'soft window light',
  palette: 'cream, espresso brown',
  font: 'Inter',
  scrim: 'bottom',
  aspect: '4:5',
  negative: '',
} as FeedPromptVars

const reel: ReelPromptVars = {
  format: 'reel',
  duration: 12,
  aspect: '9:16',
  font: 'Inter',
  palette: 'cream, espresso brown',
  scrim: 'bottom',
  negative: '',
  caption: '',
  hashtags: '',
  motion_brief: 'Slow push-in on an espresso machine pulling a shot. '.repeat(30),
  beat_visuals: [
    { t: 0, visual: 'sour face sipping espresso' },
    { t: 3, visual: 'grinder dial turned finer' },
    { t: 6, visual: 'fresh shot pouring' },
    { t: 9, visual: 'smile, thumbs up' },
  ],
  timed_cues: [
    { text: 'Sour espresso?', startSec: 0, endSec: 3 },
    { text: 'Grind one step finer', startSec: 3, endSec: 6 },
    { text: 'Pull again', startSec: 6, endSec: 9 },
    { text: 'Follow for more fixes', startSec: 9, endSec: 12 },
  ],
}

describe('compileReelPlate', () => {
  it('lists every cue window, real duration, and stays under budget', () => {
    const out = compileReelPlate(reel, {}, { angle: 'beginner home barista', brandHandle: '@brewlab' })
    expect(out.length).toBeLessThanOrEqual(REEL_PROMPT_MAX)
    expect(out).toContain('exactly 12s')
    expect(out).toContain('0–3s: "Sour espresso?"')
    expect(out).toContain('3–6s: "Grind one step finer"')
    expect(out).toContain('6–9s: "Pull again"')
    expect(out).toContain('9–12s: "Follow for more fixes"')
    // typography + negative never trimmed
    expect(out).toContain('Reels safe zone')
    expect(out).toContain('Also avoid:')
  })
  it('clamps an out-of-range duration to one clip', () => {
    expect(compileReelPlate({ ...reel, duration: 60 })).toContain('exactly 15s')
  })
  it('uses reel placement, not the feed lower band', () => {
    const out = compileReelPlate(reel)
    expect(out).not.toContain('lower-middle band')
    expect(out).toMatch(/NOTHING in the bottom 35%/)
  })
})

describe('feed/carousel crop allowance', () => {
  it('adds the 4:5 crop note and converted margins', () => {
    const out = compileFeedPlate(feed)
    expect(out).toContain('CROP NOTE')
    expect(out).toMatch(/≥18% from the bottom edge/)
  })
  it('handle margin accounts for crop', () => {
    const out = compileFeedPlate(feed, {}, { brandHandle: '@brewlab' })
    expect(out).toMatch(/"@brewlab".*≥13% from the top edge/)
  })
  it('render style comes from identity', () => {
    expect(compileFeedPlate(feed)).toContain('photoreal')
    expect(compileFeedPlate(feed, { render_style: 'flat vector illustration' })).toContain(
      'flat vector illustration'
    )
  })
})

describe('brand mark', () => {
  it('no cross unless the brand opts in, and the negative stays consistent', () => {
    const none = compileFeedPlate(feed, {}, {})
    expect(none).not.toContain('cross emblem')
    expect(none).toContain('crosses/emblems')
    const withMark = compileFeedPlate(feed, { brand_mark: 'cross' }, { brandMark: 'cross' })
    expect(withMark).toContain('cross emblem')
    expect(withMark).not.toContain('crosses/emblems')
  })
})

describe('carousel series continuity', () => {
  it('every slide carries the same series descriptor', () => {
    const vars: CarouselPromptVars = {
      format: 'carousel',
      slide_count: 3,
      slides: [
        { on_image_text: 'Fix sour espresso', role: 'cover', visual_subject: 'espresso bar flat lay' },
        { on_image_text: 'Grind finer', role: 'step', visual_subject: 'grinder dial' },
        { on_image_text: 'Save this', role: 'cta', visual_subject: 'finished latte' },
      ],
      palette: 'cream, espresso brown',
      font: 'Inter',
      scrim: 'bottom',
      aspect: '4:5',
      negative: '',
      caption: '',
      hashtags: '',
    }
    const plates = [0, 1, 2].map((i) => compileCarouselPlate(vars, i))
    for (const p of plates) {
      expect(p).toContain('SERIES CONTINUITY')
      expect(p).toContain('Shared subject world from slide 1: espresso bar flat lay')
    }
  })
})
