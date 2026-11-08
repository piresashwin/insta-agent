/**
 * Phase 4 — aggregated insights read APIs.
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import db from '../../db'
import { sendApiError } from '../helpers'
import { computePerformanceDigest } from '../../insights/digest'

export const insightsRouter: IRouter = Router()

insightsRouter.get('/account', (req: Request, res: Response) => {
  try {
    const accountId = String(req.query.account_id || '').trim()
    if (!accountId) return res.status(400).json({ error: 'account_id required' })

    const daily = db
      .prepare(
        `SELECT account_id, date, followers, reach, views, accounts_engaged, link_taps, final
         FROM ig_account_metrics_daily
         WHERE account_id = ?
         ORDER BY date DESC
         LIMIT 60`,
      )
      .all(accountId) as Array<{
      account_id: string
      date: string
      followers: number | null
      reach: number | null
      views: number | null
      accounts_engaged: number | null
      link_taps: number | null
      final: number
    }>

    const latestFollowers = daily.find((d) => d.followers != null)?.followers ?? null
    if (latestFollowers != null && latestFollowers < 100) {
      return res.json({
        account_id: accountId,
        daily: daily.map((d) => ({ ...d, final: d.final === 1 })),
        audience: { hidden: true as const, reason: 'fewer than 100 followers' },
        publish_markers: publishMarkers(accountId),
      })
    }

    const audience = db
      .prepare(
        `SELECT account_id, captured_at, follower_count_at_capture, demographics_json
         FROM ig_audience_snapshots
         WHERE account_id = ?
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .get(accountId) as
      | {
          account_id: string
          captured_at: string
          follower_count_at_capture: number | null
          demographics_json: string | null
        }
      | undefined

    res.json({
      account_id: accountId,
      daily: daily.map((d) => ({ ...d, final: d.final === 1 })),
      audience: audience ?? null,
      publish_markers: publishMarkers(accountId),
    })
  } catch (e) {
    sendApiError(res, e)
  }
})

insightsRouter.get('/digest', (req: Request, res: Response) => {
  try {
    const brandId = Number(req.query.brand_profile_id)
    if (!Number.isFinite(brandId)) {
      return res.status(400).json({ error: 'brand_profile_id required' })
    }
    res.json(computePerformanceDigest(brandId))
  } catch (e) {
    sendApiError(res, e)
  }
})

function publishMarkers(accountId: string): Array<{ date: string; media_id: string; thumbnail_url: string | null }> {
  return db
    .prepare(
      `SELECT id AS media_id, substr(timestamp, 1, 10) AS date, thumbnail_url
       FROM ig_media
       WHERE account_id = ? AND timestamp IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT 90`,
    )
    .all(accountId) as Array<{ date: string; media_id: string; thumbnail_url: string | null }>
}
