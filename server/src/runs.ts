// Chapter 04 — durable agent runs + append-only event log.
import type { Run, RunEvent } from '@instagram-agent/shared'
import db from './db'

type CreateRunOpts = {
  goal: string
  postId?: number | null
  model?: string | null
  kind?: string
  actor_kind?: string | null
  actor_name?: string | null
  actor_client?: string | null
}

type ListRunsOpts = {
  limit?: number | string
  postId?: number
}

type RunEventRow = Omit<RunEvent, 'payload'> & { payload: string }

function createRun({
  goal,
  postId = null,
  model = null,
  kind = 'agent',
  actor_kind = null,
  actor_name = null,
  actor_client = null,
}: CreateRunOpts): Run {
  if (!goal || typeof goal !== 'string') {
    throw new Error('createRun requires a string goal')
  }
  const info = db
    .prepare(
      `INSERT INTO runs (post_id, goal, kind, status, model, actor_kind, actor_name, actor_client, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .run(postId, goal, kind, model, actor_kind, actor_name, actor_client)
  const run = getRun(Number(info.lastInsertRowid))
  if (!run) throw new Error('failed to create run')
  return run
}

function appendEvent(runId: number, type: string, payload: unknown = {}) {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_events WHERE run_id = ?')
    .get(runId) as { maxSeq: number } | undefined
  const seq = (row?.maxSeq || 0) + 1
  db.prepare(
    `INSERT INTO run_events (run_id, seq, type, payload, created_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(runId, seq, type, JSON.stringify(payload ?? {}))
  return { run_id: runId, seq, type, payload }
}

function completeRun(runId: number, status: 'succeeded' | 'failed' | 'needs_human', error: string | null = null) {
  if (!['succeeded', 'failed', 'needs_human'].includes(status)) {
    throw new Error(`invalid run status: ${status}`)
  }
  db.prepare(
    `UPDATE runs
     SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(status, error, runId)
  appendEvent(runId, 'status', { status, error })
  return getRun(runId)
}

function getRun(runId: number): Run | null {
  return (db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Run | undefined) || null
}

function mapEventRow(e: RunEventRow): RunEvent {
  return {
    ...e,
    payload: safeParse(e.payload) as Record<string, unknown>,
  }
}

function getRunWithEvents(runId: number): { run: Run; events: RunEvent[] } | null {
  const run = getRun(runId)
  if (!run) return null
  const events = (
    db
      .prepare(
        'SELECT id, run_id, seq, type, payload, created_at FROM run_events WHERE run_id = ? ORDER BY seq ASC'
      )
      .all(runId) as RunEventRow[]
  ).map(mapEventRow)
  return { run, events }
}

/** Lesson 10 — tail events after a sequence number (for SSE). */
function listEventsAfter(runId: number, afterSeq = 0): RunEvent[] {
  return (
    db
      .prepare(
        `SELECT id, run_id, seq, type, payload, created_at
         FROM run_events
         WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(runId, afterSeq) as RunEventRow[]
  ).map(mapEventRow)
}

function listRuns({ limit = 20, postId }: ListRunsOpts = {}): Run[] {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100)
  if (postId != null) {
    return db
      .prepare('SELECT * FROM runs WHERE post_id = ? ORDER BY id DESC LIMIT ?')
      .all(postId, lim) as Run[]
  }
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(lim) as Run[]
}

/**
 * Mark orphaned in-flight runs as failed (server restart / hung LLM).
 * maxAgeMs=0 → fail every status=running (boot-time orphan sweep).
 */
function failStaleRuns(maxAgeMs = Number(process.env.AGENT_STALE_RUN_MS || 10 * 60_000)): number {
  let stale: Array<{ id: number }>
  const liveJobGuard = `AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.run_id = runs.id AND j.status IN ('pending','running')
  )`
  if (maxAgeMs <= 0) {
    stale = db
      .prepare(`SELECT id FROM runs WHERE status = 'running' ${liveJobGuard}`)
      .all() as Array<{ id: number }>
  } else {
    // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"
    const ageSec = Math.max(30, Math.round(maxAgeMs / 1000))
    stale = db
      .prepare(
        `SELECT id FROM runs
         WHERE status = 'running'
           AND (julianday('now') - julianday(started_at)) * 86400.0 >= ?
           ${liveJobGuard}`,
      )
      .all(ageSec) as Array<{ id: number }>
  }
  const reason =
    maxAgeMs <= 0
      ? 'Aborted: orphaned running run (server restart)'
      : `Aborted: run still marked running after ${Math.round(maxAgeMs / 1000)}s (hung model or crash)`
  for (const row of stale) {
    completeRun(row.id, 'failed', reason)
  }
  return stale.length
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Shrink observation payloads so SQLite stays readable. */
function compactPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const copy = { ...(payload as Record<string, unknown>) }
  if (copy.data && typeof copy.data === 'object') {
    const keys = Object.keys(copy.data as object)
    copy.data = {
      _keys: keys,
      preview: JSON.stringify(copy.data).slice(0, 800),
    }
  }
  if (copy.args && typeof copy.args === 'object') {
    const s = JSON.stringify(copy.args)
    if (s.length > 1000) copy.args = { _truncated: true, preview: s.slice(0, 1000) }
  }
  if (copy.draft && typeof copy.draft === 'object') {
    const draft = copy.draft as Record<string, unknown>
    copy.draft = {
      _keys: Object.keys(draft),
      hook: draft.hook,
      format: draft.format,
    }
  }
  return copy
}

export {
  createRun,
  appendEvent,
  completeRun,
  getRun,
  getRunWithEvents,
  listEventsAfter,
  listRuns,
  failStaleRuns,
  compactPayload,
}
