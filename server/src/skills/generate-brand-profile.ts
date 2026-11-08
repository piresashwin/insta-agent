/**
 * Autofill a brand profile draft from freeform operator feedback.
 * Uses chat OPENAI_* (LM Studio / OpenAI), not IMAGE_OPENAI_*.
 */
import { z } from 'zod'
import { BACKGROUND_STYLES } from '@instagram-agent/shared'
import { createStructuredModel } from './model'

const styleIds = BACKGROUND_STYLES.map((s) => s.id) as [string, ...string[]]

const DAY_ENUM = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

function normalizeDay(raw: string): z.infer<typeof DAY_ENUM> | null {
  const s = raw.trim().toLowerCase()
  const aliases: Record<string, z.infer<typeof DAY_ENUM>> = {
    mon: 'mon',
    monday: 'mon',
    tue: 'tue',
    tues: 'tue',
    tuesday: 'tue',
    wed: 'wed',
    wednesday: 'wed',
    thu: 'thu',
    thur: 'thu',
    thurs: 'thu',
    thursday: 'thu',
    fri: 'fri',
    friday: 'fri',
    sat: 'sat',
    saturday: 'sat',
    sun: 'sun',
    sunday: 'sun',
  }
  return aliases[s] || null
}

const BrandDraftSchema = z.object({
  name: z.string().describe('Short brand / account name'),
  niche: z.string(),
  audience: z.string(),
  goals: z.string().describe('What success looks like for this Instagram'),
  pillars: z
    .array(z.string())
    .min(2)
    .max(8)
    .describe('Content pillars / recurring themes'),
  posts_per_week: z.number().int().min(1).max(14),
  preferred_days: z
    .array(z.string())
    .min(1)
    .max(7)
    .transform((days, ctx) => {
      const out: Array<z.infer<typeof DAY_ENUM>> = []
      for (const d of days) {
        const n = normalizeDay(d)
        if (!n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid day "${d}" — use mon…sun`,
          })
          return z.NEVER
        }
        if (!out.includes(n)) out.push(n)
      }
      return out
    }),
  voice: z
    .string()
    .describe('Adjectives + do/don’t speaking rules for captions and hooks'),
  examples: z
    .string()
    .describe('2–3 good caption/hook examples and 1–2 bad ones to avoid'),
  visual: z
    .string()
    .describe('Visual style, lighting, must-include and must-avoid for images'),
  default_background_style: z.enum(styleIds as [typeof styleIds[0], ...typeof styleIds]),
  default_format: z.enum(['feed', 'reel', 'carousel']),
  default_max_slides: z.number().min(2).max(7).optional().default(5),
  guide_md: z
    .string()
    .describe('Short markdown guide summarizing brand for the agent'),
})

export type BrandDraftGenerated = z.infer<typeof BrandDraftSchema>

export async function generateBrandFromFeedback(opts: {
  feedback: string
  nameHint?: string | null
}): Promise<BrandDraftGenerated> {
  const feedback = opts.feedback.trim()
  if (!feedback) throw new Error('feedback is required')

  const model = createStructuredModel(BrandDraftSchema, {
    name: 'brand_profile_draft',
    temperature: 0.5,
  })

  const styles = BACKGROUND_STYLES.map((s) => `${s.id} (${s.label})`).join(', ')

  const prompt = `You help an Instagram operator fill a brand profile form from their notes.

Operator feedback:
"""
${feedback}
"""
${opts.nameHint?.trim() ? `Name hint (prefer if it fits): ${opts.nameHint.trim()}` : ''}

Infer a complete, concrete brand profile. Do not leave pillars or voice vague.
Pick default_background_style from: ${styles}
Prefer feed unless the brand is clearly Reels-first.
preferred_days should match a realistic posting cadence for posts_per_week.
guide_md should be usable as agent context (voice, audience, visual, pillars).`

  return model.invoke(prompt)
}
