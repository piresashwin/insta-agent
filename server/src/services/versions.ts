/**
 * Phase 2 — post version bumps + snapshots + diff.
 */
import type { Post } from '@instagram-agent/shared'
import db from '../db'
import { ApiError, getPost } from '../orchestrator'
import {
  actorColumns,
  historyActorFrom,
  type HistoryActor,
} from './attribution'

export type PostVersionRow = {
  id: number
  post_id: number
  version: number
  snapshot: string
  actor_kind: string | null
  actor_name: string | null
  actor_client: string | null
  created_at: string
}

export type ProposedVersionRow = {
  id: number
  post_id: number
  base_version: number
  snapshot: string
  run_id: number | null
  actor_kind: string | null
  actor_name: string | null
  actor_client: string | null
  created_at: string
}

const SNAPSHOT_FIELDS = [
  'status',
  'format',
  'topic',
  'hook',
  'hook_alternates',
  'caption',
  'hashtags',
  'alt_text',
  'image_prompt',
  'stock_search_query',
  'reel_prompt',
  'image_url',
  'source_image_url',
  'reel_url',
  'canvas_json',
  'scene_json',
  'prompt_vars',
  'agent_output',
  'media_type',
  'media_provider',
  'angle',
  'pillar',
  'scheduled_at',
  'revision_comments',
] as const

export function snapshotFromPost(post: Post): Record<string, unknown> {
  const row = post as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { id: post.id, version: row.version ?? 1 }
  for (const key of SNAPSHOT_FIELDS) {
    out[key] = row[key] ?? null
  }
  return out
}

/**
 * Increment posts.version and insert a post_versions row for the new version.
 * Returns the bumped post.
 */
export function bumpAndSnapshot(
  postId: string | number,
  actorInput?: Parameters<typeof historyActorFrom>[0] | HistoryActor,
): Post {
  const actor =
    actorInput && 'kind' in actorInput && typeof (actorInput as HistoryActor).kind === 'string'
      ? (actorInput as HistoryActor)
      : historyActorFrom(actorInput as Parameters<typeof historyActorFrom>[0])
  const cols = actorColumns(actor)

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      'UPDATE posts SET version = COALESCE(version, 1) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(postId)

    const post = getPost(postId)
    if (!post) throw new ApiError(404, 'post not found after version bump')
    const version = Number((post as Post & { version?: number }).version ?? 1)
    const snap = JSON.stringify(snapshotFromPost(post))

    db.prepare(
      `INSERT INTO post_versions (post_id, version, snapshot, actor_kind, actor_name, actor_client)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(Number(post.id), version, snap, cols.actor_kind, cols.actor_name, cols.actor_client)

    db.exec('COMMIT')
    return post
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  }
}

/** Snapshot current post state without bumping (e.g. initial seed). */
export function recordSnapshot(
  postId: string | number,
  actorInput?: Parameters<typeof historyActorFrom>[0] | HistoryActor,
): PostVersionRow {
  const post = getPost(postId)
  if (!post) throw new ApiError(404, 'post not found')
  const actor =
    actorInput && 'kind' in actorInput && typeof (actorInput as HistoryActor).kind === 'string'
      ? (actorInput as HistoryActor)
      : historyActorFrom(actorInput as Parameters<typeof historyActorFrom>[0])
  const cols = actorColumns(actor)
  const version = Number((post as Post & { version?: number }).version ?? 1)
  const snap = JSON.stringify(snapshotFromPost(post))
  const info = db
    .prepare(
      `INSERT INTO post_versions (post_id, version, snapshot, actor_kind, actor_name, actor_client)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(post_id, version) DO UPDATE SET
         snapshot = excluded.snapshot,
         actor_kind = excluded.actor_kind,
         actor_name = excluded.actor_name,
         actor_client = excluded.actor_client`,
    )
    .run(Number(post.id), version, snap, cols.actor_kind, cols.actor_name, cols.actor_client)
  return db
    .prepare('SELECT * FROM post_versions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as PostVersionRow
}

export function listVersions(postId: string | number, limit = 50): PostVersionRow[] {
  return db
    .prepare(
      'SELECT * FROM post_versions WHERE post_id = ? ORDER BY version DESC LIMIT ?',
    )
    .all(Number(postId), Math.min(limit, 200)) as PostVersionRow[]
}

export function getVersion(postId: string | number, version: number): PostVersionRow | null {
  return (
    (db
      .prepare('SELECT * FROM post_versions WHERE post_id = ? AND version = ?')
      .get(Number(postId), version) as PostVersionRow | undefined) ?? null
  )
}

export function diffVersions(
  postId: string | number,
  fromVersion: number,
  toVersion: number,
): { from: number; to: number; changed: Record<string, { from: unknown; to: unknown }> } {
  const a = getVersion(postId, fromVersion)
  const b = getVersion(postId, toVersion)
  if (!a || !b) {
    throw new ApiError(404, `version snapshot missing (from=${fromVersion}, to=${toVersion})`)
  }
  const left = JSON.parse(a.snapshot) as Record<string, unknown>
  const right = JSON.parse(b.snapshot) as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const changed: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of keys) {
    const fv = left[key] ?? null
    const tv = right[key] ?? null
    if (JSON.stringify(fv) !== JSON.stringify(tv)) {
      changed[key] = { from: fv, to: tv }
    }
  }
  return { from: fromVersion, to: toVersion, changed }
}

/**
 * Store a run's proposed patch when the operator edited the post concurrently
 * (expected_version mismatch). Does not overwrite the live post.
 */
export function storeProposedVersion(opts: {
  postId: string | number
  baseVersion: number
  snapshot: Record<string, unknown>
  runId?: number | null
  actor?: HistoryActor | Parameters<typeof historyActorFrom>[0]
}): number {
  ensureProposedTable()
  const actor =
    opts.actor && 'kind' in opts.actor && typeof (opts.actor as HistoryActor).kind === 'string'
      ? (opts.actor as HistoryActor)
      : historyActorFrom(opts.actor as Parameters<typeof historyActorFrom>[0])
  const cols = actorColumns(actor)
  const info = db
    .prepare(
      `INSERT INTO post_proposed_versions
        (post_id, base_version, snapshot, run_id, actor_kind, actor_name, actor_client)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Number(opts.postId),
      opts.baseVersion,
      JSON.stringify(opts.snapshot),
      opts.runId ?? null,
      cols.actor_kind,
      cols.actor_name,
      cols.actor_client,
    )
  return Number(info.lastInsertRowid)
}

export function listProposedVersions(postId: string | number): ProposedVersionRow[] {
  ensureProposedTable()
  return db
    .prepare(
      'SELECT * FROM post_proposed_versions WHERE post_id = ? ORDER BY id DESC LIMIT 50',
    )
    .all(Number(postId)) as ProposedVersionRow[]
}

function ensureProposedTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_proposed_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id      INTEGER NOT NULL,
      base_version INTEGER NOT NULL,
      snapshot     TEXT NOT NULL,
      run_id       INTEGER,
      actor_kind   TEXT,
      actor_name   TEXT,
      actor_client TEXT,
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
}
