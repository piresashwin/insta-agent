/**
 * Idea-batch generation for Explore → Shortlist → Craft.
 */
import { z } from 'zod'
import type { PostFormat } from '@instagram-agent/shared'
import { generateObject } from '../llm/adapter'
import {
  renderContext,
  resolveBrandContextForBrand,
} from '../generation/brand-context'
import { getBrandProfile, parsePillars } from '../brand'

/** Map free-form model format strings → feed|reel|carousel. */
export function normalizeIdeaFormat(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const s = raw.trim().toLowerCase()
  if (s === 'feed' || s === 'reel' || s === 'carousel') return s
  if (/\breel\b/.test(s) || /\breels\b/.test(s) || s.includes('voiceover') || s.includes('video')) {
    return 'reel'
  }
  if (/\bcarousel\b/.test(s) || s.includes('multi-slide') || s.includes('multi slide') || s.includes('slides')) {
    return 'carousel'
  }
  if (
    /\bfeed\b/.test(s) ||
    s.includes('graphic') ||
    s.includes('static') ||
    s.includes('single image') ||
    s.includes('photo')
  ) {
    return 'feed'
  }
  return raw
}

function pickString(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

/** Accept common LLM aliases so a near-miss shape still parses. */
export function normalizeIdeaRow(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const o = raw as Record<string, unknown>
  const hooksRaw = o.hooks ?? o.hook_sketches ?? o.hookSketches ?? o.hook_ideas
  let hooks = hooksRaw
  if (typeof hooksRaw === 'string') {
    hooks = hooksRaw
      .split(/\n|•|;|\|/)
      .map((h) => h.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
  }
  return {
    topic: pickString(o, ['topic', 'title', 'idea', 'headline', 'name']),
    angle: pickString(o, ['angle', 'approach', 'perspective', 'take', 'spin']) ?? '',
    pillar: o.pillar ?? o.content_pillar ?? o.contentPillar ?? null,
    format: normalizeIdeaFormat(o.format ?? o.format_type ?? o.formatType ?? o.type),
    hooks,
    why:
      pickString(o, ['why', 'reason', 'rationale', 'because', 'fit']) ??
      '',
  }
}

const IdeaRowSchema = z.preprocess(
  normalizeIdeaRow,
  z.object({
    topic: z.string().min(3).max(200),
    angle: z.string().max(300),
    pillar: z.string().nullish(),
    format: z.preprocess(normalizeIdeaFormat, z.enum(['feed', 'reel', 'carousel'])),
    hooks: z.array(z.string().max(150)).min(2).max(3),
    why: z.string().max(200),
  }),
)

export const IdeaBatchSchema = z.object({
  ideas: z.array(IdeaRowSchema).min(1).max(20),
})

export type IdeaBatch = z.infer<typeof IdeaBatchSchema>

export async function generateIdeas(opts: {
  brandProfileId: number
  count: number
  steer?: string | null
  pillar?: string | null
  format?: PostFormat | null
  likeIdea?: { topic: string; angle: string | null; hooks: string[] } | null
  avoidTopics: string[]
  allowReels: boolean
}): Promise<IdeaBatch['ideas']> {
  const ctx = resolveBrandContextForBrand(opts.brandProfileId)
  const brandContext = renderContext(
    ctx,
    ['voice', 'audience', 'examples', 'hooks_memory', 'performance'],
    3000,
  )
  const brand = getBrandProfile(opts.brandProfileId)
  const pillars = parsePillars(brand?.pillars).map((p) => p.name)
  const avoid = opts.avoidTopics
    .slice(0, 40)
    .map((t) => t.slice(0, 120))
    .filter(Boolean)

  const system = `You are a creative strategist brainstorming Instagram post ideas for this brand. Ideas must be distinct from each other (different angles, not rewordings), native to Instagram, true to the brand voice, and spread across the brand's pillars unless a pillar is requested. Hooks: ≤125 characters, no unverifiable statistics. format must be exactly one of: feed, reel, carousel (never a phrase).`

  const lines: string[] = [
    `Generate exactly ${opts.count} distinct post ideas.`,
    `Each idea object keys: topic (string), angle (string), pillar (string|null), format ("feed"|"reel"|"carousel"), hooks (2-3 short strings), why (one sentence).`,
    pillars.length ? `Brand pillars: ${pillars.join(', ')}.` : '',
    opts.steer?.trim() ? `Steer / theme: ${opts.steer.trim()}` : '',
    opts.pillar?.trim() ? `Requested pillar: ${opts.pillar.trim()}` : '',
    opts.format ? `Requested format: ${opts.format}` : '',
    opts.allowReels === false ? 'Do not suggest reels. Use feed or carousel only.' : '',
  ]
  if (opts.likeIdea) {
    lines.push(
      `Riff on this idea — give variations that keep its core but change the angle, format or hook:\nTopic: ${opts.likeIdea.topic}\nAngle: ${opts.likeIdea.angle || '(none)'}\nHooks: ${opts.likeIdea.hooks.join(' | ')}`,
    )
  }
  if (avoid.length) {
    lines.push(`Avoid these existing topics / hooks:\n- ${avoid.join('\n- ')}`)
  }

  const result = await generateObject({
    role: 'planner',
    schema: IdeaBatchSchema,
    schemaName: 'idea_batch',
    skill: 'idea_generation',
    brandContext,
    maxOutputTokens: 1200,
    system,
    prompt: lines.filter(Boolean).join('\n\n'),
  })

  let ideas = result.data.ideas.map((idea) => ({
    ...idea,
    topic: idea.topic.trim(),
    angle: idea.angle.trim(),
    pillar: idea.pillar?.trim() || null,
    format: (!opts.allowReels && idea.format === 'reel'
      ? 'feed'
      : idea.format) as 'feed' | 'reel' | 'carousel',
    hooks: idea.hooks.map((h) => h.trim()).filter(Boolean).slice(0, 3),
    why: idea.why.trim(),
  }))

  return ideas.slice(0, opts.count)
}
