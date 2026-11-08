/**
 * Shared fill-week for REST and MCP — dry_run defaults true.
 */
import type { BrandProfile, CalendarProposal, Post } from '@instagram-agent/shared'
import {
  createDraftFromProposal,
  getBrandProfile,
  parseFormatMix,
  parsePillars,
  parsePreferredDays,
  pickWeekDates,
  renderBrandBrief,
} from './brand'
import { ApiError } from './orchestrator'
import { assertAllowed, type PolicyActor } from './policy'
import { planWeekTopics } from './skills/week-plan'

export type FillWeekOpts = {
  week_start?: string | null
  count?: number | null
  /** Default true — preview only. Commit requires explicit false. */
  dry_run?: boolean
  proposals?: CalendarProposal[] | null
  account_id?: string | null
  /** Who initiates (dashboard human or MCP_OPERATOR). */
  actor?: PolicyActor | null
}

export type FillWeekResult =
  | { proposals: CalendarProposal[]; dry_run: true; brand: BrandProfile }
  | {
      proposals: CalendarProposal[]
      dry_run: false
      brand: BrandProfile
      posts: Post[]
    }

export async function fillWeekForBrand(
  brandId: string | number,
  opts: FillWeekOpts = {}
): Promise<FillWeekResult> {
  const brand = getBrandProfile(brandId)
  if (!brand) throw new ApiError(404, 'brand not found')

  const dryRun = opts.dry_run !== false
  const actor = opts.actor || null

  if (actor) {
    assertAllowed(
      actor,
      dryRun ? 'calendar.plan' : 'calendar.commit',
      { type: 'brand', brand }
    )
  }

  const weekStart = (opts.week_start || new Date().toISOString()).slice(0, 10)
  const count = Math.max(
    1,
    Math.min(14, Number(opts.count) || brand.posts_per_week || 3)
  )
  const days = parsePreferredDays(brand.preferred_days)
  const dates = pickWeekDates(weekStart, days, count)
  const pillars = parsePillars(brand.pillars).map((p) => p.name)
  // Phase 2: shrink reel share when monthly remaining budget is low.
  const { monthlyCap, monthlySpend, budgetAwareFormatMix } = await import('./services/budget')
  const remaining = Math.max(0, monthlyCap() - monthlySpend('prod'))
  const rawMix = parseFormatMix(brand.format_mix)
  const formatMix = rawMix
    ? (budgetAwareFormatMix(rawMix as unknown as Record<string, number>, remaining) as typeof rawMix)
    : rawMix

  let proposals: CalendarProposal[] = Array.isArray(opts.proposals) ? [...opts.proposals] : []
  if (!proposals.length) {
    let performanceSummary: string | null = null
    try {
      const { computePerformanceDigest, summarizeDigestForPrompt } = await import('./insights/digest')
      performanceSummary = summarizeDigestForPrompt(computePerformanceDigest(Number(brand.id)))
    } catch {
      performanceSummary = null
    }
    const planned = await planWeekTopics({
      brandBrief: renderBrandBrief(brand),
      dates,
      pillars,
      niche: brand.niche,
      audience: brand.audience,
      defaultFormat: brand.default_format,
      formatMix,
      performanceSummary,
    })
    proposals = planned.proposals.map((p, i) => ({
      date: p.date || dates[i] || dates[0],
      topic: p.topic,
      pillar: p.pillar,
      format: p.format || brand.default_format || 'feed',
      angle: p.angle,
      background_style: brand.default_background_style,
    }))
  }

  if (dryRun) {
    return { proposals, dry_run: true, brand }
  }

  const posts = proposals.map((proposal) => {
    const post = createDraftFromProposal({
      brand_profile_id: brand.id,
      account_id: opts.account_id || null,
      proposal,
    })
    if (actor) {
      assertAllowed(actor, 'post.draft', { type: 'post', post })
    }
    return post
  })

  return { proposals, dry_run: false, brand, posts }
}
