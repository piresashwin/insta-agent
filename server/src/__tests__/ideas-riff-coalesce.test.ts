import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import os from 'os'
import express from 'express'
import type { Server } from 'http'
import { AddressInfo } from 'net'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `ideas-riff-coalesce-${Math.random().toString(36).slice(2)}.db`,
)

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let gate = deferred()
const sampleIdeas = [
  {
    topic: 'Riff variation one about quiet mornings',
    angle: 'Angle A',
    pillar: 'edu',
    format: 'feed' as const,
    hooks: ['Hook A1 for quiet mornings', 'Hook A2 for quiet mornings'],
    why: 'Fits brand',
  },
  {
    topic: 'Riff variation two about quiet mornings',
    angle: 'Angle B',
    pillar: 'edu',
    format: 'carousel' as const,
    hooks: ['Hook B1 for quiet mornings', 'Hook B2 for quiet mornings'],
    why: 'Fits brand',
  },
  {
    topic: 'Riff variation three about quiet mornings',
    angle: 'Angle C',
    pillar: 'edu',
    format: 'feed' as const,
    hooks: ['Hook C1 for quiet mornings', 'Hook C2 for quiet mornings'],
    why: 'Fits brand',
  },
]

const invoke = vi.fn(async () => {
  await gate.promise
  return { ideas: sampleIdeas }
})

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

describe('ideas riff coalesce', () => {
  it('overlapping like_idea_id shares one LLM call; later click generates anew', async () => {
    const brandId = Number(
      db.prepare(`INSERT INTO brand_profiles (name) VALUES ('Riff Brand')`).run().lastInsertRowid,
    )
    const parentId = Number(
      db
        .prepare(
          `INSERT INTO ideas (brand_profile_id, topic, angle, format, hooks_json, status, source)
           VALUES (?, 'Quiet morning prayer habit', 'Soft take', 'feed', ?, 'new', 'ai')`,
        )
        .run(brandId, JSON.stringify(['Start quieter', 'Two minutes']))
        .lastInsertRowid,
    )

    const { server, base } = mount()
    try {
      invoke.mockClear()
      gate = deferred()

      const body = JSON.stringify({
        brand_profile_id: brandId,
        like_idea_id: parentId,
        actor: { id: 'a', name: 'A' },
      })
      const p1 = fetch(`${base}/api/ideas/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

      const p2 = fetch(`${base}/api/ideas/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      await new Promise((r) => setTimeout(r, 30))
      expect(invoke).toHaveBeenCalledTimes(1)

      gate.resolve()
      const [res1, res2] = await Promise.all([p1, p2])
      expect(res1.status).toBe(201)
      expect(res2.status).toBe(201)
      const b1 = (await res1.json()) as { batch_id: string; ideas: Array<{ id: number }> }
      const b2 = (await res2.json()) as { batch_id: string; ideas: Array<{ id: number }> }
      expect(b1.batch_id).toBe(b2.batch_id)
      expect(b1.ideas.map((i) => i.id)).toEqual(b2.ideas.map((i) => i.id))
      expect(b1.ideas.length).toBeGreaterThan(0)

      // After settle, a deliberate riff generates a new batch
      invoke.mockClear()
      gate = deferred()
      gate.resolve()
      invoke.mockImplementationOnce(async () => ({
        ideas: [
          {
            topic: 'Fresh riff after settle about quiet mornings',
            angle: 'Angle D',
            pillar: 'edu',
            format: 'feed' as const,
            hooks: ['Hook D1 fresh settle riff', 'Hook D2 fresh settle riff'],
            why: 'New batch',
          },
        ],
      }))

      const res3 = await fetch(`${base}/api/ideas/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(res3.status).toBe(201)
      const b3 = (await res3.json()) as { batch_id: string; ideas: Array<{ id: number }> }
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(b3.batch_id).not.toBe(b1.batch_id)
      expect(b3.ideas[0]?.id).not.toBe(b1.ideas[0]?.id)
    } finally {
      server.close()
    }
  })
})
