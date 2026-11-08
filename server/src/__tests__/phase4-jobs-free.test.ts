import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'

process.env.DB_PATH = path.join(os.tmpdir(), `p4-jobs-free-${Math.random().toString(36).slice(2)}.db`)

describe('Phase 4 sync/refresh jobs stay budget-free', () => {
  let jobsSrc: string

  beforeAll(() => {
    jobsSrc = fs.readFileSync(path.join(__dirname, '../jobs.ts'), 'utf8')
  })

  it('preflight only runs for agent_run and generate_media', () => {
    expect(jobsSrc).toMatch(
      /if \(job\.kind === 'agent_run' \|\| job\.kind === 'generate_media'\)/,
    )
    for (const kind of [
      'sync_media_insights',
      'sync_account_insights',
      'sync_audience_insights',
      'refresh_token',
    ]) {
      expect(jobsSrc).toContain(`'${kind}'`)
      expect(jobsSrc).not.toMatch(
        new RegExp(`job\\.kind === '${kind}'[\\s\\S]{0,80}preflightPaidJob`),
      )
    }
  })
})

describe('enqueue sync kinds', () => {
  let enqueueJob: typeof import('../jobs').enqueueJob
  let db: typeof import('../db').default

  beforeAll(async () => {
    db = (await import('../db')).default
    enqueueJob = (await import('../jobs')).enqueueJob
  })

  it('accepts sync_media_insights and refresh_token kinds', () => {
    const a = enqueueJob({
      kind: 'sync_media_insights',
      payload: { media_id: 'm1', period_label: '1h' },
      dedupe_key: `test:sync:${Math.random()}`,
    })
    const b = enqueueJob({
      kind: 'refresh_token',
      payload: { connection_id: 1 },
      dedupe_key: `test:refresh:${Math.random()}`,
    })
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    const row = db.prepare('SELECT kind FROM jobs WHERE id = ?').get(a) as { kind: string }
    expect(row.kind).toBe('sync_media_insights')
  })
})
