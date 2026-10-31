/**
 * Autofill a brand profile draft from freeform operator feedback.
 * Uses chat OPENAI_* (LM Studio / OpenAI), not IMAGE_OPENAI_*.
 */
import { z } from 'zod'
import { BACKGROUND_STYLES } from '@instagram-agent/shared'
import { createStructuredModel } from './model'

const styleIds = BACKGROUND_STYLES.map((s) => s.id) as [string, ...string[]]

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
    .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
    .min(1)
    .max(7),
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
