import { describe, it, expect } from 'vitest'
import {
  TEMPLATE_CATALOG,
  buildTemplate,
  SceneDocSchema,
  type TemplateId,
} from '@instagram-agent/shared'

const tokens = {
  colors: {
    primary: '#b8336a',
    secondary: '#4a4a4a',
    accent: '#e8a838',
    background: '#fbf7f8',
  },
  fonts: {
    heading: '"DM Sans", sans-serif',
  },
}

function collectColors(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (
      value.startsWith('#') ||
      value.startsWith('rgb') ||
      value.startsWith('token:') ||
      value.startsWith('rgba')
    ) {
      // Heuristic: only track fields that look like colors via parent walk below
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) collectColors(v, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (
        (k === 'color' || k === 'fill' || k === 'stroke') &&
        typeof v === 'string'
      ) {
        out.push(v)
      } else if (k === 'stops' && Array.isArray(v)) {
        for (const stop of v) {
          if (stop && typeof stop === 'object' && typeof (stop as { color?: string }).color === 'string') {
            out.push((stop as { color: string }).color)
          }
        }
      } else {
        collectColors(v, out)
      }
    }
  }
  return out
}

describe('templates', () => {
  it('every factory returns a schema-valid doc using only token: colors', () => {
    for (const meta of TEMPLATE_CATALOG) {
      const format = meta.formats[0]
      const doc = buildTemplate(meta.id as TemplateId, format, tokens)
      const parsed = SceneDocSchema.safeParse(doc)
      expect(parsed.success, meta.id).toBe(true)

      const colors = collectColors(doc)
      for (const c of colors) {
        expect(c.startsWith('token:'), `${meta.id} color ${c}`).toBe(true)
      }
    }
  })
})
