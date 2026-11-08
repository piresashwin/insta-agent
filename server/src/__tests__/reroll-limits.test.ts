import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `reroll-${Math.random().toString(36).slice(2)}.db`,
)

let db: typeof import('../db').default
let assertRerollAllowed: typeof import('../services/budget').assertRerollAllowed
let ApiError: typeof import('../orchestrator').ApiError

beforeAll(async () => {
  db = (await import('../db')).default
  assertRerollAllowed = (await import('../services/budget')).assertRerollAllowed
  ApiError = (await import('../orchestrator')).ApiError
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('budget_max_image_rerolls', '2')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run()
})

describe('re-roll limits', () => {
  it('blocks the N+1th generation once the cap is reached', () => {
    const postId = Number(
      db
        .prepare(
          `INSERT INTO posts (status, format, hook, caption, version)
           VALUES ('approved', 'feed', 'h', 'c', 1)`,
        )
        .run().lastInsertRowid,
    )

    expect(() => assertRerollAllowed(postId, 'feed')).not.toThrow()

    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO jobs (kind, payload_json, status, post_id)
         VALUES ('generate_media', '{}', 'done', ?)`,
      ).run(postId)
    }

    expect(() => assertRerollAllowed(postId, 'feed')).toThrow(ApiError)
    try {
      assertRerollAllowed(postId, 'feed')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as InstanceType<typeof ApiError>).message).toMatch(/Re-roll limit reached/)
    }
  })
})
