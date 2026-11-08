import { describe, it, expect } from 'vitest'
import { emptyTokens, type SceneDoc, type SceneTextLayer } from '@instagram-agent/shared'
import { sceneHash, scenePageHash, normalizeScene } from '../hash'

const textLayer = (over: Partial<SceneTextLayer> = {}): SceneTextLayer => ({
  id: 'l_fixed',
  type: 'text',
  text: 'Hello',
  x: 40,
  y: 40,
  w: 1000,
  h: 200,
  fontSize: 64,
  color: '#ffffff',
  ...over,
})

function baseDoc(over: Partial<SceneDoc> = {}): SceneDoc {
  return {
    version: 2,
    format: 'feed',
    size: { w: 1080, h: 1350 },
    tokens: emptyTokens(),
    pages: [
      {
        id: 'p_fixed',
        background: { kind: 'color', color: '#1a1a2e' },
        layers: [textLayer()],
      },
    ],
    ...over,
  }
}

describe('sceneHash', () => {
  it('is stable — same doc twice → same hash', () => {
    const doc = baseDoc()
    expect(sceneHash(doc)).toBe(sceneHash(doc))
    expect(normalizeScene(doc)).toBe(normalizeScene(structuredClone(doc)))
  })

  it('is sensitive — changing text changes the hash', () => {
    const a = baseDoc()
    const b = baseDoc({
      pages: [
        {
          id: 'p_fixed',
          background: { kind: 'color', color: '#1a1a2e' },
          layers: [textLayer({ text: 'Hello!' })],
        },
      ],
    })
    expect(sceneHash(a)).not.toBe(sceneHash(b))
  })

  it('is sensitive — changing color changes the hash', () => {
    const a = baseDoc()
    const b = baseDoc({
      pages: [
        {
          id: 'p_fixed',
          background: { kind: 'color', color: '#1a1a2e' },
          layers: [textLayer({ color: '#ff0000' })],
        },
      ],
    })
    expect(sceneHash(a)).not.toBe(sceneHash(b))
  })

  it('resolves tokens before hashing (same resolved colour → same hash)', () => {
    const tokens = { colors: { primary: '#b8336a' }, fonts: {} }
    const a = baseDoc({
      tokens,
      pages: [
        {
          id: 'p_fixed',
          background: { kind: 'color', color: 'token:primary' },
          layers: [],
        },
      ],
    })
    const b = baseDoc({
      tokens,
      pages: [
        {
          id: 'p_fixed',
          background: { kind: 'color', color: '#b8336a' },
          layers: [],
        },
      ],
    })
    expect(sceneHash(a)).toBe(sceneHash(b))
  })

  it('scenePageHash is per-page content (different pages → different hashes)', () => {
    const doc = baseDoc({
      format: 'carousel',
      pages: [
        { id: 'p0', background: { kind: 'color', color: '#111111' }, layers: [textLayer({ text: 'One' })] },
        { id: 'p1', background: { kind: 'color', color: '#222222' }, layers: [textLayer({ text: 'Two' })] },
      ],
    })
    expect(scenePageHash(doc, 0)).not.toBe(scenePageHash(doc, 1))
  })

  it('scenePageHash is stable for an unchanged page when another page changes', () => {
    const page0 = { id: 'p0', background: { kind: 'color' as const, color: '#111111' }, layers: [textLayer({ text: 'One' })] }
    const before = baseDoc({
      format: 'carousel',
      pages: [page0, { id: 'p1', background: { kind: 'color', color: '#222222' }, layers: [textLayer({ text: 'Two' })] }],
    })
    const after = baseDoc({
      format: 'carousel',
      pages: [page0, { id: 'p1', background: { kind: 'color', color: '#222222' }, layers: [textLayer({ text: 'EDITED' })] }],
    })
    // Page 0 is untouched → its hash must not change even though page 1 did.
    expect(scenePageHash(after, 0)).toBe(scenePageHash(before, 0))
    expect(scenePageHash(after, 1)).not.toBe(scenePageHash(before, 1))
  })
})
