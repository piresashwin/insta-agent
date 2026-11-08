/**
 * Phase 2 — Global event stream.
 *
 * GET /api/events   — SSE stream of post/brand/job/run changes.
 *
 * Clients use this for TanStack Query invalidation and change toasts.
 * Each event is: event: <kind>\ndata: <json>\n\n
 *
 * We poll two lightweight change-detection queries every 1 s:
 *   1. The latest run_event seq across all active runs.
 *   2. The latest post/brand/job updated_at timestamps.
 * When either changes, we emit a "change" event with the affected resource kinds.
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import db from '../../db'

export const eventsRouter: IRouter = Router()

type ChangeState = {
  maxRunEventSeq: number
  postTs: string
  jobTs: string
  brandTs: string
}

function readState(): ChangeState {
  const runRow = db
    .prepare("SELECT COALESCE(MAX(seq),0) AS s FROM run_events WHERE created_at >= datetime('now','-5 minutes')")
    .get() as { s: number }
  const postRow = db
    .prepare("SELECT COALESCE(MAX(updated_at),'') AS ts FROM posts")
    .get() as { ts: string }
  const jobRow = db
    .prepare("SELECT COALESCE(MAX(updated_at),'') AS ts FROM jobs")
    .get() as { ts: string }
  const brandRow = db
    .prepare("SELECT COALESCE(MAX(updated_at),'') AS ts FROM brand_profiles")
    .get() as { ts: string }
  return {
    maxRunEventSeq: runRow.s,
    postTs: postRow.ts,
    jobTs: jobRow.ts,
    brandTs: brandRow.ts,
  }
}

eventsRouter.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === 'function') {
    ;(res as Response & { flushHeaders: () => void }).flushHeaders()
  }

  const send = (event: string, data: unknown) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* client gone */ }
  }

  send('connected', { ts: new Date().toISOString() })

  let prev = readState()
  const maxMs = Number(process.env.SSE_MAX_MS || 30 * 60 * 1000)
  const tickMs = Number(process.env.SSE_POLL_MS || 1_000)
  const started = Date.now()

  const timer = setInterval(() => {
    try {
      if (Date.now() - started > maxMs) {
        send('timeout', { ts: new Date().toISOString() })
        clearInterval(timer)
        res.end()
        return
      }

      const next = readState()
      const changed: string[] = []

      if (next.maxRunEventSeq !== prev.maxRunEventSeq) changed.push('run')
      if (next.postTs !== prev.postTs) changed.push('post')
      if (next.jobTs !== prev.jobTs) changed.push('job')
      if (next.brandTs !== prev.brandTs) changed.push('brand')

      if (changed.length) {
        // Attach latest actor attribution when a post/job/run changed (best-effort).
        let actor: { kind: string; name: string; client?: string | null } | null = null
        try {
          if (changed.includes('post') || changed.includes('run')) {
            const row = db
              .prepare(
                `SELECT actor_kind AS kind, actor_name AS name, actor_client AS client
                 FROM post_versions ORDER BY id DESC LIMIT 1`,
              )
              .get() as { kind: string; name: string; client: string | null } | undefined
            if (row?.kind) actor = row
          }
        } catch {
          /* ignore */
        }
        send('change', { kinds: changed, actor, ts: new Date().toISOString() })
        prev = next
      }
    } catch {
      clearInterval(timer)
    }
  }, tickMs)

  req.on('close', () => {
    clearInterval(timer)
    res.end()
  })
})
