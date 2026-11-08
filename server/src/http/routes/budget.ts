/**
 * Phase 2 — Budget endpoints.
 *
 * GET /api/budget       — month-to-date spend, forecast, by kind
 * POST /api/estimate    — cost label for a planned action
 * GET/POST /api/budget/settings — read/write budget caps from app_settings
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import db from '../../db'

export const budgetRouter: IRouter = Router()

type SettingRow = { key: string; value: string | null }

function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | SettingRow
    | undefined
  return row?.value ?? null
}

function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP'
  ).run(key, value)
}

/** Sum spend for the current calendar month. */
function monthlySpend(scope = 'prod'): number {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd),0) AS total FROM spend_ledger WHERE budget_scope=? AND estimated=0 AND created_at >= ?"
    )
    .get(scope, start.toISOString()) as { total: number }
  return row.total
}

function monthlySpendByKind(scope = 'prod'): Record<string, number> {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const rows = db
    .prepare(
      "SELECT kind, COALESCE(SUM(cost_usd),0) AS total FROM spend_ledger WHERE budget_scope=? AND estimated=0 AND created_at >= ? GROUP BY kind"
    )
    .all(scope, start.toISOString()) as Array<{ kind: string; total: number }>
  return Object.fromEntries(rows.map((r) => [r.kind, r.total]))
}

budgetRouter.get('/', (_req: Request, res: Response) => {
  const capStr = getSetting('budget_monthly_usd')
  const cap = capStr ? parseFloat(capStr) : 10

  const spent = monthlySpend()
  const byKind = monthlySpendByKind()

  // Forecast: days elapsed / days in month × spent
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dayOfMonth = now.getDate()
  const forecast = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : spent

  res.json({
    cap,
    spent,
    forecast: Math.min(forecast, cap * 1.5),
    remaining: Math.max(0, cap - spent),
    pct_used: cap > 0 ? (spent / cap) * 100 : 0,
    by_kind: byKind,
    at_capacity: spent >= cap,
  })
})

budgetRouter.get('/settings', (_req: Request, res: Response) => {
  res.json({
    budget_monthly_usd: parseFloat(getSetting('budget_monthly_usd') ?? '10'),
    budget_per_post_soft_usd: parseFloat(getSetting('budget_per_post_soft_usd') ?? '0.50'),
    budget_max_image_rerolls: parseInt(getSetting('budget_max_image_rerolls') ?? '2', 10),
    budget_max_reel_rerolls: parseInt(getSetting('budget_max_reel_rerolls') ?? '1', 10),
  })
})

budgetRouter.post('/settings', (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>
  const allowed = new Set([
    'budget_monthly_usd',
    'budget_per_post_soft_usd',
    'budget_max_image_rerolls',
    'budget_max_reel_rerolls',
  ])
  for (const [key, val] of Object.entries(body)) {
    if (!allowed.has(key)) continue
    setSetting(key, String(val))
  }
  res.json({ ok: true })
})

/** Rough cost estimate for a planned action (used for cost labels in the UI). */
budgetRouter.post('/estimate', (req: Request, res: Response) => {
  const body = (req.body || {}) as { kind?: string; format?: string; duration_sec?: number }
  const kind = (body.kind || 'text').toLowerCase()
  let estimate = 0

  switch (kind) {
    case 'agent_run':
      // Plan + hooks + caption + media brief + judge: ~$0.05 expected
      estimate = 0.05
      break
    case 'generate_image':
      estimate = 0.02 // Seedream Flash list price
      break
    case 'generate_reel': {
      const dur = Math.min(Math.max(Number(body.duration_sec || 8), 6), 15)
      estimate = dur * 0.04 // H3 Max Turbo list price $0.04/s
      break
    }
    case 'fill_week':
      estimate = 7 * 0.05 + 2 * 0.43 + 2 * 0.05 // text + 2 reels + 2 carousels
      break
    default:
      estimate = 0.01
  }

  const spent = monthlySpend()
  const capStr = getSetting('budget_monthly_usd')
  const cap = capStr ? parseFloat(capStr) : 10
  const wouldExceed = spent + estimate > cap

  res.json({ estimate, spent, cap, would_exceed: wouldExceed })
})
