import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `actor-${Math.random().toString(36).slice(2)}.db`)

let db: typeof import('../db').default
let bumpAndSnapshot: typeof import('../services/versions').bumpAndSnapshot
let recordApproval: typeof import('../services/approvals').recordApproval
let historyActorFrom: typeof import('../services/attribution').historyActorFrom
let SCHEDULER_ACTOR: typeof import('../services/attribution').SCHEDULER_ACTOR
let enqueueJob: typeof import('../jobs').enqueueJob
let getJob: typeof import('../jobs').getJob

beforeAll(async () => {
  db = (await import('../db')).default
  bumpAndSnapshot = (await import('../services/versions')).bumpAndSnapshot
  recordApproval = (await import('../services/approvals')).recordApproval
  const attr = await import('../services/attribution')
  historyActorFrom = attr.historyActorFrom
  SCHEDULER_ACTOR = attr.SCHEDULER_ACTOR
  const jobs = await import('../jobs')
  enqueueJob = jobs.enqueueJob
  getJob = jobs.getJob
})

describe('HistoryActor persistence', () => {
  it('version/approval written with Actor persist actor_kind/name/client', () => {
    const info = db
      .prepare(
        `INSERT INTO posts (status, format, hook, version) VALUES ('draft', 'feed', 'h', 1)`,
      )
      .run()
    const id = Number(info.lastInsertRowid)

    const actor = historyActorFrom({
      id: 'mcp:operator',
      name: 'MCP Operator',
      clientInfo: { name: 'claude-desktop' },
    })
    expect(actor.kind).toBe('mcp')

    bumpAndSnapshot(id, actor)
    const ver = db
      .prepare('SELECT * FROM post_versions WHERE post_id = ?')
      .get(id) as { actor_kind: string; actor_name: string; actor_client: string }
    expect(ver.actor_kind).toBe('mcp')
    expect(ver.actor_name).toBe('MCP Operator')
    expect(ver.actor_client).toBe('claude-desktop')

    recordApproval({
      postId: id,
      stage: 'copy',
      actor,
    })
    const appr = db
      .prepare('SELECT * FROM approvals WHERE post_id = ?')
      .get(id) as { actor_kind: string; actor_client: string }
    expect(appr.actor_kind).toBe('mcp')
    expect(appr.actor_client).toBe('claude-desktop')
  })

  it('activity view returns rows carrying the actor', () => {
    const rows = db
      .prepare(
        `SELECT kind, actor_kind, actor_name FROM activity
         WHERE actor_kind IS NOT NULL LIMIT 5`,
      )
      .all() as Array<{ kind: string; actor_kind: string; actor_name: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.actor_kind === 'mcp' || r.actor_kind === 'human')).toBe(true)
  })

  it('scheduler actor is kind scheduler', () => {
    expect(SCHEDULER_ACTOR.kind).toBe('scheduler')
    expect(SCHEDULER_ACTOR.name).toBe('scheduler')
  })

  it('publish job payload can carry scheduler actor', () => {
    db.prepare(
      "UPDATE jobs SET status='cancelled' WHERE status IN ('pending','running')",
    ).run()
    const id = enqueueJob({
      kind: 'publish_post',
      payload: { post_id: 1, actor: SCHEDULER_ACTOR },
      dedupe_key: `sched-actor:${Math.random()}`,
    })
    const job = getJob(id)!
    const payload = JSON.parse(job.payload_json) as { actor: { kind: string } }
    expect(payload.actor.kind).toBe('scheduler')
  })
})
