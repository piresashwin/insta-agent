import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import os from 'os'
import express from 'express'
import type { Server } from 'http'
import { AddressInfo } from 'net'

process.env.DB_PATH = path.join(os.tmpdir(), `ideas-routes-${Math.random().toString(36).slice(2)}.db`)

const invoke = vi.fn(async () => ({
  ideas: [
    {
      topic: 'Morning stillness practice',
      angle: 'Quiet start',
      pillar: 'edu',
      format: 'feed',
      hooks: ['Start quieter', 'Two minutes of stillness'],
      why: 'Fits the brand',
    },
  ],
}))

vi.mock('../skills/model', () => ({
  createStructuredModel: () => ({ invoke }),
}))

let db: typeof import('../db').default
let ideasRouter: typeof import('../http/routes/ideas').ideasRouter
let sendApiError: typeof import('../http/helpers').sendApiError

beforeAll(async () => {
  db = (await import('../db')).default
  ideasRouter = (await import('../http/routes/ideas')).ideasRouter
  sendApiError = (await import('../http/helpers')).sendApiError
})

function mount(): { server: Server; base: string } {
  const app = express()
  app.use(express.json())
  app.use('/api/ideas', ideasRouter)
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    sendApiError(res, err)
  })
  const server = app.listen(0)
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

describe('ideas routes', () => {
  it('GET board excludes dismissed/scheduled; POST manual validates topic', async () => {
    const brandId = Number(
      db.prepare(`INSERT INTO brand_profiles (name) VALUES ('Ideas Brand')`).run().lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO ideas (brand_profile_id, topic, format, status, hooks_json)
       VALUES (?, 'New idea', 'feed', 'new', '[]'),
              (?, 'Gone', 'feed', 'dismissed', '[]')`,
    ).run(brandId, brandId)

    const { server, base } = mount()
    try {
      const board = await fetch(`${base}/api/ideas?brand_profile_id=${brandId}&status=board`)
      expect(board.status).toBe(200)
      const body = (await board.json()) as { ideas: Array<{ topic: string }> }
      expect(body.ideas.map((i) => i.topic)).toEqual(['New idea'])

      const bad = await fetch(`${base}/api/ideas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_profile_id: brandId, topic: '  ', actor: { id: 'a', name: 'A' } }),
      })
      expect(bad.status).toBe(400)

      const ok = await fetch(`${base}/api/ideas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand_profile_id: brandId,
          topic: 'Handwritten topic',
          actor: { id: 'a', name: 'A' },
        }),
      })
      expect(ok.status).toBe(201)
      const created = (await ok.json()) as { idea: { status: string } }
      expect(created.idea.status).toBe('shortlisted')
    } finally {
      server.close()
    }
  })

  it('POST /generate returns 201 batch', async () => {
    const brandId = Number(
      db.prepare(`INSERT INTO brand_profiles (name) VALUES ('Gen Brand')`).run().lastInsertRowid,
    )
    const { server, base } = mount()
    try {
      const res = await fetch(`${base}/api/ideas/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand_profile_id: brandId,
          count: 4,
          steer: 'winter',
          actor: { id: 'a', name: 'A' },
        }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { batch_id: string; ideas: unknown[]; dropped: number }
      expect(body.batch_id).toBeTruthy()
      expect(body.ideas.length).toBeGreaterThan(0)
    } finally {
      server.close()
    }
  })
})
