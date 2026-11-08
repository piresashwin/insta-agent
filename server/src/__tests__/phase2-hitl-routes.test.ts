import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import express from 'express'
import type { Server } from 'http'
import { AddressInfo } from 'net'

process.env.DB_PATH = path.join(os.tmpdir(), `hitl-routes-${Math.random().toString(36).slice(2)}.db`)
delete process.env.OPERATOR_TOKEN

let db: typeof import('../db').default
let postsRouter: typeof import('../http/routes/posts').postsRouter
let instagramPostsRouter: typeof import('../http/routes/instagram-posts').instagramPostsRouter
let sendApiError: typeof import('../http/helpers').sendApiError

beforeAll(async () => {
  db = (await import('../db')).default
  postsRouter = (await import('../http/routes/posts')).postsRouter
  instagramPostsRouter = (await import('../http/routes/instagram-posts')).instagramPostsRouter
  sendApiError = (await import('../http/helpers')).sendApiError
})

function mountApp(): { server: Server; base: string } {
  const app = express()
  app.use(express.json())
  app.use('/api/posts', postsRouter)
  app.use('/api/posts', instagramPostsRouter)
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    sendApiError(res, err)
  })
  const server = app.listen(0)
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

describe('POST /publish-instagram HITL gate', () => {
  it('rejects staged post with no copy/media approvals', async () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO posts (status, format, hook, caption, version, image_url)
           VALUES ('staged', 'feed', 'h', 'c', 1, 'https://cdn.example/a.png')`,
        )
        .run().lastInsertRowid,
    )
    const { server, base } = mountApp()
    try {
      const res = await fetch(`${base}/api/posts/${id}/publish-instagram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: { id: 'ash', name: 'Ash' } }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/copy approval/i)
    } finally {
      server.close()
    }
  })
})

describe('POST /bulk-approve', () => {
  it('approves only judge-passing posts and records approvals', async () => {
    const passId = Number(
      db
        .prepare(
          `INSERT INTO posts (status, format, hook, caption, version)
           VALUES ('pending_approval', 'feed', 'h', 'c', 1)`,
        )
        .run().lastInsertRowid,
    )
    const failId = Number(
      db
        .prepare(
          `INSERT INTO posts (status, format, hook, caption, version)
           VALUES ('pending_approval', 'feed', 'h', 'c', 1)`,
        )
        .run().lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO post_reviews (post_id, post_version, passed, overall_score)
       VALUES (?, 1, 1, 0.9)`,
    ).run(passId)
    db.prepare(
      `INSERT INTO post_reviews (post_id, post_version, passed, overall_score)
       VALUES (?, 1, 0, 0.2)`,
    ).run(failId)

    const { server, base } = mountApp()
    try {
      const res = await fetch(`${base}/api/posts/bulk-approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_ids: [passId, failId],
          actor: { id: 'ash', name: 'Ash' },
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        approved: number[]
        skipped: Array<{ id: number; reason: string }>
      }
      expect(body.approved).toEqual([passId])
      expect(body.skipped.some((s) => s.id === failId && /override/i.test(s.reason))).toBe(true)

      const approval = db
        .prepare(
          `SELECT stage, actor_kind, actor_name, actor_client FROM approvals WHERE post_id = ? AND stage = 'copy'`,
        )
        .get(passId) as {
        stage: string
        actor_kind: string
        actor_name: string
        actor_client: string | null
      }
      expect(approval).toMatchObject({
        stage: 'copy',
        actor_kind: 'human',
        actor_name: 'Ash',
      })

      const failApprovals = db
        .prepare(`SELECT id FROM approvals WHERE post_id = ?`)
        .all(failId)
      expect(failApprovals).toHaveLength(0)
    } finally {
      server.close()
    }
  })
})
