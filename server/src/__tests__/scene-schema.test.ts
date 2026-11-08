import { describe, it, expect } from 'vitest'
import {
  SceneDocSchema,
  defaultSceneDoc,
  upgradeCanvasDoc,
  upgradePostToScene,
  parseSceneJson,
  emptyTokens,
  type CanvasDoc,
} from '@instagram-agent/shared'

function sampleV1(over: Partial<CanvasDoc> = {}): CanvasDoc {
  return {
    version: 1,
    format: 'feed',
    background: { fit: 'cover', focusX: 0.5, focusY: 0.5 },
    scrim: 'bottom',
    layers: [
      {
        id: 'l1',
        type: 'hook',
        text: 'Hello world',
        x: 0.08,
        y: 0.1,
        w: 0.84,
        fontSize: 72,
        align: 'center',
        color: '#ffffff',
        weight: 700,
        shadow: true,
      },
    ],
    safeZone: true,
    ...over,
  }
}

describe('SceneDocSchema', () => {
  it('accepts defaultSceneDoc(feed)', () => {
    const doc = defaultSceneDoc('feed')
    expect(SceneDocSchema.safeParse(doc).success).toBe(true)
  })

  it('accepts a full carousel + reel-shaped docs', () => {
    const carousel = defaultSceneDoc('carousel')
    carousel.pages.push({
      id: 'p_extra',
      background: { kind: 'color', color: '#000' },
      layers: [
        {
          id: 't1',
          type: 'text',
          text: 'Slide 2',
          x: 40,
          y: 40,
          w: 1000,
          h: 200,
          fontSize: 48,
          color: 'token:primary',
        },
      ],
    })
    carousel.tokens = { colors: { primary: '#b8336a' }, fonts: {} }
    expect(SceneDocSchema.safeParse(carousel).success).toBe(true)

    const reel = defaultSceneDoc('reel')
    expect(reel.timeline?.durationSec).toBe(8)
    expect(SceneDocSchema.safeParse(reel).success).toBe(true)
  })

  it('rejects unknown layer type', () => {
    const doc = {
      ...defaultSceneDoc('feed'),
      pages: [
        {
          id: 'p1',
          background: { kind: 'color' as const, color: '#000' },
          layers: [{ id: 'bad', type: 'widget', x: 0, y: 0, w: 10, h: 10 }],
        },
      ],
    }
    expect(SceneDocSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects missing size', () => {
    const doc = defaultSceneDoc('feed') as Record<string, unknown>
    delete doc.size
    expect(SceneDocSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects a text layer with no text', () => {
    const doc = defaultSceneDoc('feed')
    doc.pages[0].layers = [
      {
        id: 't1',
        type: 'text',
        // @ts-expect-error intentional
        text: undefined,
        x: 0,
        y: 0,
        w: 100,
        h: 40,
        fontSize: 24,
        color: '#fff',
      },
    ]
    expect(SceneDocSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects out-of-range opacity', () => {
    const doc = defaultSceneDoc('feed')
    doc.pages[0].layers = [
      {
        id: 't1',
        type: 'text',
        text: 'Hi',
        x: 0,
        y: 0,
        w: 100,
        h: 40,
        fontSize: 24,
        color: '#fff',
        opacity: 1.5,
      },
    ]
    expect(SceneDocSchema.safeParse(doc).success).toBe(false)
  })
})

describe('upgradeCanvasDoc', () => {
  // CanvasDoc is a single-page v1 doc only — carousel slides live in post_slides,
  // so multi-page upgrade is covered by upgradePostToScene (not this function).
  it('maps a v1 canvas_json (text + scrim; image plate is external) → single-page SceneDoc v2', () => {
    const v1 = sampleV1()
    const doc = upgradeCanvasDoc(v1)
    expect(doc.version).toBe(2)
    expect(doc.format).toBe('feed')
    expect(doc.size).toEqual({ w: 1080, h: 1350 })
    expect(doc.pages).toHaveLength(1)
    const types = doc.pages[0].layers.map((l) => l.type)
    expect(types).toContain('text')
    expect(types).toContain('shape')
    const text = doc.pages[0].layers.find((l) => l.type === 'text')
    expect(text && text.type === 'text' && text.text).toBe('Hello world')
    expect(text && 'x' in text && text.x).toBe(Math.round(0.08 * 1080))
  })

  it('is idempotent-safe: version===2 SceneDoc is returned without double-wrapping (explicit guard)', () => {
    const v2 = defaultSceneDoc('feed', emptyTokens())
    const again = upgradeCanvasDoc(v2)
    expect(again.version).toBe(2)
    expect(SceneDocSchema.safeParse(again).success).toBe(true)
    expect(again.pages).toHaveLength(1)
    // Must not invent a nested page from reading .layers on a v2 doc
    expect(again.pages[0].layers).toEqual(v2.pages[0].layers)
  })
})

describe('upgradePostToScene', () => {
  it('joins post_slides into multiple pages (not upgradeCanvasDoc — slides are a separate table)', () => {
    const doc = upgradePostToScene({
      format: 'carousel',
      slides: [
        {
          position: 0,
          canvas_json: JSON.stringify(sampleV1({ format: 'carousel', scrim: 'none' })),
          source_image_url: 'https://example.com/a.jpg',
        },
        {
          position: 1,
          canvas_json: JSON.stringify(sampleV1({ format: 'carousel', scrim: 'none' })),
          source_image_url: 'https://example.com/b.jpg',
        },
      ],
    })
    expect(doc.version).toBe(2)
    expect(doc.format).toBe('carousel')
    expect(doc.pages).toHaveLength(2)
    expect(doc.pages[0].background.kind).toBe('image')
    expect(doc.pages[1].background.kind).toBe('image')
    expect(SceneDocSchema.safeParse(doc).success).toBe(true)
  })
})

describe('parseSceneJson', () => {
  it('returns a validated v2 doc when present', () => {
    const raw = JSON.stringify(defaultSceneDoc('reel'))
    const doc = parseSceneJson(raw, 'reel')
    expect(doc.format).toBe('reel')
    expect(doc.timeline?.durationSec).toBe(8)
  })

  it('upgrades v1 canvas JSON', () => {
    const doc = parseSceneJson(JSON.stringify(sampleV1()), 'feed')
    expect(doc.version).toBe(2)
    expect(doc.pages[0].layers.some((l) => l.type === 'text')).toBe(true)
  })
})
