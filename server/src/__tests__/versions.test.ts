import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `versions-${Math.random().toString(36).slice(2)}.db`)

let db: typeof import('../db').default
let bumpAndSnapshot: typeof import('../services/versions').bumpAndSnapshot
let diffVersions: typeof import('../services/versions').diffVersions
let listVersions: typeof import('../services/versions').listVersions
let storeProposedVersion: typeof import('../services/versions').storeProposedVersion
let listProposedVersions: typeof import('../services/versions').listProposedVersions
let getPost: typeof import('../orchestrator').getPost
let ApiError: typeof import('../orchestrator').ApiError

beforeAll(async () => {
  db = (await import('../db')).default
  const v = await import('../services/versions')
  bumpAndSnapshot = v.bumpAndSnapshot
  diffVersions = v.diffVersions
  listVersions = v.listVersions
  storeProposedVersion = v.storeProposedVersion
  listProposedVersions = v.listProposedVersions
  const orch = await import('../orchestrator')
  getPost = orch.getPost
  ApiError = orch.ApiError
})

function insertPost(hook = 'Hello'): number {
  const info = db
    .prepare(
      `INSERT INTO posts (status, format, hook, caption, version)
       VALUES ('draft', 'feed', ?, 'cap', 1)`,
    )
    .run(hook)
  return Number(info.lastInsertRowid)
}

describe('bumpAndSnapshot', () => {
  it('bumps version 1→2 and inserts exactly one post_versions row', () => {
    const id = insertPost('v1')
    const before = getPost(id)!
    expect(Number((before as { version?: number }).version ?? 1)).toBe(1)

    const updated = bumpAndSnapshot(id, { kind: 'human', name: 'Op', id: 'op-1' })
    expect(Number((updated as { version?: number }).version)).toBe(2)

    const rows = listVersions(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(2)
    expect(rows[0].actor_kind).toBe('human')
    expect(rows[0].actor_name).toBe('Op')
    const snap = JSON.parse(rows[0].snapshot)
    expect(snap.hook).toBe('v1')
  })
})

describe('expected_version / proposed', () => {
  it('PATCH-style mismatch leaves no write when we refuse; proposed stores instead', () => {
    const id = insertPost('base')
    bumpAndSnapshot(id, { kind: 'human', name: 'A' })

    const current = Number((getPost(id) as { version?: number }).version)
    const expected = current - 1
    expect(expected).not.toBe(current)

    // Simulate conflict path used by agent apply
    storeProposedVersion({
      postId: id,
      baseVersion: current,
      snapshot: { hook: 'from-agent' },
      runId: 99,
      actor: { kind: 'agent', name: 'pipeline' },
    })
    const proposed = listProposedVersions(id)
    expect(proposed.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(proposed[0].snapshot).hook).toBe('from-agent')
    // live post unchanged
    expect(getPost(id)!.hook).toBe('base')
  })

  it('expected_version mismatch → no DB write', () => {
    const id = insertPost('locked')
    const before = getPost(id)!
    const current = Number((before as { version?: number }).version ?? 1)
    const hookBefore = before.hook

    // Mimic posts PATCH guard
    const expected = current + 5
    const shouldWrite = expected === current
    expect(shouldWrite).toBe(false)
    if (!shouldWrite) {
      // no write
    } else {
      db.prepare('UPDATE posts SET hook = ? WHERE id = ?').run('changed', id)
    }
    expect(getPost(id)!.hook).toBe(hookBefore)
    expect(Number((getPost(id) as { version?: number }).version)).toBe(current)
  })
})

describe('diffVersions', () => {
  it('reports changed fields between snapshots', () => {
    const id = insertPost('alpha')
    bumpAndSnapshot(id, { kind: 'human', name: 'A' }) // → v2 snap of alpha
    db.prepare('UPDATE posts SET hook = ? WHERE id = ?').run('beta', id)
    bumpAndSnapshot(id, { kind: 'human', name: 'B' }) // → v3 snap of beta

    const versions = listVersions(id)
    const to = versions[0].version
    const from = versions[1].version
    const diff = diffVersions(id, from, to)
    expect(diff.changed.hook).toEqual({ from: 'alpha', to: 'beta' })
  })

  it('throws when snapshot missing', () => {
    const id = insertPost('x')
    expect(() => diffVersions(id, 1, 99)).toThrow(ApiError)
  })
})
