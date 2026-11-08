import { z } from 'zod'
import crypto from 'crypto'
import { generateObject } from '../llm/adapter'
import type { BrandContextV2, RubricCriterion, BrandRubric } from '../generation/brand-context'
import db from '../db'

const RubricCriterionSchema = z.object({
  id: z.string().describe('Short snake_case id like "brand_fit" or "hook_quality"'),
  target: z.enum(['hook', 'caption', 'slides', 'visual', 'hashtags', 'cta']),
  weight: z.number().min(0.05).max(0.5).describe('Fraction of total score (all must sum to 1.0)'),
  description: z.string().describe('What this criterion measures, in 1-2 sentences'),
  pass_example: z.string().optional().describe('Example of a PASS for this criterion'),
  fail_example: z.string().optional().describe('Example of a FAIL for this criterion'),
  min_score: z.number().min(0).max(10).default(6).describe('Score threshold to pass (default 6)'),
})

const RubricSchema = z.object({
  criteria: z
    .array(RubricCriterionSchema)
    .min(4)
    .max(10)
    .describe(
      '4-10 criteria. Brand fit must have weight ≥ 0.30. All weights must sum to 1.0.'
    ),
  notes: z.string().optional().describe('Optional notes about how to apply this rubric'),
})

export type GenerateRubricResult = {
  rubric: BrandRubric
  saved: boolean
  version: number
}

export async function generateBrandRubric(ctx: BrandContextV2): Promise<GenerateRubricResult> {
  if (!ctx.profile?.id) {
    return generateEphemeralRubric(ctx)
  }

  const sourceHash = hashBrandContext(ctx)

  const system = `You are a brand content strategist. Generate an Instagram content rubric for this brand.
The rubric will be used to score every AI-generated post. It must reflect the brand's actual values and voice, not generic best practices.

RULES:
- Include exactly one "brand_fit" criterion with weight ≥ 0.30
- Weights must sum to exactly 1.00
- Target must be one of: hook, caption, slides, visual, hashtags, cta
- Include specific pass/fail examples drawn from this brand's voice and style
- Universal Instagram best-practice items get low weight (≤ 0.10 each)
- Favour criteria that would distinguish this brand's content from a generic account`

  const result = await generateObject({
    role: 'writer',
    schema: RubricSchema,
    system,
    prompt: buildRubricPrompt(ctx),
    schemaName: 'brand_rubric',
    maxOutputTokens: 2000,
  })

  const criteria = normalizeWeights(result.data.criteria)
  enforceBrandFitWeight(criteria)
  const rubric: BrandRubric = { criteria }

  const existing = db
    .prepare(
      'SELECT version FROM brand_rubrics WHERE brand_profile_id = ? ORDER BY version DESC LIMIT 1'
    )
    .get(ctx.profile.id) as { version: number } | undefined

  const nextVersion = (existing?.version ?? 0) + 1

  db.prepare(`
    INSERT INTO brand_rubrics (brand_profile_id, version, source_hash, rubric_json, edited_by_human)
    VALUES (?, ?, ?, ?, 0)
  `).run(ctx.profile.id, nextVersion, sourceHash, JSON.stringify(rubric))

  return { rubric: { ...rubric, version: nextVersion }, saved: true, version: nextVersion }
}

async function generateEphemeralRubric(ctx: BrandContextV2): Promise<GenerateRubricResult> {
  const result = await generateObject({
    role: 'writer',
    schema: RubricSchema,
    system:
      'Generate an Instagram content rubric. brand_fit must have weight ≥ 0.30, all weights sum to 1.0.',
    prompt: buildRubricPrompt(ctx),
    schemaName: 'brand_rubric',
    maxOutputTokens: 2000,
  })
  const criteria = normalizeWeights(result.data.criteria)
  enforceBrandFitWeight(criteria)
  return { rubric: { criteria }, saved: false, version: 0 }
}

function buildRubricPrompt(ctx: BrandContextV2): string {
  const parts: string[] = []
  if (ctx.profile?.name) parts.push(`Brand: ${ctx.profile.name}`)
  if (ctx.profile?.niche) parts.push(`Niche: ${ctx.profile.niche}`)
  if (ctx.audience) parts.push(`Audience: ${ctx.audience}`)
  if (ctx.voiceText) parts.push(`Voice:\n${ctx.voiceText}`)
  if (ctx.voiceRules.do?.length) parts.push(`Voice do: ${ctx.voiceRules.do.join('; ')}`)
  if (ctx.voiceRules.dont?.length) parts.push(`Voice don't: ${ctx.voiceRules.dont.join('; ')}`)
  if (ctx.pillars.length) {
    parts.push(
      `Pillars: ${ctx.pillars.map((p) => (p.notes ? `${p.name}: ${p.notes}` : p.name)).join('; ')}`
    )
  }
  if (ctx.visualText) parts.push(`Visual style:\n${ctx.visualText.slice(0, 400)}`)
  if (ctx.examples.length) {
    const ex = ctx.examples
      .slice(0, 2)
      .map(
        (e, i) => `${i + 1}. Hook: ${e.hook}${e.what_works ? ` — ${e.what_works}` : ''}`
      )
      .join('\n')
    parts.push(`Example posts:\n${ex}`)
  }
  return parts.join('\n\n') || 'No brand context available — create a generic rubric.'
}

function hashBrandContext(ctx: BrandContextV2): string {
  const key = [
    ctx.profile?.voice ?? '',
    ctx.profile?.niche ?? '',
    ctx.voiceText,
    JSON.stringify(ctx.voiceRules),
    JSON.stringify(ctx.pillars),
  ].join('|')
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function normalizeWeights(criteria: z.infer<typeof RubricCriterionSchema>[]): RubricCriterion[] {
  const total = criteria.reduce((s, c) => s + c.weight, 0)
  if (total <= 0) return criteria as RubricCriterion[]
  return criteria.map((c) => ({
    ...c,
    weight: Math.round((c.weight / total) * 100) / 100,
  }))
}

function enforceBrandFitWeight(criteria: RubricCriterion[]): void {
  const idx = criteria.findIndex(
    (c) => c.id === 'brand_fit' || c.description.toLowerCase().includes('brand fit')
  )
  if (idx === -1) {
    const brandFit: RubricCriterion = {
      id: 'brand_fit',
      target: 'caption',
      weight: 0.3,
      description:
        'Post content, voice and tone match the brand identity and would be unrecognizable as generic content.',
      min_score: 7,
    }
    const total = criteria.reduce((s, c) => s + c.weight, 0)
    if (total > 0) {
      const factor = 0.7 / total
      criteria.forEach((c) => {
        c.weight = Math.round(c.weight * factor * 100) / 100
      })
    }
    criteria.unshift(brandFit)
  } else if (criteria[idx].weight < 0.3) {
    const deficit = 0.3 - criteria[idx].weight
    criteria[idx].weight = 0.3
    const others = criteria.filter((_, i) => i !== idx)
    const othersTotal = others.reduce((s, c) => s + c.weight, 0)
    if (othersTotal > 0) {
      others.forEach((c) => {
        c.weight = Math.max(0.05, c.weight - deficit * (c.weight / othersTotal))
        c.weight = Math.round(c.weight * 100) / 100
      })
    }
  }
}
