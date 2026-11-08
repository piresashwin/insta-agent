/**
 * Pure editor helpers for the Konva studio — no DOM dependency.
 */

import type { BrandTokens, SceneDoc, SceneLayer, ScenePage } from './schema'

function freshLayerId(): string {
  return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function freshPageId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

// ── Snap ──────────────────────────────────────────────────────────────────────

export type SnapGuide = {
  orientation: 'v' | 'h'
  /** Position in scene coordinates (x for vertical, y for horizontal). */
  at: number
}

export type SnapResult = {
  x: number
  y: number
  guides: SnapGuide[]
}

type Box = { x: number; y: number; w: number; h: number }

function edges(b: Box): { left: number; right: number; cx: number; top: number; bottom: number; cy: number } {
  return {
    left: b.x,
    right: b.x + b.w,
    cx: b.x + b.w / 2,
    top: b.y,
    bottom: b.y + b.h,
    cy: b.y + b.h / 2,
  }
}

/**
 * Snap a moving layer's position to neighboring layer edges / centers within `threshold`.
 * Returns adjusted x/y and the active guide lines (empty if nothing snapped).
 */
export function snapLayer(
  layer: Pick<SceneLayer, 'x' | 'y' | 'w' | 'h'>,
  others: Array<Pick<SceneLayer, 'x' | 'y' | 'w' | 'h'>>,
  threshold: number,
): SnapResult {
  let { x, y } = layer
  const guides: SnapGuide[] = []
  const moving = edges({ x, y, w: layer.w, h: layer.h })

  let bestDx = threshold + 1
  let bestDy = threshold + 1
  let snapX: number | null = null
  let snapY: number | null = null
  let guideV: SnapGuide | null = null
  let guideH: SnapGuide | null = null

  for (const other of others) {
    const t = edges(other)

    const xPairs: Array<[number, number, number]> = [
      [moving.left, t.left, t.left],
      [moving.left, t.right, t.right],
      [moving.left, t.cx, t.cx],
      [moving.right, t.left, t.left - layer.w],
      [moving.right, t.right, t.right - layer.w],
      [moving.right, t.cx, t.cx - layer.w],
      [moving.cx, t.left, t.left - layer.w / 2],
      [moving.cx, t.right, t.right - layer.w / 2],
      [moving.cx, t.cx, t.cx - layer.w / 2],
    ]
    for (const [from, to, newX] of xPairs) {
      const d = Math.abs(from - to)
      if (d <= threshold && d < bestDx) {
        bestDx = d
        snapX = newX
        guideV = { orientation: 'v', at: to }
      }
    }

    const yPairs: Array<[number, number, number]> = [
      [moving.top, t.top, t.top],
      [moving.top, t.bottom, t.bottom],
      [moving.top, t.cy, t.cy],
      [moving.bottom, t.top, t.top - layer.h],
      [moving.bottom, t.bottom, t.bottom - layer.h],
      [moving.bottom, t.cy, t.cy - layer.h],
      [moving.cy, t.top, t.top - layer.h / 2],
      [moving.cy, t.bottom, t.bottom - layer.h / 2],
      [moving.cy, t.cy, t.cy - layer.h / 2],
    ]
    for (const [from, to, newY] of yPairs) {
      const d = Math.abs(from - to)
      if (d <= threshold && d < bestDy) {
        bestDy = d
        snapY = newY
        guideH = { orientation: 'h', at: to }
      }
    }
  }

  if (snapX !== null) {
    x = snapX
    if (guideV) guides.push(guideV)
  }
  if (snapY !== null) {
    y = snapY
    if (guideH) guides.push(guideH)
  }

  return { x, y, guides }
}

// ── Z-order ───────────────────────────────────────────────────────────────────

export type ReorderDir = 'up' | 'down' | 'top' | 'bottom'

/** Move a layer in the z-stack. `up` = toward end of array (drawn later / on top). */
export function reorder(layers: SceneLayer[], id: string, dir: ReorderDir): SceneLayer[] {
  const i = layers.findIndex((l) => l.id === id)
  if (i < 0) return layers

  const next = layers.slice()
  if (dir === 'up') {
    if (i >= next.length - 1) return layers
    ;[next[i], next[i + 1]] = [next[i + 1], next[i]]
  } else if (dir === 'down') {
    if (i <= 0) return layers
    ;[next[i], next[i - 1]] = [next[i - 1], next[i]]
  } else if (dir === 'top') {
    if (i >= next.length - 1) return layers
    const [item] = next.splice(i, 1)
    next.push(item)
  } else {
    if (i <= 0) return layers
    const [item] = next.splice(i, 1)
    next.unshift(item)
  }
  return next
}

// ── Duplicate ─────────────────────────────────────────────────────────────────

export function duplicateLayer(layer: SceneLayer, offset = 24): SceneLayer {
  const id = freshLayerId()
  if (layer.type === 'group') {
    return {
      ...layer,
      id,
      x: layer.x + offset,
      y: layer.y + offset,
      children: layer.children.map((c) => duplicateLayer(c, 0)),
    }
  }
  return {
    ...layer,
    id,
    x: layer.x + offset,
    y: layer.y + offset,
  }
}

// ── Page operations ────────────────────────────────────────────────────────────

/**
 * Move a page from `fromIndex` to `toIndex`. A no-op (returns the same array
 * reference) for an out-of-range or same-position move.
 */
export function reorderPages(pages: ScenePage[], fromIndex: number, toIndex: number): ScenePage[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= pages.length ||
    toIndex >= pages.length
  ) {
    return pages
  }
  const next = pages.slice()
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

/** Duplicate a page with a fresh page id and every layer re-ided (no shared ids with the source). */
export function duplicatePage(page: ScenePage): ScenePage {
  return {
    ...page,
    id: freshPageId(),
    layers: page.layers.map((l) => duplicateLayer(l, 0)),
  }
}

// ── Patch / history ───────────────────────────────────────────────────────────

export type ScenePatch = {
  pages?: ScenePage[]
  tokens?: BrandTokens
  size?: SceneDoc['size']
  format?: SceneDoc['format']
  timeline?: SceneDoc['timeline']
}

export function applyScenePatch(doc: SceneDoc, patch: ScenePatch): SceneDoc {
  return { ...doc, ...patch }
}

export type HistoryState = {
  snapshots: SceneDoc[]
  idx: number
}

export function createHistory(initial: SceneDoc): HistoryState {
  return { snapshots: [initial], idx: 0 }
}

export function historyCurrent(h: HistoryState): SceneDoc {
  return h.snapshots[h.idx]
}

/** Push a new snapshot; truncates any redo stack past the current index. */
export function pushHistory(h: HistoryState, next: SceneDoc): HistoryState {
  return {
    snapshots: [...h.snapshots.slice(0, h.idx + 1), next],
    idx: h.idx + 1,
  }
}

export function undoHistory(h: HistoryState): HistoryState {
  if (h.idx <= 0) return h
  return { ...h, idx: h.idx - 1 }
}

export function redoHistory(h: HistoryState): HistoryState {
  if (h.idx >= h.snapshots.length - 1) return h
  return { ...h, idx: h.idx + 1 }
}

export function canUndo(h: HistoryState): boolean {
  return h.idx > 0
}

export function canRedo(h: HistoryState): boolean {
  return h.idx < h.snapshots.length - 1
}

// ── Off-brand colors ──────────────────────────────────────────────────────────

const COLOR_KEYS = ['color', 'fill', 'stroke'] as const

function collectColorFields(layer: SceneLayer): Array<{ layerId: string; field: string; value: string }> {
  const out: Array<{ layerId: string; field: string; value: string }> = []
  if (layer.type === 'group') {
    for (const child of layer.children) out.push(...collectColorFields(child))
    return out
  }
  for (const key of COLOR_KEYS) {
    const val = (layer as Record<string, unknown>)[key]
    if (typeof val === 'string' && val.length > 0) {
      out.push({ layerId: layer.id, field: key, value: val })
    }
  }
  return out
}

export type OffBrandHit = {
  layerId: string
  field: string
  value: string
}

/**
 * Layers whose color fields are not `token:*` refs (raw hex/rgba).
 * Backgrounds using raw colors are included via a synthetic layerId `background:<pageId>`.
 */
export function offBrandColors(doc: SceneDoc, _tokens: BrandTokens): OffBrandHit[] {
  const hits: OffBrandHit[] = []
  for (const page of doc.pages) {
    if (page.background.kind === 'color' && !page.background.color.startsWith('token:')) {
      hits.push({ layerId: `background:${page.id}`, field: 'color', value: page.background.color })
    }
    if (page.background.kind === 'gradient') {
      for (const stop of page.background.stops) {
        if (!stop.color.startsWith('token:')) {
          hits.push({ layerId: `background:${page.id}`, field: 'gradient', value: stop.color })
        }
      }
    }
    for (const layer of page.layers) {
      for (const hit of collectColorFields(layer)) {
        if (!hit.value.startsWith('token:')) hits.push(hit)
      }
    }
  }
  return hits
}
