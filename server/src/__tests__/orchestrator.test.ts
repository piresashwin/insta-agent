import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'

// Use a fresh in-memory DB for each test suite.
// We import orchestrator functions but swap out the DB via module mock.
// Since orchestrator imports db as a default export, we stub process.env.DB_PATH
// to a temp file and let the migration runner populate it.

let tmpDb: string

function setupTestDb(): DatabaseSync {
  tmpDb = path.join('/tmp', `test-${Math.random().toString(36).slice(2)}.db`)
  const db = new DatabaseSync(tmpDb)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      brand_profile_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1,
      format TEXT,
      topic TEXT,
      hook TEXT,
      hook_alternates TEXT,
      caption TEXT,
      hashtags TEXT,
      alt_text TEXT,
      image_url TEXT,
      reel_url TEXT,
      approved_by TEXT,
      approved_at TEXT,
      revisions INTEGER NOT NULL DEFAULT 0,
      revision_comments TEXT,
      agent_output TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
  `)
  return db
}

function teardownTestDb() {
  try { fs.unlinkSync(tmpDb) } catch { /* ok */ }
}

// ---- Orchestrator transition logic tests (pure, no DB needed) ----

import { VALID_TRANSITIONS } from '../orchestrator'

describe('VALID_TRANSITIONS', () => {
  it('allows draft → pending_approval', () => {
    expect(VALID_TRANSITIONS.draft).toContain('pending_approval')
  })

  it('allows pending_approval → approved', () => {
    expect(VALID_TRANSITIONS.pending_approval).toContain('approved')
  })

  it('approved has no path to published directly', () => {
    expect(VALID_TRANSITIONS.approved).not.toContain('published')
  })

  it('published has no outgoing transitions', () => {
    expect(VALID_TRANSITIONS.published).toHaveLength(0)
  })
})

// ---- assertEditable ----

import { assertEditable, ApiError } from '../orchestrator'
import type { Post } from '@instagram-agent/shared'

function makePost(status: string): Post {
  return { id: 1, status } as unknown as Post
}

describe('assertEditable', () => {
  it('allows editing a draft post', () => {
    expect(() => assertEditable(makePost('draft'))).not.toThrow()
  })

  it('allows editing a changes_requested post', () => {
    expect(() => assertEditable(makePost('changes_requested'))).not.toThrow()
  })

  it('allows editing a pending_approval post', () => {
    expect(() => assertEditable(makePost('pending_approval'))).not.toThrow()
  })

  it('blocks editing an approved post', () => {
    expect(() => assertEditable(makePost('approved'))).toThrowError(ApiError)
  })

  it('blocks editing a media_generating post (copy fields)', () => {
    expect(() => assertEditable(makePost('media_generating'))).toThrowError(ApiError)
    expect(() =>
      assertEditable(makePost('media_generating'), ['caption', 'hook']),
    ).toThrowError(ApiError)
  })

  it('allows media asset fields while media_generating', () => {
    expect(() =>
      assertEditable(makePost('media_generating'), [
        'source_image_url',
        'image_url',
        'media_provider',
        'media_type',
      ]),
    ).not.toThrow()
  })

  it('blocks editing a staged post', () => {
    expect(() => assertEditable(makePost('staged'))).toThrowError(ApiError)
  })

  it('blocks editing a published post', () => {
    expect(() => assertEditable(makePost('published'))).toThrowError(ApiError)
  })

  it('includes field names in the error message', () => {
    try {
      assertEditable(makePost('approved'), ['caption', 'hook'])
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toContain('caption')
      expect((err as ApiError).status).toBe(409)
    }
  })
})
