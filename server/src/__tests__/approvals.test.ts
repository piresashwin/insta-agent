import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `approvals-${Math.random().toString(36).slice(2)}.db`)

let db: typeof import('../db').default
let recordApproval: typeof import('../services/approvals').recordApproval
let hasApproval: typeof import('../services/approvals').hasApproval
let assertPublishApprovals: typeof import('../services/approvals').assertPublishApprovals
let assertMediaApprovalForStage: typeof import('../services/approvals').assertMediaApprovalForStage
let judgeFailedRequiresOverride: typeof import('../services/approvals').judgeFailedRequiresOverride
let computeArtifactHash: typeof import('../services/approvals').computeArtifactHash
let transitionPost: typeof import('../orchestrator').transitionPost
let getPost: typeof import('../orchestrator').getPost
let ApiError: typeof import('../orchestrator').ApiError
let enqueueJob: typeof import('../jobs').enqueueJob
let schedulerTick: typeof import('../jobs').schedulerTick
let listJobs: typeof import('../jobs').listJobs

beforeAll(async () => {
  db = (await import('../db')).default
  const a = await import('../services/approvals')
  recordApproval = a.recordApproval
  hasApproval = a.hasApproval
  assertPublishApprovals = a.assertPublishApprovals
  assertMediaApprovalForStage = a.assertMediaApprovalForStage
  judgeFailedRequiresOverride = a.judgeFailedRequiresOverride
  computeArtifactHash = a.computeArtifactHash
  const orch = await import('../orchestrator')
  transitionPost = orch.transitionPost
  getPost = orch.getPost
  ApiError = orch.ApiError
  const jobs = await import('../jobs')
  enqueueJob = jobs.enqueueJob
  schedulerTick = jobs.schedulerTick
  listJobs = jobs.listJobs
})

function seedPost(status = 'pending_approval'): number {
  const info = db
    .prepare(
      `INSERT INTO posts (status, format, hook, caption, version)
       VALUES (?, 'feed', 'h', 'c', 1)`,
    )
    .run(status)
  return Number(info.lastInsertRowid)
}

describe('recordApproval', () => {
  it('approve-copy / approve-media insert rows with stage, version, actor', () => {
    const id = seedPost()
    const copy = recordApproval({
      postId: id,
      stage: 'copy',
      actor: { kind: 'human', name: 'Ash', id: 'ash' },
    })
    expect(copy.stage).toBe('copy')
    expect(copy.version).toBe(1)
    expect(copy.actor_name).toBe('Ash')

    const media = recordApproval({
      postId: id,
      stage: 'media',
      actor: { kind: 'human', name: 'Ash', id: 'ash' },
      artifactHash: 'hash-1',
    })
    expect(media.stage).toBe('media')
    expect(hasApproval(id, 'copy', 1)).toBe(true)
    expect(hasApproval(id, 'media', 1)).toBe(true)
  })
})

describe('media gate', () => {
  it('staged transition rejected without media approval; allowed with one', () => {
    const id = seedPost('media_ready')
    expect(() => assertMediaApprovalForStage(id)).toThrow(ApiError)

    recordApproval({
      postId: id,
      stage: 'media',
      actor: { kind: 'human', name: 'Ash', id: 'ash' },
    })
    expect(() => assertMediaApprovalForStage(id)).not.toThrow()

    const updated = transitionPost(id, 'staged', {
      actor: { id: 'ash', name: 'Ash' },
    })
    expect(updated.status).toBe('staged')
  })

  it('re-approving after version bump is required', () => {
    const id = seedPost('media_ready')
    recordApproval({
      postId: id,
      stage: 'media',
      actor: { kind: 'human', name: 'Ash', id: 'ash' },
      version: 1,
    })
    db.prepare('UPDATE posts SET version = 2 WHERE id = ?').run(id)
    expect(hasApproval(id, 'media')).toBe(false)
    expect(() => assertMediaApprovalForStage(id)).toThrow(/version 2/)
  })
})

describe('schedulerTick media gate', () => {
  it('skips staged post lacking media approval; enqueues one that has it', () => {
    const past = new Date(Date.now() - 60_000).toISOString()

    const skipId = seedPost('staged')
    db.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?').run(past, skipId)
    recordApproval({
      postId: skipId,
      stage: 'copy',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })
    // no media approval

    const okId = seedPost('staged')
    db.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?').run(past, okId)
    recordApproval({
      postId: okId,
      stage: 'copy',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })
    recordApproval({
      postId: okId,
      stage: 'media',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })

    schedulerTick()

    const skipJobs = listJobs({ post_id: skipId, status: 'pending' })
    const okJobs = listJobs({ post_id: okId })
    expect(skipJobs.filter((j) => j.kind === 'publish_post')).toHaveLength(0)
    expect(okJobs.some((j) => j.kind === 'publish_post')).toBe(true)
  })
})

describe('judge override', () => {
  it('judge-failed post requires override_reason', () => {
    const id = seedPost()
    db.prepare(
      `INSERT INTO post_reviews (post_id, post_version, passed, overall_score)
       VALUES (?, 1, 0, 0.2)`,
    ).run(id)
    expect(judgeFailedRequiresOverride(id)).toBe(true)

    // Mimic POST /approve body validation
    const bodyWithout = { actor: { id: 'a', name: 'A' } }
    const rejected =
      judgeFailedRequiresOverride(id) && !('override_reason' in bodyWithout && (bodyWithout as { override_reason?: string }).override_reason?.trim())
    expect(rejected).toBe(true)

    const bodyWith = { actor: { id: 'a', name: 'A' }, override_reason: 'Ship anyway' }
    const allowed =
      !judgeFailedRequiresOverride(id) ||
      !!(bodyWith.override_reason && bodyWith.override_reason.trim())
    expect(allowed).toBe(true)

    db.prepare(
      `INSERT INTO post_reviews (post_id, post_version, passed, overall_score)
       VALUES (?, 1, 1, 0.9)`,
    ).run(id)
    // latest row is pass
    expect(judgeFailedRequiresOverride(id)).toBe(false)
  })
})

describe('assertPublishApprovals', () => {
  it('requires both copy and media of current version', () => {
    const id = seedPost('staged')
    expect(() => assertPublishApprovals(id)).toThrow(/copy/)
    recordApproval({
      postId: id,
      stage: 'copy',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })
    expect(() => assertPublishApprovals(id)).toThrow(/media/)
    recordApproval({
      postId: id,
      stage: 'media',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })
    expect(() => assertPublishApprovals(id)).not.toThrow()
    void getPost
    void enqueueJob
  })

  it('rejects publish when media artifact_hash no longer matches', () => {
    const id = seedPost('staged')
    db.prepare('UPDATE posts SET image_url = ? WHERE id = ?').run('https://cdn.example/a.png', id)
    recordApproval({
      postId: id,
      stage: 'copy',
      actor: { kind: 'human', name: 'A', id: 'a' },
    })
    const hash = computeArtifactHash(id)
    recordApproval({
      postId: id,
      stage: 'media',
      actor: { kind: 'human', name: 'A', id: 'a' },
      artifactHash: hash,
    })
    expect(() => assertPublishApprovals(id)).not.toThrow()

    db.prepare('UPDATE posts SET image_url = ? WHERE id = ?').run('https://cdn.example/b.png', id)
    expect(() => assertPublishApprovals(id)).toThrow(/artifact changed/)
  })
})
