import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import {
  defaultSceneDoc,
  newPageId,
  type SceneDoc,
} from '@instagram-agent/shared'

process.env.DB_PATH = path.join(os.tmpdir(), `render-ep-${Math.random().toString(36).slice(2)}.db`)

let db: typeof import('../../db').default
let renderPostScene: typeof import('../render-post').renderPostScene
let renderSceneAllPages: typeof import('../scene-render').renderSceneAllPages
let scenePageHash: typeof import('../hash').scenePageHash

beforeAll(async () => {
  db = (await import('../../db')).default
  renderPostScene = (await import('../render-post')).renderPostScene
  renderSceneAllPages = (await import('../scene-render')).renderSceneAllPages
  scenePageHash = (await import('../hash')).scenePageHash
})

function insertPost(scene: SceneDoc): number {
  const info = db
    .prepare(
      `INSERT INTO posts (status, format, scene_json)
       VALUES ('draft', ?, ?)`,
    )
    .run(scene.format, JSON.stringify(scene))
  return Number(info.lastInsertRowid)
}

describe('renderSceneAllPages', () => {
  it('returns one buffer per page for a 3-page carousel', async () => {
    const doc: SceneDoc = {
      ...defaultSceneDoc('carousel'),
      pages: [0, 1, 2].map((i) => ({
        id: newPageId(),
        background: { kind: 'color' as const, color: i === 0 ? '#ff0000' : i === 1 ? '#00ff00' : '#0000ff' },
        layers: [],
      })),
    }
    const bufs = await renderSceneAllPages(doc, { scale: 0.05 })
    expect(bufs).toHaveLength(3)
    for (const buf of bufs) {
      expect(buf[0]).toBe(0x89)
      expect(buf[1]).toBe(0x50)
    }
  })

  it('returns one buffer for feed', async () => {
    const bufs = await renderSceneAllPages(defaultSceneDoc('feed'), { scale: 0.05 })
    expect(bufs).toHaveLength(1)
  })
})

describe('renderPostScene', () => {
  it('inserts assets with source:render and reuses on second call', async () => {
    const scene: SceneDoc = {
      ...defaultSceneDoc('carousel'),
      pages: [0, 1].map(() => ({
        id: newPageId(),
        background: { kind: 'color' as const, color: '#112233' },
        layers: [],
      })),
    }
    const postId = insertPost(scene)

    const uploads: Array<{ position: number; sha256: string }> = []
    const store = async (opts: {
      postId: number
      position: number
      bytes: Buffer
      sha256: string
    }) => {
      uploads.push({ position: opts.position, sha256: opts.sha256 })
      return { url: `https://example.test/p/${opts.postId}/${opts.position}.png` }
    }

    const first = await renderPostScene(db, postId, store)
    expect(first.pages).toHaveLength(2)
    expect(uploads).toHaveLength(2)
    expect(first.pages.every((p) => !p.reused)).toBe(true)

    const rows = db
      .prepare(`SELECT * FROM assets WHERE post_id = ? AND source = 'render'`)
      .all(postId) as Array<{ sha256: string; url: string; source: string }>
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === 'render')).toBe(true)
    expect(rows.map((r) => r.sha256).sort()).toEqual(
      [scenePageHash(scene, 0), scenePageHash(scene, 1)].sort(),
    )

    const uploadCountAfterFirst = uploads.length
    const second = await renderPostScene(db, postId, store)
    expect(second.pages).toHaveLength(2)
    expect(second.pages.every((p) => p.reused)).toBe(true)
    expect(uploads.length).toBe(uploadCountAfterFirst)
    expect(second.sceneHash).toBe(first.sceneHash)
    expect(second.pages.map((p) => p.url)).toEqual(first.pages.map((p) => p.url))

    const rowsAfter = db
      .prepare(`SELECT COUNT(*) AS n FROM assets WHERE post_id = ? AND source = 'render'`)
      .get(postId) as { n: number }
    expect(rowsAfter.n).toBe(2)
  })
})
