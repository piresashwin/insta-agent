/** Propose a week of dated topics for a brand profile. */
import { z } from 'zod'
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
        // Local models often omit angle — keep optional and default.
        angle: z
          .string()
          .nullish()
          .transform((v) => (v && v.trim() ? v.trim() : '')),
      })
    )
    .min(1),
})

export type WeekPlan = z.infer<typeof WeekPlanSchema>

export async function planWeekTopics(opts: {
  brandBrief: string
  dates: string[]
  pillars: string[]
  niche?: string | null
  audience?: string | null
  defaultFormat?: string | null
}): Promise<WeekPlan> {
  const model = createStructuredModel(WeekPlanSchema, { name: 'week_plan' })
  const prompt = `You plan Instagram content for one week.

Brand brief:
${opts.brandBrief}

Niche: ${opts.niche || '(not set)'}
Audience: ${opts.audience || '(not set)'}
Pillars to rotate across: ${opts.pillars.join(', ') || '(general)'}
Default format preference: ${opts.defaultFormat || 'feed'}

Assign exactly one proposal per date below (use these exact dates):
${opts.dates.map((d) => `- ${d}`).join('\n')}

Each proposal MUST include:
- date (exact from the list)
- topic (concrete post idea)
- pillar (from the list or null)
- format: feed | reel | carousel
- angle: one short sentence on the take / POV (never omit)

Topics must be on-brand and varied across pillars. Prefer the default format unless a reel clearly fits.`

  const result = (await model.invoke(prompt)) as WeekPlan
  // Ensure every proposal has a usable angle even if the model left it blank.
  return {
    proposals: result.proposals.map((p) => ({
      ...p,
      angle: p.angle || `Angle on: ${p.topic}`,
      format: p.format || 'feed',
    })),
  }
}
