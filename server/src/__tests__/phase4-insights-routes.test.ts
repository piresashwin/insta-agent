import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import express from 'express'
import type { Server } from 'http'
import { AddressInfo } from 'net'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `p4-insights-routes-${Math.random().toString(36).slice(2)}.db`,
)

let db: typeof import('../db').default
let insightsRouter: typeof import('../http/routes/insights').insightsRouter
let sendApiError: typeof import('../http/helpers').sendApiError

beforeAll(async () => {
  db = (await import('../db')).default
  insightsRouter = (await import('../http/routes/insights')).insightsRouter
  sendApiError = (await import('../http/helpers')).sendApiError
})

function mountApp(): { server: Server; base: string } {
  const app = express()
  app.use(express.json())
  app.use('/api/insights', insightsRouter)
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    sendApiError(res, err)
  })
  const server = app.listen(0)
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

describe('GET /api/insights/account', () => {
  it('returns hidden audience under 100 followers', async () => {
    const accountId = `acct_hidden_${Math.random().toString(36).slice(2)}`
    db.prepare(
      `INSERT INTO ig_account_metrics_daily (account_id, date, followers, reach, views, final)
       VALUES (?, '2026-11-01', 42, 10, 20, 1)`,
    ).run(accountId)

    const { server, base } = mountApp()
    try {
      const res = await fetch(
        `${base}/api/insights/account?account_id=${encodeURIComponent(accountId)}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        audience: { hidden: true; reason: string }
        daily: Array<{ final: boolean }>
      }
      expect(body.audience).toEqual({
        hidden: true,
        reason: 'fewer than 100 followers',
      })
      expect(body.daily[0]?.final).toBe(true)
    } finally {
      server.close()
    }
  })
})

describe('GET /api/insights/digest', () => {
  it('returns insufficientData under 8 posts', async () => {
    const brandId = Number(
      db.prepare(`INSERT INTO brand_profiles (name) VALUES ('Route Brand')`).run().lastInsertRowid,
    )
    const { server, base } = mountApp()
    try {
      const res = await fetch(`${base}/api/insights/digest?brand_profile_id=${brandId}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { insufficientData: boolean; count: number; needed: number }
      expect(body.insufficientData).toBe(true)
      expect(body.needed).toBe(8)
    } finally {
      server.close()
    }
  })
})
