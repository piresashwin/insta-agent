import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `p4-audience-${Math.random().toString(36).slice(2)}.db`)

let handleSyncAudienceInsights: typeof import('../insights/sync').handleSyncAudienceInsights
let db: typeof import('../db').default

beforeAll(async () => {
  db = (await import('../db')).default
  handleSyncAudienceInsights = (await import('../insights/sync')).handleSyncAudienceInsights
})

describe('handleSyncAudienceInsights follower gate', () => {
  it('no-ops under 100 followers without writing a snapshot', async () => {
    const accountId = `acct_low_${Math.random().toString(36).slice(2)}`
    db.prepare(
      `INSERT INTO instagram_conn (account_id, app_id, client_secret, redirect_uri, access_token, status)
       VALUES (?, 'app', 'sec', 'https://cb', 'tok', 'connected')`,
    ).run(accountId)
    db.prepare(
      `INSERT INTO ig_account_metrics_daily (account_id, date, followers, final)
       VALUES (?, '2026-11-01', 50, 1)`,
    ).run(accountId)

    const result = await handleSyncAudienceInsights({ account_id: accountId })
    expect(result).toEqual({ skipped: true, reason: 'fewer than 100 followers' })
    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM ig_audience_snapshots WHERE account_id = ?')
        .get(accountId) as { c: number }
    ).c
    expect(count).toBe(0)
  })
})

describe('account metrics final flag', () => {
  it('marks dates older than 3 days as final', async () => {
    const accountId = `acct_final_${Math.random().toString(36).slice(2)}`
    db.prepare(
      `INSERT INTO instagram_conn (account_id, app_id, client_secret, redirect_uri, access_token, status)
       VALUES (?, 'app', 'sec', 'https://cb', 'tok', 'connected')`,
    ).run(accountId)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/insights')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                { name: 'reach', values: [{ value: 10 }] },
                { name: 'views', values: [{ value: 20 }] },
                { name: 'follower_count', values: [{ value: 200 }] },
              ],
            }),
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ followers_count: 200 }),
        }
      }),
    )

    const { handleSyncAccountInsights } = await import('../insights/sync')
    const oldDate = '2026-10-01'
    const recent = new Date()
    recent.setUTCDate(recent.getUTCDate() - 1)
    const recentDate = recent.toISOString().slice(0, 10)

    const old = await handleSyncAccountInsights({ account_id: accountId, date: oldDate })
    const neu = await handleSyncAccountInsights({ account_id: accountId, date: recentDate })
    expect(old.final).toBe(true)
    expect(neu.final).toBe(false)

    vi.unstubAllGlobals()
  })
})
