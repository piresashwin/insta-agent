/** Propose a week of dated topics for a brand profile — format-first quotas. */
import { z } from 'zod'
import type { FormatMix, PostFormat } from '@instagram-agent/shared'
import { createStructuredModel } from './model'

const WeekPlanSchema = z.object({
  proposals: z
    .array(
      z.object({
        date: z.string().describe('YYYY-MM-DD'),
        topic: z.string(),
        pillar: z.string().nullish().transform((v) => v ?? null),
        format: z
          .enum(['feed', 'reel', 'carousel'])
          .nullish()
          .transform((v) => v ?? 'feed'),
        angle: z
          .string()
          .nullish()
          .transform((v) => (v && v.trim() ? v.trim() : '')),
      })
    )
    .min(1),
})

export type WeekPlan = z.infer<typeof WeekPlanSchema>
type Proposal = WeekPlan['proposals'][number]

function normalizeFormat(raw: string | null | undefined): PostFormat {
  const f = (raw || '').toLowerCase()
  if (f === 'reel' || f === 'carousel' || f === 'feed') return f
  return 'feed'
}

/** Default quotas when brand has no format_mix: n=1 feed; n=2 feed+reel; n≥3 feed+reel+carousel then fill. */
export function defaultFormatSlots(n: number): PostFormat[] {
  if (n <= 0) return []
  if (n === 1) return ['feed']
  if (n === 2) return ['feed', 'reel']
  const base: PostFormat[] = ['feed', 'reel', 'carousel']
  const out = [...base]
  const cycle: PostFormat[] = ['feed', 'reel', 'carousel']
  let i = 0
  while (out.length < n) {
    out.push(cycle[i % cycle.length])
    i++
  }
  return out.slice(0, n)
}

/** Expand FormatMix into an ordered slot list of length n. */
export function slotsFromFormatMix(n: number, mix: FormatMix | null | undefined): PostFormat[] {
  if (!mix || !Object.keys(mix).length) return defaultFormatSlots(n)
  const expanded: PostFormat[] = []
  const order: PostFormat[] = ['feed', 'reel', 'carousel']
  for (const f of order) {
    const count = Math.max(0, Math.floor(Number(mix[f]) || 0))
    for (let i = 0; i < count; i++) expanded.push(f)
  }
  if (!expanded.length) return defaultFormatSlots(n)
  if (expanded.length > n) return expanded.slice(0, n)
  const cycle = expanded.length ? expanded : defaultFormatSlots(Math.max(n, 3))
  let i = 0
  while (expanded.length < n) {
    expanded.push(cycle[i % cycle.length])
    i++
  }
  return expanded
}

/**
 * Assign formats from precomputed slots — never overwrite topic/angle;
 * only set format on each proposal by index.
 */
export function applyFormatSlots<T extends { format?: string | null }>(
  proposals: T[],
  slots: PostFormat[]
): T[] {
  return proposals.map((p, i) => ({
    ...p,
    format: slots[i] || normalizeFormat(p.format),
  }))
}

/** @deprecated Prefer format-first slotsFromFormatMix + applyFormatSlots */
export function ensureWeekFormatMix<T extends { format?: string | null }>(
  proposals: T[],
  defaultFormat?: string | null
): T[] {
  const slots = defaultFormatSlots(proposals.length)
  // Keep defaultFormat bias for leftover slots when n>3 already handled in defaultFormatSlots
  void defaultFormat
  return applyFormatSlots(proposals, slots)
}

function formatRoleHint(format: PostFormat): string {
  if (format === 'reel') return 'motion hook / talking point / quick tip (reel-friendly)'
  if (format === 'carousel') return 'step-by-step teach / list / before-after (carousel slides)'
  return 'single punchy still / one idea (feed)'
}

export async function planWeekTopics(opts: {
  brandBrief: string
  dates: string[]
  pillars: string[]
  niche?: string | null
  audience?: string | null
  defaultFormat?: string | null
  formatMix?: FormatMix | null
  /** Correlational performance hints from Phase 4 digest. */
  performanceSummary?: string | null
}): Promise<WeekPlan> {
  const model = createStructuredModel(WeekPlanSchema, { name: 'week_plan' })
  const n = opts.dates.length
  const slots = slotsFromFormatMix(n, opts.formatMix)
  const dateFormatLines = opts.dates
    .map((d, i) => `- ${d} → format MUST be "${slots[i]}" (${formatRoleHint(slots[i])})`)
    .join('\n')

  const perfBlock = opts.performanceSummary?.trim()
    ? `\nWhat has worked recently (correlational — suggest at most ±1 format-mix change, do not force):\n${opts.performanceSummary.trim()}\n`
    : ''

  const prompt = `You plan Instagram content for one week.

Brand brief:
${opts.brandBrief}

Niche: ${opts.niche || '(not set)'}
Audience: ${opts.audience || '(not set)'}
Pillars to rotate across: ${opts.pillars.join(', ') || '(general)'}
${perfBlock}
FORMAT IS PRE-ASSIGNED per date (do not change formats):
${dateFormatLines}

Each proposal MUST include:
- date (exact from the list)
- topic tailored to that date's format role
- pillar (from the list or null)
- format: MUST match the assigned format for that date
- angle: one short sentence on the take / POV for that format (never omit)

Topics must be on-brand and varied across pillars.`

  const result = (await model.invoke(prompt)) as WeekPlan
  // Re-align by date index; force formats from slots so model cannot collapse mix
  const byDate = new Map(result.proposals.map((p) => [p.date.slice(0, 10), p]))
  const proposals: Proposal[] = opts.dates.map((date, i) => {
    const p = byDate.get(date) || result.proposals[i]
    const topic = p?.topic || `Post for ${date}`
    return {
      date,
      topic,
      pillar: p?.pillar ?? null,
      format: slots[i],
      angle: (p?.angle && p.angle.trim()) || `Angle on: ${topic}`,
    }
  })

  return { proposals }
}
