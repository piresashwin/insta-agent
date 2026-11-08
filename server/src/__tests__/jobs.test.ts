import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `jobs-${Math.random().toString(36).slice(2)}.db`)

let enqueueJob: typeof import('../jobs').enqueueJob
let claimJob: typeof import('../jobs').claimJob
let failJob: typeof import('../jobs').failJob
let completeJob: typeof import('../jobs').completeJob
let recoverExpiredLeases: typeof import('../jobs').recoverExpiredLeases
let runJob: typeof import('../jobs').runJob
let getJob: typeof import('../jobs').getJob
let db: typeof import('../db').default

function clearJobs() {
  db.prepare("UPDATE jobs SET status='cancelled' WHERE status IN ('pending','running')").run()
}

beforeAll(async () => {
  db = (await import('../db')).default
  const jobs = await import('../jobs')
  enqueueJob = jobs.enqueueJob
  claimJob = jobs.claimJob
  failJob = jobs.failJob
  completeJob = jobs.completeJob
  recoverExpiredLeases = jobs.recoverExpiredLeases
  runJob = jobs.runJob
  getJob = jobs.getJob
})

describe('enqueueJob dedupe', () => {
  it('dedupes on an active dedupe_key; re-enqueues once prior is done', () => {
    clearJobs()
    const a = enqueueJob({
      kind: 'agent_run',
      payload: { n: 1 },
      dedupe_key: 'test:dedupe-a',
    })
    const b = enqueueJob({
      kind: 'agent_run',
      payload: { n: 2 },
      dedupe_key: 'test:dedupe-a',
    })
    expect(b).toBe(a)

    completeJob(a, { ok: true })
    const c = enqueueJob({
      kind: 'agent_run',
      payload: { n: 3 },
      dedupe_key: 'test:dedupe-a',
    })
    expect(c).not.toBe(a)
  })
})

describe('claimJob lease contention', () => {
  it('two claims never return the same job id', () => {
    clearJobs()
    const ids = [
      enqueueJob({ kind: 'publish_post', payload: { i: 1 } }),
      enqueueJob({ kind: 'publish_post', payload: { i: 2 } }),
      enqueueJob({ kind: 'publish_post', payload: { i: 3 } }),
    ]
    const claimed = new Set<number>()
    for (let i = 0; i < ids.length; i++) {
      const job = claimJob()
      expect(job).not.toBeNull()
      expect(claimed.has(job!.id)).toBe(false)
      claimed.add(job!.id)
    }
    expect(claimJob()).toBeNull()
  })

  it('overlapping claimJob calls still yield distinct ids', async () => {
    clearJobs()
    enqueueJob({ kind: 'publish_post', payload: { p: 1 } })
    enqueueJob({ kind: 'publish_post', payload: { p: 2 } })
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => claimJob()),
      Promise.resolve().then(() => claimJob()),
    ])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.id).not.toBe(b!.id)
  })
})

describe('failJob backoff', () => {
  it('reschedules with backoff until max_attempts, then marks failed', () => {
    clearJobs()
    const id = enqueueJob({
      kind: 'agent_run',
      payload: {},
      max_attempts: 2,
      dedupe_key: `fail:${Math.random()}`,
    })
    const job = claimJob()!
    expect(job.id).toBe(id)

    failJob(id, 'boom', 1, 2)
    const pending = getJob(id)!
    expect(pending.status).toBe('pending')
    expect(pending.error).toBe('boom')

    // Backoff pushed run_at into the future — make it claimable now.
    db.prepare("UPDATE jobs SET run_at = datetime('now', '-1 second') WHERE id = ?").run(id)
    const again = claimJob()!
    expect(again.id).toBe(id)
    failJob(id, 'boom2', 2, 2)
    const failed = getJob(id)!
    expect(failed.status).toBe('failed')
  })
})

describe('recoverExpiredLeases', () => {
  it('re-queues a running job whose lease expired', () => {
    clearJobs()
    const id = enqueueJob({
      kind: 'agent_run',
      payload: {},
      dedupe_key: `lease:${Math.random()}`,
    })
    const job = claimJob()!
    expect(job.id).toBe(id)

    db.prepare(
      "UPDATE jobs SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?",
    ).run(id)

    recoverExpiredLeases()
    const row = getJob(id)!
    expect(row.status).toBe('pending')
    expect(row.lease_owner).toBeNull()
  })
})

describe('runJob dispatch', () => {
  it('unknown kind → failed (no throw)', async () => {
    clearJobs()
    const id = enqueueJob({
      kind: 'agent_run',
      payload: {},
      dedupe_key: `unk:${Math.random()}`,
    })
    db.prepare("UPDATE jobs SET kind = 'not_a_real_kind' WHERE id = ?").run(id)
    const job = claimJob()!
    expect(job.id).toBe(id)
    await expect(runJob(job)).resolves.toBeUndefined()
    expect(getJob(id)!.status).toBe('failed')
    expect(getJob(id)!.error).toMatch(/Unknown job kind/)
  })
})
