import { Router, type IRouter, type Request, type Response } from 'express'
import { getRun, getRunWithEvents, listEventsAfter, listRuns } from '../../runs'
import { sendApiError } from '../helpers'

export const runsRouter: IRouter = Router()

runsRouter.get('/', (req: Request, res: Response) => {
  const limit = req.query.limit as string | undefined
  const postIdRaw = req.query.post_id
  const postId = postIdRaw != null ? Number(postIdRaw) : undefined
  const runs = listRuns({ limit, postId: Number.isFinite(postId) ? postId : undefined })
  res.json({ runs })
})

runsRouter.get('/:id', (req: Request, res: Response) => {
  const timeline = getRunWithEvents(Number(req.params.id))
  if (!timeline) return res.status(404).json({ error: 'run not found' })
  res.json(timeline)
})

/**
 * Lesson 10 — Server-Sent Events tail of run_events.
 * Query: ?after=<seq> to resume. Closes after run leaves "running".
 */
runsRouter.get('/:id/events', (req: Request, res: Response) => {
  const runId = Number(req.params.id)
  const run = getRun(runId)
  if (!run) return res.status(404).json({ error: 'run not found' })

  let afterSeq = Number(req.query.after || 0)
  if (!Number.isFinite(afterSeq) || afterSeq < 0) afterSeq = 0

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === 'function') {
    ;(res as Response & { flushHeaders: () => void }).flushHeaders()
  }

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  send('run_meta', {
    id: run.id,
    status: run.status,
    model: run.model,
    post_id: run.post_id,
    kind: run.kind,
  })

  for (const ev of listEventsAfter(runId, afterSeq)) {
    send('run_event', ev)
    afterSeq = Math.max(afterSeq, ev.seq)
  }

  if (run.status !== 'running') {
    send('run_done', { id: run.id, status: run.status, error: run.error })
    return res.end()
  }

  const started = Date.now()
  const maxMs = Number(process.env.SSE_MAX_MS || 10 * 60 * 1000)
  const tickMs = Number(process.env.SSE_POLL_MS || 500)

  const timer = setInterval(() => {
    try {
      if (Date.now() - started > maxMs) {
        send('run_done', { id: runId, status: 'timeout', error: 'SSE max duration reached' })
        clearInterval(timer)
        return res.end()
      }

      for (const ev of listEventsAfter(runId, afterSeq)) {
        send('run_event', ev)
        afterSeq = Math.max(afterSeq, ev.seq)
      }

      const latest = getRun(runId)
      if (!latest) {
        send('run_done', { id: runId, status: 'missing', error: 'run disappeared' })
        clearInterval(timer)
        return res.end()
      }
      if (latest.status !== 'running') {
        send('run_done', { id: latest.id, status: latest.status, error: latest.error })
        clearInterval(timer)
        return res.end()
      }

      res.write(`: ping ${Date.now()}\n\n`)
    } catch (e) {
      console.error('[sse]', e)
      clearInterval(timer)
      try {
        res.end()
      } catch {
        /* closed */
      }
    }
  }, tickMs)

  req.on('close', () => {
    clearInterval(timer)
  })
})

// Suppress unused import warning
void sendApiError
