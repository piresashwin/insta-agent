import { describe, expect, it } from 'vitest'
import { compactZodHint } from '../skills/model'
import {
  IdeaBatchSchema,
  normalizeIdeaFormat,
  normalizeIdeaRow,
} from '../skills/idea-generation'

describe('compactZodHint nested objects', () => {
  it('expands idea_batch field keys (not just ideas: item[])', () => {
    const hint = compactZodHint(IdeaBatchSchema, 'idea_batch')
    expect(hint).toContain('"topic": string')
    expect(hint).toContain('"angle": string')
    expect(hint).toContain('enum(feed|reel|carousel)')
    expect(hint).toContain('"hooks": string[2-3]')
    expect(hint).toContain('"why": string')
    expect(hint).not.toMatch(/"ideas": item/)
  })
})

describe('normalizeIdeaFormat', () => {
  it('maps free-form phrases to feed|reel|carousel', () => {
    expect(normalizeIdeaFormat('Instagram carousel')).toBe('carousel')
    expect(normalizeIdeaFormat('Saveable carousel')).toBe('carousel')
    expect(normalizeIdeaFormat('Reel with voiceover')).toBe('reel')
    expect(normalizeIdeaFormat('Annotated Scripture graphic')).toBe('feed')
    expect(normalizeIdeaFormat('feed')).toBe('feed')
  })
})

describe('IdeaBatchSchema resilience', () => {
  it('accepts alias keys and free-form format', () => {
    const parsed = IdeaBatchSchema.parse({
      ideas: [
        {
          title: 'Quiet morning prayer habit',
          approach: 'Show the before/after of the room',
          format: 'Scripture study carousel',
          hooks: ['Start with one quiet minute', 'The habit nobody sees'],
          reason: 'Matches contemplative voice',
        },
      ],
    })
    expect(parsed.ideas[0]).toMatchObject({
      topic: 'Quiet morning prayer habit',
      angle: 'Show the before/after of the room',
      format: 'carousel',
      why: 'Matches contemplative voice',
    })
  })

  it('normalizeIdeaRow leaves unknown shapes for zod to reject', () => {
    expect(normalizeIdeaRow(null)).toBeNull()
    expect(normalizeIdeaRow('x')).toBe('x')
  })
})
