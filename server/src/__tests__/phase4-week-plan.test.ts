import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(os.tmpdir(), `p4-week-${Math.random().toString(36).slice(2)}.db`)

const invoke = vi.fn(async () => ({
  proposals: [{ date: '2026-11-10', topic: 'T', pillar: 'edu', format: 'feed', angle: 'A' }],
}))

vi.mock('../skills/model', () => ({
  createStructuredModel: () => ({ invoke }),
}))

describe('planWeekTopics performanceSummary', () => {
  beforeEach(() => {
    invoke.mockClear()
  })

  it('splices performance into the prompt when provided, omits when not', async () => {
    const { planWeekTopics } = await import('../skills/week-plan')

    await planWeekTopics({
      brandBrief: 'A brand',
      dates: ['2026-11-10'],
      pillars: ['edu'],
      performanceSummary: 'Reels outperformed feed last month.',
    })
    expect(invoke).toHaveBeenCalled()
    const withPerf = String((invoke.mock.calls[0] as unknown[])?.[0] ?? '')
    expect(withPerf).toContain('What has worked recently')
    expect(withPerf).toContain('Reels outperformed feed last month.')

    invoke.mockClear()
    await planWeekTopics({
      brandBrief: 'A brand',
      dates: ['2026-11-10'],
      pillars: ['edu'],
    })
    const without = String((invoke.mock.calls[0] as unknown[])?.[0] ?? '')
    expect(without).not.toContain('What has worked recently')
  })
})
