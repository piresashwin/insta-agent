import { describe, it, expect } from 'vitest'
import {
  snapLayer,
  reorder,
  duplicateLayer,
  reorderPages,
  duplicatePage,
  createHistory,
  pushHistory,
  undoHistory,
  redoHistory,
  historyCurrent,
  canUndo,
  canRedo,
  offBrandColors,
  defaultSceneDoc,
  type SceneLayer,
  type SceneTextLayer,
  type ScenePage,
} from '@instagram-agent/shared'

const box = (id: string, x: number, y: number, w = 100, h = 50): SceneLayer => ({
  id,
  type: 'shape',
  shape: 'rect',
  x,
  y,
  w,
  h,
  fill: 'token:primary',
})

describe('snapLayer', () => {
  it('snaps to a neighbor edge within threshold and returns the guide', () => {
    const moving = { x: 98, y: 10, w: 100, h: 50 }
    const others = [{ x: 200, y: 0, w: 80, h: 40 }]
    // moving.right = 198, other.left = 200 → delta 2 within threshold 5
    const result = snapLayer(moving, others, 5)
    expect(result.x).toBe(100) // 200 - 100
    expect(result.guides.some((g) => g.orientation === 'v' && g.at === 200)).toBe(true)
  })

  it('does not move when outside threshold', () => {
    const moving = { x: 0, y: 0, w: 100, h: 50 }
    const others = [{ x: 200, y: 400, w: 80, h: 40 }]
    const result = snapLayer(moving, others, 5)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
    expect(result.guides).toHaveLength(0)
  })
})

describe('reorder', () => {
  const layers = [box('a', 0, 0), box('b', 10, 10), box('c', 20, 20)]

  it('moves a layer up (toward top of stack)', () => {
    const next = reorder(layers, 'a', 'up')
    expect(next.map((l) => l.id)).toEqual(['b', 'a', 'c'])
  })

  it('moves a layer down', () => {
    const next = reorder(layers, 'c', 'down')
    expect(next.map((l) => l.id)).toEqual(['a', 'c', 'b'])
  })

  it('is a no-op at the ends', () => {
    expect(reorder(layers, 'c', 'up')).toBe(layers)
    expect(reorder(layers, 'a', 'down')).toBe(layers)
  })
})

describe('duplicateLayer', () => {
  it('offsets position and assigns a fresh id', () => {
    const src: SceneTextLayer = {
      id: 'l_src',
      type: 'text',
      text: 'Hi',
      x: 40,
      y: 60,
      w: 200,
      h: 40,
      fontSize: 32,
      color: 'token:primary',
    }
    const dup = duplicateLayer(src, 24)
    expect(dup.id).not.toBe(src.id)
    expect(dup.x).toBe(64)
    expect(dup.y).toBe(84)
    expect(dup.type).toBe('text')
  })
})

describe('reorderPages', () => {
  const pages: ScenePage[] = ['a', 'b', 'c'].map((id) => ({
    id,
    background: { kind: 'color', color: 'token:background' },
    layers: [],
  }))

  it('moves a page to a new index', () => {
    const next = reorderPages(pages, 0, 2)
    expect(next.map((p) => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('is a no-op for an out-of-range index', () => {
    expect(reorderPages(pages, 0, 5)).toBe(pages)
    expect(reorderPages(pages, -1, 1)).toBe(pages)
  })

  it('is a no-op for the same index', () => {
    expect(reorderPages(pages, 1, 1)).toBe(pages)
  })
})

describe('duplicatePage', () => {
  it('returns a page with a new id and every layer re-ided', () => {
    const src: ScenePage = {
      id: 'p_src',
      background: { kind: 'color', color: 'token:background' },
      layers: [
        { id: 'l1', type: 'text', text: 'Hi', x: 0, y: 0, w: 100, h: 40, fontSize: 24, color: 'token:primary' },
        { id: 'l2', type: 'shape', shape: 'rect', x: 10, y: 10, w: 50, h: 50, fill: 'token:accent' },
      ],
    }
    const dup = duplicatePage(src)
    expect(dup.id).not.toBe(src.id)
    expect(dup.layers).toHaveLength(2)
    const dupIds = dup.layers.map((l) => l.id)
    expect(dupIds).not.toContain('l1')
    expect(dupIds).not.toContain('l2')
    // Content otherwise equal (ids aside) and position preserved within the page.
    expect(dup.layers[0]).toMatchObject({ type: 'text', text: 'Hi', x: 0, y: 0 })
    expect(dup.layers[1]).toMatchObject({ type: 'shape', shape: 'rect', x: 10, y: 10 })
    expect(dup.background).toEqual(src.background)
  })
})

describe('multi-layer duplicate (via duplicateLayer)', () => {
  it('duplicating a selection of 3 layers yields 3 new layers, all with fresh ids and offset positions', () => {
    const selection: SceneLayer[] = [
      box('s1', 0, 0),
      box('s2', 10, 10),
      box('s3', 20, 20),
    ]
    const dups = selection.map((l) => duplicateLayer(l))
    const dupIds = new Set(dups.map((d) => d.id))
    expect(dupIds.size).toBe(3)
    for (const id of ['s1', 's2', 's3']) expect(dupIds.has(id)).toBe(false)
    dups.forEach((d, i) => {
      expect(d.x).toBe(selection[i].x + 24)
      expect(d.y).toBe(selection[i].y + 24)
    })
  })
})

describe('history', () => {
  it('push after undo truncates the redo stack', () => {
    let h = createHistory(defaultSceneDoc('feed'))
    const a = defaultSceneDoc('feed')
    a.pages[0].background = { kind: 'color', color: '#111111' }
    const b = defaultSceneDoc('feed')
    b.pages[0].background = { kind: 'color', color: '#222222' }
    const c = defaultSceneDoc('feed')
    c.pages[0].background = { kind: 'color', color: '#333333' }

    h = pushHistory(h, a)
    h = pushHistory(h, b)
    h = undoHistory(h)
    expect(canRedo(h)).toBe(true)
    h = pushHistory(h, c)
    expect(canRedo(h)).toBe(false)
    expect(historyCurrent(h).pages[0].background).toEqual({ kind: 'color', color: '#333333' })
  })

  it('undo/redo round-trip the exact doc', () => {
    let h = createHistory(defaultSceneDoc('feed'))
    const next = defaultSceneDoc('feed')
    next.pages[0].background = { kind: 'color', color: '#abcdef' }
    h = pushHistory(h, next)
    h = undoHistory(h)
    expect(historyCurrent(h).pages[0].background).not.toEqual({ kind: 'color', color: '#abcdef' })
    h = redoHistory(h)
    expect(historyCurrent(h).pages[0].background).toEqual({ kind: 'color', color: '#abcdef' })
  })

  it('bounds do not throw', () => {
    const h = createHistory(defaultSceneDoc('feed'))
    expect(() => undoHistory(h)).not.toThrow()
    expect(() => redoHistory(h)).not.toThrow()
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })
})

describe('offBrandColors', () => {
  it('flags a raw #ff00ff layer and passes a token:primary layer', () => {
    const doc = defaultSceneDoc('feed', {
      colors: { primary: '#b8336a', background: '#fff' },
      fonts: {},
    })
    doc.pages[0].background = { kind: 'color', color: 'token:background' }
    doc.pages[0].layers = [
      {
        id: 'ok',
        type: 'text',
        text: 'Brand',
        x: 0,
        y: 0,
        w: 100,
        h: 40,
        fontSize: 24,
        color: 'token:primary',
      },
      {
        id: 'bad',
        type: 'text',
        text: 'Neon',
        x: 0,
        y: 50,
        w: 100,
        h: 40,
        fontSize: 24,
        color: '#ff00ff',
      },
    ]
    const hits = offBrandColors(doc, doc.tokens)
    expect(hits.some((h) => h.layerId === 'bad' && h.value === '#ff00ff')).toBe(true)
    expect(hits.some((h) => h.layerId === 'ok')).toBe(false)
  })
})
