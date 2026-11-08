import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import express from 'express'
import type { Server } from 'http'
import { AddressInfo } from 'net'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `scene-live-${Math.random().toString(36).slice(2)}.db`,
)

let db: typeof import('../db').default
let resolvePostScene: typeof import('../scene/resolve').resolvePostScene
let loadPostSceneById: typeof import('../generation/studio-actions').loadPostSceneById
let renderPostScene: typeof import('../render/render-post').renderPostScene
let studioRouter: typeof import('../http/routes/studio').studioRouter

beforeAll(async () => {
  db = (await import('../db')).default
  resolvePostScene = (await import('../scene/resolve')).resolvePostScene
  loadPostSceneById = (await import('../generation/studio-actions')).loadPostSceneById
  renderPostScene = (await import('../render/render-post')).renderPostScene
  studioRouter = (await import('../http/routes/studio')).studioRouter
})

function seedLegacyCarousel(): number {
  const postId = Number(
    db
      .prepare(
        `INSERT INTO posts (status, format, hook, caption, scene_json, canvas_json)
         VALUES ('draft', 'carousel', 'Hook', 'c', NULL, NULL)`,
      )
      .run().lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO post_slides (post_id, position, text, source_image_url)
     VALUES (?, 0, 'Slide A', 'https://cdn.example/a.png')`,
  ).run(postId)
  db.prepare(
    `INSERT INTO post_slides (post_id, position, text, source_image_url)
     VALUES (?, 1, 'Slide B', 'https://cdn.example/b.png')`,
  ).run(postId)
  return postId
}

describe('live path scene upgrade', () => {
  it('GET /scene upgrades legacy slides into a multi-page scene and persists', async () => {
    const postId = seedLegacyCarousel()
    const app = express()
    app.use('/api/posts', studioRouter)
    const server = app.listen(0)
    const { port } = server.address() as AddressInfo
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/posts/${postId}/scene`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { scene_json: string }
      const doc = JSON.parse(body.scene_json) as { version: number; pages: unknown[] }
      expect(doc.version).toBe(2)
      expect(doc.pages.length).toBe(2)

      const stored = db
        .prepare('SELECT scene_json FROM posts WHERE id = ?')
        .get(postId) as { scene_json: string }
      expect(stored.scene_json).toBeTruthy()
      expect(JSON.parse(stored.scene_json).pages).toHaveLength(2)
    } finally {
      server.close()
    }
  })

  it('loadPostScene and render path upgrade the same way; second resolve is a fast path', async () => {
    const postId = seedLegacyCarousel()
    const first = loadPostSceneById(postId)
    expect(first.pages).toHaveLength(2)

    const second = resolvePostScene(db, postId)
    expect(second.upgraded).toBe(false)
    expect(second.doc.pages).toHaveLength(2)

    const rendered = await renderPostScene(db, postId, async ({ position }) => ({
      url: `https://cdn.example/render/${postId}/${position}.png`,
    }))
    expect(rendered.pages.length).toBeGreaterThanOrEqual(2)
  })
})
