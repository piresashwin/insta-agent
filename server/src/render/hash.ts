/**
 * Stable content hash for SceneDoc — resolved tokens + sorted keys.
 * Unchanged scenes always produce the same hash so re-render can be skipped.
 */

import crypto from 'crypto'
import { resolveToken, type BrandTokens, type SceneDoc } from '@instagram-agent/shared'

function normalizeValue(value: unknown, tokens: BrandTokens): unknown {
  if (typeof value === 'string') {
    return value.startsWith('token:') ? resolveToken(value, tokens) : value
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeValue(v, tokens))
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = normalizeValue(obj[key], tokens)
    }
    return out
  }
  return value
}

/** Canonical JSON for a scene (tokens resolved, keys sorted). */
export function normalizeScene(doc: SceneDoc): string {
  return JSON.stringify(normalizeValue(doc, doc.tokens))
}

/** SHA-256 hex of the normalized scene. */
export function sceneHash(doc: SceneDoc): string {
  return crypto.createHash('sha256').update(normalizeScene(doc)).digest('hex')
}

/**
 * Content hash of a single page — derived from that page's own normalized
 * content plus the doc-level inputs that affect its render (canvas size and
 * resolved tokens). Independent of other pages, so editing one carousel slide
 * does not invalidate the cached renders of the others. Identical page content
 * produces the same hash (so a repeated slide reuses one asset).
 */
export function scenePageHash(doc: SceneDoc, pageIndex: number): string {
  const page = doc.pages[pageIndex]
  const canonical = JSON.stringify(normalizeValue({ size: doc.size, page }, doc.tokens))
  return crypto.createHash('sha256').update(canonical).digest('hex')
}
