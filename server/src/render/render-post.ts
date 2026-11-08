/**
 * Turn a post's SceneDoc into PNG assets (one per page; reel → cover page only).
 */

import { type SceneDoc } from '@instagram-agent/shared'
import type { DatabaseSync } from 'node:sqlite'
import { sceneHash, scenePageHash } from './hash'
import { renderScenePage } from './scene-render'
import { resolvePostScene } from '../scene/resolve'

export type RenderPageResult = {
  url: string
  sha256: string
  w: number
  h: number
  reused: boolean
}

export type RenderPostResult = {
  sceneHash: string
  pages: RenderPageResult[]
}

export type StorePngFn = (opts: {
  postId: number
  position: number
  bytes: Buffer
  sha256: string
}) => Promise<{ url: string }>

type AssetRow = {
  id: number
  url: string
  w: number | null
  h: number | null
  sha256: string | null
  source: string
}

function loadScene(database: DatabaseSync, postId: number): {
  doc: SceneDoc
  brandId: number | null
} {
  const row = database
    .prepare(`SELECT brand_profile_id FROM posts WHERE id = ?`)
    .get(postId) as { brand_profile_id: number | null } | undefined

  if (!row) throw Object.assign(new Error('Post not found'), { status: 404 })

  const { doc } = resolvePostScene(database, postId)
  return { doc, brandId: row.brand_profile_id }
}

function findAssetBySha(database: DatabaseSync, sha256: string): AssetRow | undefined {
  return database
    .prepare(`SELECT id, url, w, h, sha256, source FROM assets WHERE sha256 = ?`)
    .get(sha256) as AssetRow | undefined
}

function insertAsset(
  database: DatabaseSync,
  opts: {
    url: string
    w: number
    h: number
    sha256: string
    postId: number
    brandId: number | null
  },
): AssetRow {
  const info = database
    .prepare(
      `INSERT INTO assets (kind, url, w, h, source, provider, prompt, sha256, post_id, brand_id)
       VALUES ('image', ?, ?, ?, 'render', 'scene', NULL, ?, ?, ?)`,
    )
    .run(opts.url, opts.w, opts.h, opts.sha256, opts.postId, opts.brandId)
  return database
    .prepare(`SELECT id, url, w, h, sha256, source FROM assets WHERE id = ?`)
    .get(info.lastInsertRowid) as AssetRow
}

/**
 * Render a post's scene to PNG assets. Reuses existing assets when the scene hash is unchanged.
 */
export async function renderPostScene(
  database: DatabaseSync,
  postId: number,
  storePng: StorePngFn,
): Promise<RenderPostResult> {
  const { doc, brandId } = loadScene(database, postId)
  const hash = sceneHash(doc)
  const { w, h } = doc.size

  // Reel: cover frame only (full compositing is Chunk D). Feed/carousel: all pages.
  const pageCount = doc.format === 'reel' ? Math.min(1, doc.pages.length) : doc.pages.length
  const pages: RenderPageResult[] = []

  for (let i = 0; i < pageCount; i++) {
    const pageSha = scenePageHash(doc, i)
    const existing = findAssetBySha(database, pageSha)
    if (existing) {
      pages.push({
        url: existing.url,
        sha256: pageSha,
        w: existing.w ?? w,
        h: existing.h ?? h,
        reused: true,
      })
      continue
    }

    const png = await renderScenePage(doc, { pageIndex: i })
    const stored = await storePng({ postId, position: i, bytes: png, sha256: pageSha })
    const row = insertAsset(database, {
      url: stored.url,
      w,
      h,
      sha256: pageSha,
      postId,
      brandId,
    })

    pages.push({
      url: row.url,
      sha256: pageSha,
      w,
      h,
      reused: false,
    })
  }

  return { sceneHash: hash, pages }
}
