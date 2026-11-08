import { Router, type IRouter, type Request, type Response } from 'express'
import db from '../../db'
import {
  getPublishTunnelStatus,
  setPublishTunnelUrl,
  startPublishTunnel,
  stopPublishTunnel,
} from '../../publish-tunnel'
import { getConn } from '../../instagram-oauth'

export const adminRouter: IRouter = Router()

// ---------- Publish tunnel (ephemeral HTTPS for Graph media fetch) ----------
adminRouter.get('/publish-tunnel', async (_req: Request, res: Response) => {
  try {
    res.json({ tunnel: await getPublishTunnelStatus() })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

/** Spawn cloudflared quick tunnel and persist URL in SQLite (publish reads live). */
adminRouter.post('/publish-tunnel', async (_req: Request, res: Response) => {
  try {
    const tunnel = await startPublishTunnel()
    res.json({ tunnel })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

/** Manually set tunnel URL (already-running cloudflared / external HTTPS). */
adminRouter.put('/publish-tunnel', async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { base_url?: string; url?: string }
    const url = (body.base_url || body.url || '').trim()
    if (!url) return res.status(400).json({ error: 'base_url required' })
    const tunnel = await setPublishTunnelUrl(url)
    res.json({ tunnel })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

adminRouter.delete('/publish-tunnel', async (_req: Request, res: Response) => {
  try {
    const tunnel = await stopPublishTunnel()
    res.json({ tunnel })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

adminRouter.get('/instagram/:id/auth-events', (req: Request, res: Response) => {
  const conn = getConn(req.params.id)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  const events = db
    .prepare(
      'SELECT id, conn_id, event, detail, created_at FROM auth_events WHERE conn_id = ? ORDER BY id DESC LIMIT 50'
    )
    .all(req.params.id)
    .map((e) => {
      const row = e as { detail: string }
      try {
        return { ...row, detail: JSON.parse(row.detail) }
      } catch {
        return e
      }
    })
  res.json({ events })
})
