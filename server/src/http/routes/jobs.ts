/**
 * Phase 2 — job progress API for the live UI.
 * GET /api/jobs?post_id=&status=&limit=
 * GET /api/jobs/:id
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import { getJob, listJobs } from '../../jobs'

export const jobsRouter: IRouter = Router()

jobsRouter.get('/', (req: Request, res: Response) => {
  const postIdRaw = req.query.post_id
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const limit = req.query.limit != null ? Number(req.query.limit) : 50
  const post_id =
    postIdRaw != null && String(postIdRaw).length ? Number(postIdRaw) : undefined
  const jobs = listJobs({
    limit,
    status,
    post_id: Number.isFinite(post_id) ? post_id : undefined,
  })
  res.json({ jobs })
})

jobsRouter.get('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid job id' })
  const job = getJob(id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  let result: unknown = null
  if (job.result_json) {
    try {
      result = JSON.parse(job.result_json)
    } catch {
      result = job.result_json
    }
  }
  res.json({ job: { ...job, result } })
})
