import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `budget-${Math.random().toString(36).slice(2)}.db`)

let db: typeof import('../db').default
let preflightPaidJob: typeof import('../services/budget').preflightPaidJob
let recordSpend: typeof import('../services/budget').recordSpend
let monthlySpend: typeof import('../services/budget').monthlySpend
let budgetAwareFormatMix: typeof import('../services/budget').budgetAwareFormatMix
let monthlyCap: typeof import('../services/budget').monthlyCap

beforeAll(async () => {
  db = (await import('../db')).default
  const b = await import('../services/budget')
  preflightPaidJob = b.preflightPaidJob
  recordSpend = b.recordSpend
  monthlySpend = b.monthlySpend
  budgetAwareFormatMix = b.budgetAwareFormatMix
  monthlyCap = b.monthlyCap

  db.prepare(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('budget_monthly_usd', '1.00')`,
  ).run()
})

describe('preflightPaidJob', () => {
  it('downgrades the tier when the full estimate would exceed the cap', () => {
    // Cap is $1. A full reel (~8*0.04=0.32) fits; force spend near cap.
    db.prepare('DELETE FROM spend_ledger').run()
    // Cap $1. Full 15s reel = $0.60; with $0.70 spent full exceeds, 6s downgrade ($0.24) fits.
    recordSpend({
      kind: 'video',
      provider: 'test',
      model: 't',
      cost_usd: 0.7,
      budget_scope: 'prod',
    })
    const result = preflightPaidJob({
      kind: 'generate_media',
      format: 'reel',
      duration_sec: 15,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.estimate.tier === 'downgraded' || result.estimate.tier === 'floor').toBe(true)
    }
  })

  it('blocks when even the floor exceeds the cap', () => {
    db.prepare('DELETE FROM spend_ledger').run()
    recordSpend({
      kind: 'text',
      provider: 'test',
      model: 't',
      cost_usd: 0.99,
      budget_scope: 'prod',
    })
    const result = preflightPaidJob({
      kind: 'generate_media',
      format: 'reel',
      duration_sec: 15,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('needs_budget_approval')
  })
})

describe('spend_ledger', () => {
  it('records actual cost; prod vs eval separated', () => {
    db.prepare('DELETE FROM spend_ledger').run()
    recordSpend({
      kind: 'text',
      provider: 'openai',
      model: 'gpt',
      cost_usd: 0.11,
      budget_scope: 'prod',
    })
    recordSpend({
      kind: 'text',
      provider: 'openai',
      model: 'gpt',
      cost_usd: 0.22,
      budget_scope: 'eval',
    })
    expect(monthlySpend('prod')).toBeCloseTo(0.11, 5)
    expect(monthlySpend('eval')).toBeCloseTo(0.22, 5)
    expect(monthlyCap()).toBe(1)
  })
})

describe('budgetAwareFormatMix', () => {
  it('reduces reel count when remaining budget is low', () => {
    const mix = budgetAwareFormatMix({ feed: 3, reel: 3, carousel: 1 }, 0.2)
    expect(mix.reel).toBeLessThan(3)
    expect(mix.reel).toBeLessThanOrEqual(0) // 0.2 / 0.24 < 1
  })
})
