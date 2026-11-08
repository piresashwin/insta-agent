import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import express from 'express'
import type { Server } from 'http'
import { AddressInfo } from 'net'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `pub-guards-${Math.random().toString(36).slice(2)}.db`,
)
delete process.env.OPERATOR_TOKEN

let db: typeof import('../db').default
let instagramPostsRouter: typeof import('../http/routes/instagram-posts').instagramPostsRouter
let recordApproval: typeof import('../services/approvals').recordApproval

beforeAll(async () => {
  db = (await import('../db')).default
  instagramPostsRouter = (await import('../http/routes/instagram-posts')).instagramPostsRouter
  recordApproval = (await import('../services/approvals')).recordApproval
})

function mount(): { server: Server; base: string } {
  const app = express()
  app.use(express.json())
  app.use('/api/posts', instagramPostsRouter)
  const server = app.listen(0)
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

describe('pending-upload / publishing route guards', () => {
  it('rejects operator_agent on /pending-upload and /publishing', async () => {
    const postId = Number(
      db
        .prepare(
          `INSERT INTO posts (status, format, hook, caption, version, image_url)
           VALUES ('staged', 'feed', 'h', 'c', 1, 'https://cdn.example/a.png')`,
        )
        .run().lastInsertRowid,
    )
    recordApproval({
      postId,
      stage: 'copy',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })
    recordApproval({
      postId,
      stage: 'media',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })

    const { server, base } = mount()
    try {
      for (const pathSuffix of ['pending-upload', 'publishing'] as const) {
        const res = await fetch(`${base}/api/posts/${postId}/${pathSuffix}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actor: { id: 'bot', name: 'Bot', role: 'operator_agent' },
          }),
        })
        expect(res.status).toBeGreaterThanOrEqual(403)
      }
    } finally {
      server.close()
    }
  })
})
