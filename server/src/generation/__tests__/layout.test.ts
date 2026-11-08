import { describe, it, expect } from 'vitest'
import { autoLayout, buildBackgroundPrompt } from '../layout'
import { SceneDocSchema } from '@instagram-agent/shared'

const tokens = {
  colors: {
    primary: '#b8336a',
    secondary: '#444',
    accent: '#e8a838',
    background: '#fbf7f8',
  },
  fonts: { heading: 'DM Sans', body: 'DM Sans' },
}

function collectColors(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectColors(v, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'color' || k === 'fill' || k === 'stroke') && typeof v === 'string') {
        out.push(v)
      } else {
        collectColors(v, out)
      }
    }
  }
  return out
}

describe('autoLayout', () => {
  it('returns a schema-valid SceneDoc with a hook text layer and token: colors', () => {
    const doc = autoLayout({ hook: 'Ship faster' }, tokens, 'feed')
    expect(SceneDocSchema.safeParse(doc).success).toBe(true)
    expect(doc.pages[0].layers.some((l) => l.type === 'text' && l.type === 'text' && l.text === 'Ship faster')).toBe(true)
    expect(doc.pages[0].background.kind).toBe('color')
    for (const c of collectColors(doc)) {
      expect(c.startsWith('token:')).toBe(true)
    }
  })

  it('carousel brief yields the right page count', () => {
    const doc = autoLayout(
      { hook: 'Cover', points: ['A', 'B', 'C'], pageCount: 4 },
      tokens,
      'carousel',
    )
    expect(doc.format).toBe('carousel')
    expect(doc.pages).toHaveLength(4)
    expect(SceneDocSchema.safeParse(doc).success).toBe(true)
  })
})

describe('buildBackgroundPrompt', () => {
  it('includes brand render_style + negative prompt', () => {
    const { prompt, negative, costLabel } = buildBackgroundPrompt({
      brief: 'cozy desk flat lay',
      renderStyle: 'photoreal product',
      negativePrompt: 'no text, no watermark',
      format: 'feed',
    })
    expect(prompt).toContain('photoreal product')
    expect(prompt).toContain('cozy desk flat lay')
    expect(negative).toContain('no text')
    expect(costLabel).toMatch(/\$/)
  })
})
