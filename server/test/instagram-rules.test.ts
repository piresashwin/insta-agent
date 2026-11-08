import { describe, expect, it } from 'vitest'
import {
  IG,
  clampReelDuration,
  findBait,
  fitCaption,
  normalizeHashtags,
  renderedMarginPct,
  stillCropPctPerSide,
} from '../src/instagram-rules'

describe('normalizeHashtags', () => {
  it('prefixes #, dedupes case-insensitively, drops generic tags, caps', () => {
    const out = normalizeHashtags('coffee #Coffee #espresso, homebarista #love latteart pourover brewing', 5)
    expect(out).toBe('#coffee #espresso #homebarista #latteart #pourover')
  })
  it('splits run-together tags and strips punctuation', () => {
    expect(normalizeHashtags('#a1#b2 #c-3!')).toBe('#a1 #b2 #c3')
  })
  it('defaults to IG.hashtagMax', () => {
    const many = Array.from({ length: 20 }, (_, i) => `#tag${i}`).join(' ')
    expect(normalizeHashtags(many).split(' ')).toHaveLength(IG.hashtagMax)
  })
})

describe('fitCaption', () => {
  it('keeps short captions intact', () => {
    expect(fitCaption('Hello world.', '#a #b')).toBe('Hello world.\n\n#a #b')
  })
  it('never exceeds 2200 and never cuts hashtags', () => {
    const sentence = 'This is a reasonably long sentence about espresso extraction. '
    const caption = sentence.repeat(60)
    const tags = '#espresso #homebarista #coffee'
    const out = fitCaption(caption, tags)
    expect(out.length).toBeLessThanOrEqual(IG.captionMax)
    expect(out.endsWith(tags)).toBe(true)
    // trimmed at a sentence boundary
    expect(out.split('\n\n')[0].endsWith('.')).toBe(true)
  })
  it('falls back to word boundary with ellipsis', () => {
    const out = fitCaption('word '.repeat(600), '')
    expect(out.length).toBeLessThanOrEqual(IG.captionMax)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/wor…$/)
  })
})

describe('findBait', () => {
  it('flags demoted bait', () => {
    expect(findBait('Comment YES if you agree')).toHaveLength(1)
    expect(findBait('Tag 3 friends who need this')).toHaveLength(1)
    expect(findBait('Link in bio for more')).toHaveLength(1)
  })
  it('allows genuine CTAs', () => {
    expect(findBait('Save this for your next brew. What grind size do you use?')).toEqual([])
  })
})

describe('reel duration + crop math', () => {
  it('clamps to one clip', () => {
    expect(clampReelDuration(60)).toBe(IG.reelDuration.max)
    expect(clampReelDuration(2)).toBe(IG.reelDuration.min)
    expect(clampReelDuration(undefined)).toBe(IG.reelDuration.default)
    expect(clampReelDuration(9.4)).toBe(9)
  })
  it('computes the 2:3 → 4:5 crop allowance', () => {
    expect(stillCropPctPerSide('1024x1536')).toBeCloseTo(8.33, 1)
    expect(stillCropPctPerSide('1024x1024')).toBe(0)
    // 10% of the final frame ≈ 17% of the rendered 2:3 frame
    expect(renderedMarginPct(10, stillCropPctPerSide('1024x1536'))).toBe(17)
  })
})
