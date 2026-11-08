/**
 * Phase 2 — Activity feed.
 *
 * GET /api/activity?limit=50&kind=&actor_kind=
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import db from '../../db'

export const activityRouter: IRouter = Router()

type ActivityRow = {
  kind: string
  created_at: string
  post_id: number | null
  brand_id: number | null
  actor_kind: string | null
  actor_name: string | null
  actor_client: string | null
  detail_json: string
}

activityRouter.get('/', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 200)
  const kindFilter = typeof req.query.kind === 'string' ? req.query.kind : null
  const actorKindFilter = typeof req.query.actor_kind === 'string' ? req.query.actor_kind : null

  const parts: string[] = []
  const vals: (string | number)[] = []
  if (kindFilter) { parts.push('kind = ?'); vals.push(kindFilter) }
  if (actorKindFilter) { parts.push('actor_kind = ?'); vals.push(actorKindFilter) }
  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : ''

  const rows = db
    .prepare(`SELECT * FROM activity ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...vals, limit) as ActivityRow[]

  res.json({
    items: rows.map((r) => ({
      ...r,
      detail: (() => {
        try { return JSON.parse(r.detail_json) } catch { return {} }
      })(),
    })),
  })
})
