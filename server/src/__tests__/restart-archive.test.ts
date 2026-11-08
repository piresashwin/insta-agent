import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import express from 'express'
import type { Server } from 'http'
import { AddressInfo } from 'net'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `restart-arch-${Math.random().toString(36).slice(2)}.db`,
)
delete process.env.OPERATOR_TOKEN

let db: typeof import('../db').default
let postActionsRouter: typeof import('../http/routes/post-actions').postActionsRouter

beforeAll(async () => {
  db = (await import('../db')).default
  postActionsRouter = (await import('../http/routes/post-actions')).postActionsRouter
})

function mount(): { server: Server; base: string } {
  const app = express()
  app.use(express.json())
  app.use('/api/posts', postActionsRouter)
  const server = app.listen(0)
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

describe('POST /restart archives slides and iterations', () => {
  it('keeps rows marked archived instead of deleting them', async () => {
    const postId = Number(
      db
        .prepare(
          `INSERT INTO posts (status, format, hook, caption, version)
           VALUES ('pending_approval', 'feed', 'h', 'c', 1)`,
        )
        .run().lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO post_slides (post_id, position, text) VALUES (?, 0, 'slide text')`,
    ).run(postId)
    db.prepare(
      `INSERT INTO iterations (post_id, author, comment) VALUES (?, 'ash', 'fix it')`,
    ).run(postId)

    const { server, base } = mount()
    try {
      const res = await fetch(`${base}/api/posts/${postId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: { id: 'ash', name: 'Ash' }, clear: true }),
      })
      expect(res.status).toBe(200)

      const slides = db
        .prepare('SELECT archived_at, position, text FROM post_slides WHERE post_id = ?')
        .all(postId) as Array<{ archived_at: string | null; position: number; text: string }>
      expect(slides.length).toBeGreaterThanOrEqual(1)
      const archived = slides.filter((s) => s.archived_at)
      expect(archived.some((s) => s.text === 'slide text')).toBe(true)

      const iters = db
        .prepare('SELECT archived_at, comment FROM iterations WHERE post_id = ?')
        .all(postId) as Array<{ archived_at: string | null; comment: string }>
      expect(iters).toHaveLength(1)
      expect(iters[0].archived_at).toBeTruthy()
      expect(iters[0].comment).toBe('fix it')

      const activeSlides = db
        .prepare(
          `SELECT id FROM post_slides WHERE post_id = ? AND archived_at IS NULL`,
        )
        .all(postId)
      expect(activeSlides.length).toBeGreaterThan(0)
    } finally {
      server.close()
    }
  })
})
