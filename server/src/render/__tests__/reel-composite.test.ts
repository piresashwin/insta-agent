import { describe, it, expect } from 'vitest'
import { buildOverlayFilter, overlayWindows } from '../reel-composite'
import { defaultSceneDoc, newLayerId, type SceneDoc, type SceneTextLayer } from '@instagram-agent/shared'

describe('buildOverlayFilter', () => {
  it('emits between(t,a,b) windows matching each timed layer, in order', () => {
    const filter = buildOverlayFilter([
      { inputIndex: 1, start: 0.5, end: 2.0 },
      { inputIndex: 2, start: 2.0, end: 4.5 },
    ])
    expect(filter).toContain("enable='between(t,0.5,2)'")
    expect(filter).toContain("enable='between(t,2,4.5)'")
    expect(filter.indexOf('between(t,0.5,2)')).toBeLessThan(filter.indexOf('between(t,2,4.5)'))
    expect(filter).toContain('[1:v]')
    expect(filter).toContain('[2:v]')
    expect(filter.endsWith('[vout]')).toBe(true)
  })

  it('handles a single-beat timeline', () => {
    const filter = buildOverlayFilter([{ inputIndex: 1, start: 0, end: 8 }])
    expect(filter).toBe("[0:v][1:v]overlay=0:0:enable='between(t,0,8)'[vout]")
  })

  it('returns null filter when there are no overlays', () => {
    expect(buildOverlayFilter([])).toBe('null')
  })
})

describe('overlayWindows', () => {
  const layer = (over: Partial<SceneTextLayer>): SceneTextLayer => ({
    id: newLayerId(),
    type: 'text',
    text: 'x',
    x: 0,
    y: 0,
    w: 100,
    h: 40,
    fontSize: 32,
    color: '#fff',
    ...over,
  })

  function reel(layers: SceneTextLayer[], durationSec = 8): SceneDoc {
    return {
      ...defaultSceneDoc('reel'),
      timeline: { durationSec, coverFrameSec: 0 },
      pages: [{ id: 'p1', background: { kind: 'color', color: '#000' }, layers }],
    }
  }

  it('produces one window per visible layer, timed by startSec/endSec', () => {
    const a = layer({ startSec: 1, endSec: 3 })
    const b = layer({ startSec: 4, endSec: 6 })
    const wins = overlayWindows(reel([a, b]))
    expect(wins).toEqual([
      { layerId: a.id, start: 1, end: 3 },
      { layerId: b.id, start: 4, end: 6 },
    ])
  })

  it('treats an untimed layer as spanning the whole clip', () => {
    const a = layer({})
    const wins = overlayWindows(reel([a], 10))
    expect(wins).toEqual([{ layerId: a.id, start: 0, end: 10 }])
  })

  it('clamps timing to [0, duration] and drops zero-length / hidden layers', () => {
    const over = layer({ startSec: -2, endSec: 99 }) // clamps to 0..8
    const zero = layer({ startSec: 5, endSec: 5 }) // dropped
    const hidden = layer({ startSec: 1, endSec: 2, visible: false }) // dropped
    const wins = overlayWindows(reel([over, zero, hidden]))
    expect(wins).toEqual([{ layerId: over.id, start: 0, end: 8 }])
  })
})
