import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `assets-dedup-${Math.random().toString(36).slice(2)}.db`)

let db: typeof import('../db').default

beforeAll(async () => {
  db = (await import('../db')).default
})

describe('asset sha256 dedup', () => {
  it('registering the same asset twice (same sha256) returns the existing row', () => {
    const sha = 'abc123deduptest'
    const insert = () => {
      const existing = db.prepare('SELECT id FROM assets WHERE sha256 = ?').get(sha) as
        | { id: number }
        | undefined
      if (existing) {
        return db.prepare('SELECT * FROM assets WHERE id = ?').get(existing.id) as { id: number; sha256: string }
      }
      const info = db
        .prepare(
          `INSERT INTO assets (kind, url, w, h, source, provider, prompt, sha256, post_id, brand_id)
           VALUES ('image', 'https://example.test/a.png', 10, 10, 'upload', NULL, NULL, ?, NULL, NULL)`,
        )
        .run(sha)
      return db.prepare('SELECT * FROM assets WHERE id = ?').get(info.lastInsertRowid) as {
        id: number
        sha256: string
      }
    }

    const first = insert()
    const second = insert()
    expect(second.id).toBe(first.id)
    expect(second.sha256).toBe(sha)

    const count = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE sha256 = ?').get(sha) as { n: number }
    expect(count.n).toBe(1)
  })
})
