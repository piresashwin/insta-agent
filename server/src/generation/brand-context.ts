/**
 * BrandContext v2 — typed brand object passed to every generation skill.
 * Replaces the flat-string approach in brand.ts:resolveBrandContext.
 */
import type {
  BrandPillar,
  BrandProfile,
  ExamplePost,
  HashtagSet,
  Post,
  PostFormat,
  VisualIdentity,
  VoiceRules,
} from '@instagram-agent/shared'
import db from '../db'
import { getBrandProfile, parseOverrides, parsePillars } from '../brand'
import { parseVisualIdentity } from '../prompts/format-templates'
import { clampMaxSlides } from '../slides'

// ─── Rubric types ──────────────────────────────────────────────────────────

export type RubricCriterion = {
  id: string
  target: 'hook' | 'caption' | 'slides' | 'visual' | 'hashtags' | 'cta'
  weight: number
  description: string
  pass_example?: string
  fail_example?: string
  min_score?: number
}

export type BrandRubric = {
  id?: number
  version?: number
  criteria: RubricCriterion[]
}

// ─── BrandContextV2 ────────────────────────────────────────────────────────

export type BrandContextV2 = {
  profile: BrandProfile | null
  voiceRules: VoiceRules
  voiceText: string
  examples: ExamplePost[]
  audience: string
  pillars: BrandPillar[]
  hashtagSets: HashtagSet[]
  visualIdentity: VisualIdentity
  visualText: string
  backgroundStyle: string | null
  rubric: BrandRubric | null
  recentHooks: string[]
  research?: string
  /** Correlational performance prose for planner/judge (omit when insufficient). */
  performanceSummary?: string | null
  format: PostFormat | string
  maxSlides: number
  timezone: string
}

// ─── Parsers ───────────────────────────────────────────────────────────────

function parseVoiceRules(raw: string | null | undefined): VoiceRules {
  if (!raw?.trim()) return {}
  try { return JSON.parse(raw) as VoiceRules } catch { return {} }
}

function parseExamplePosts(raw: string | null | undefined): ExamplePost[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter(
      (e): e is ExamplePost => !!e?.hook
    )
  } catch {}
  return []
}

function parseHashtagSets(raw: string | null | undefined): HashtagSet[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter(
      (s): s is HashtagSet => !!s?.name && Array.isArray((s as HashtagSet)?.tags)
    )
  } catch {}
  return []
}

function parseBrandRubric(raw: string | null | undefined): BrandRubric | null {
  if (!raw?.trim()) return null
  try { return JSON.parse(raw) as BrandRubric } catch { return null }
}

// ─── Recent hooks from DB ──────────────────────────────────────────────────

function getRecentHooks(brandProfileId: number | null | undefined, limit = 30): string[] {
  if (!brandProfileId) return []
  const rows = db.prepare(`
    SELECT hook FROM posts
    WHERE brand_profile_id = ? AND hook IS NOT NULL AND status NOT IN ('draft')
    ORDER BY created_at DESC LIMIT ?
  `).all(brandProfileId, limit) as Array<{ hook: string }>
  return rows.map((r) => r.hook).filter(Boolean)
}

// ─── Latest brand rubric from DB ──────────────────────────────────────────

function getLatestRubric(brandProfileId: number | null | undefined): BrandRubric | null {
  if (!brandProfileId) return null
  const row = db.prepare(`
    SELECT rubric_json FROM brand_rubrics
    WHERE brand_profile_id = ?
    ORDER BY version DESC LIMIT 1
  `).get(brandProfileId) as { rubric_json: string } | undefined
  return row ? parseBrandRubric(row.rubric_json) : null
}

// ─── Main resolver ─────────────────────────────────────────────────────────

export function resolveBrandContextV2(post: Post): BrandContextV2 {
  const profile = post.brand_profile_id ? getBrandProfile(post.brand_profile_id) : null
  const overrides = parseOverrides(post.brand_overrides)
  const identity = parseVisualIdentity(profile?.visual_identity)

  return {
    profile,
    voiceRules: parseVoiceRules(profile?.voice_rules),
    voiceText: [
      profile?.voice,
      overrides.tone && `Tone for this post: ${overrides.tone}`,
      overrides.voice_note,
      overrides.audience && `Audience focus: ${overrides.audience}`,
      overrides.hashtag_extra && `Hashtag extras: ${overrides.hashtag_extra}`,
    ].filter(Boolean).join('\n') || '',
    examples: parseExamplePosts(profile?.example_posts),
    audience: [
      profile?.audience,
      overrides.audience,
    ].filter(Boolean).join('. ') || '',
    pillars: parsePillars(profile?.pillars),
    hashtagSets: parseHashtagSets(profile?.hashtag_sets),
    visualIdentity: identity,
    visualText: [
      profile?.visual,
      profile?.visual_identity && `Structured identity JSON:\n${profile.visual_identity}`,
      overrides.visual_extra,
      overrides.image_prompt_extra && `Image direction: ${overrides.image_prompt_extra}`,
    ].filter(Boolean).join('\n') || '',
    backgroundStyle:
      overrides.background_style ||
      post.background_style ||
      profile?.default_background_style ||
      null,
    rubric: getLatestRubric(post.brand_profile_id),
    recentHooks: getRecentHooks(post.brand_profile_id),
    performanceSummary: loadPerformanceSummary(post.brand_profile_id),
    format: post.format || profile?.default_format || 'feed',
    maxSlides: clampMaxSlides(
      overrides.max_slides ?? profile?.default_max_slides ?? 5,
      5,
    ),
    timezone: profile?.timezone || 'UTC',
  }
}

/** Brand-level context without a real post (idea generation, digests). */
export function resolveBrandContextForBrand(brandProfileId: number): BrandContextV2 {
  return resolveBrandContextV2({
    id: 0,
    brand_profile_id: brandProfileId,
    format: null,
    brand_overrides: null,
    background_style: null,
  } as unknown as Post)
}

function loadPerformanceSummary(brandProfileId: number | null | undefined): string | null {
  if (!brandProfileId) return null
  try {
    // Lazy import — digest depends on db tables that may not exist in older unit tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computePerformanceDigest, summarizeDigestForPrompt } = require('../insights/digest') as typeof import('../insights/digest')
    return summarizeDigestForPrompt(computePerformanceDigest(brandProfileId))
  } catch {
    return null
  }
}

// ─── Visual identity guard ─────────────────────────────────────────────────

export function assertVisualIdentityReady(ctx: BrandContextV2): void {
  const vi = ctx.visualIdentity
  const hasPalette = vi.palette && Object.values(vi.palette).some(Boolean)
  const hasRenderStyle = !!vi.render_style?.trim()
  if (!hasPalette || !hasRenderStyle) {
    const missing = [
      !hasPalette && 'colour palette',
      !hasRenderStyle && 'render_style',
    ].filter(Boolean).join(' and ')
    const err = new Error(
      `Brand visual identity is incomplete (missing ${missing}). ` +
      `Set up the brand's visual identity before generating media.`
    )
    ;(err as Error & { status: number }).status = 422
    throw err
  }
}

// ─── Context rendering ─────────────────────────────────────────────────────

export type ContextSectionName =
  | 'voice'
  | 'examples'
  | 'audience'
  | 'hashtags'
  | 'visual'
  | 'rubric'
  | 'hooks_memory'
  | 'research'
  | 'performance'

type SectionSpec = {
  name: ContextSectionName
  priority: 1 | 2 | 3
}

const SECTION_PRIORITIES: SectionSpec[] = [
  { name: 'voice',        priority: 1 },
  { name: 'audience',     priority: 1 },
  { name: 'visual',       priority: 1 },
  { name: 'examples',     priority: 2 },
  { name: 'hashtags',     priority: 2 },
  { name: 'rubric',       priority: 2 },
  { name: 'research',     priority: 2 },
  { name: 'hooks_memory', priority: 3 },
  { name: 'performance',  priority: 3 },
]

function renderVoice(ctx: BrandContextV2): string {
  const rules = ctx.voiceRules
  const parts: string[] = []
  if (ctx.voiceText) parts.push(ctx.voiceText)
  if (rules.do?.length) parts.push(`Do: ${rules.do.join('; ')}`)
  if (rules.dont?.length) parts.push(`Don't: ${rules.dont.join('; ')}`)
  if (rules.banned_words?.length) parts.push(`Banned words: ${rules.banned_words.join(', ')}`)
  if (rules.emoji_policy) parts.push(`Emoji policy: ${rules.emoji_policy}`)
  if (rules.person) parts.push(`Person: ${rules.person}`)
  if (rules.caption_length) parts.push(`Caption length: ${rules.caption_length}`)
  if (rules.cta_styles?.length) parts.push(`CTA styles: ${rules.cta_styles.join('; ')}`)
  if (!parts.length) return ''
  return `## Voice\n${parts.join('\n')}`
}

function renderExamples(ctx: BrandContextV2): string {
  if (!ctx.examples.length) return ''
  const lines = ctx.examples.map((e, i) => {
    const parts = [`${i + 1}. Hook: ${e.hook}`]
    if (e.caption) parts.push(`   Caption: ${e.caption.slice(0, 200)}`)
    if (e.hashtags) parts.push(`   Hashtags: ${e.hashtags.split(/\s+/).slice(0, 5).join(' ')}`)
    if (e.what_works) parts.push(`   Why it works: ${e.what_works}`)
    return parts.join('\n')
  })
  return `## Examples (few-shot)\n${lines.join('\n\n')}`
}

function renderAudience(ctx: BrandContextV2): string {
  const parts: string[] = []
  if (ctx.profile?.name) parts.push(`Brand: ${ctx.profile.name}`)
  if (ctx.profile?.niche) parts.push(`Niche: ${ctx.profile.niche}`)
  if (ctx.audience) parts.push(`Audience: ${ctx.audience}`)
  if (ctx.profile?.goals) parts.push(`Goals: ${ctx.profile.goals}`)
  if (ctx.pillars.length) {
    const pillarStr = ctx.pillars
      .map((p) => (p.notes ? `${p.name}: ${p.notes}` : p.name))
      .join('; ')
    parts.push(`Pillars: ${pillarStr}`)
  }
  if (!parts.length) return ''
  return `## Brand\n${parts.join('\n')}`
}

function renderHashtags(ctx: BrandContextV2): string {
  if (!ctx.hashtagSets.length) return ''
  const lines = ctx.hashtagSets.map((s) => {
    const tags = s.tags.map((t) => `#${t}`).join(' ')
    const meta = [
      s.use_always && 'always',
      s.max_pick != null && `pick ${s.max_pick}`,
    ].filter(Boolean).join(', ')
    return `- ${s.name}${meta ? ` (${meta})` : ''}: ${tags}`
  })
  return `## Hashtag sets\n${lines.join('\n')}`
}

function renderVisual(ctx: BrandContextV2): string {
  if (!ctx.visualText) return ''
  return `## Visual identity\n${ctx.visualText}`
}

function renderRubric(ctx: BrandContextV2): string {
  if (!ctx.rubric) return ''
  const lines = ctx.rubric.criteria.map((c) =>
    `- [${c.target}] ${c.description} (weight ${(c.weight * 100).toFixed(0)}%)`
  )
  return `## Brand rubric\n${lines.join('\n')}`
}

function renderHooksMemory(ctx: BrandContextV2): string {
  if (!ctx.recentHooks.length) return ''
  const lines = ctx.recentHooks.slice(0, 10).map((h) => `- ${h}`)
  return `## Recent hooks (avoid near-duplicates)\n${lines.join('\n')}`
}

function renderResearch(ctx: BrandContextV2): string {
  if (!ctx.research) return ''
  return `## Research\n${ctx.research}`
}

function renderPerformance(ctx: BrandContextV2): string {
  if (!ctx.performanceSummary?.trim()) return ''
  return `## Performance (correlational)\n${ctx.performanceSummary.trim()}`
}

const SECTION_RENDERERS: Record<ContextSectionName, (ctx: BrandContextV2) => string> = {
  voice: renderVoice,
  examples: renderExamples,
  audience: renderAudience,
  hashtags: renderHashtags,
  visual: renderVisual,
  rubric: renderRubric,
  hooks_memory: renderHooksMemory,
  research: renderResearch,
  performance: renderPerformance,
}

/**
 * Render the brand context as a string for LLM system prompts.
 * Drops whole low-priority sections when over budget — never truncates mid-word.
 */
export function renderContext(
  ctx: BrandContextV2,
  sections: ContextSectionName[] = ['voice', 'audience', 'examples', 'hashtags', 'visual', 'research'],
  budget = 4000,
): string {
  const priorityMap = new Map(SECTION_PRIORITIES.map((s) => [s.name, s.priority]))
  const ordered = [...sections].sort(
    (a, b) => (priorityMap.get(a) ?? 3) - (priorityMap.get(b) ?? 3),
  )

  const rendered: string[] = []
  let used = 0

  for (const name of ordered) {
    const renderer = SECTION_RENDERERS[name]
    if (!renderer) continue
    const text = renderer(ctx)
    if (!text) continue
    if (used + text.length > budget) continue
    rendered.push(text)
    used += text.length + 2
  }

  return rendered.join('\n\n')
}

/**
 * Anthropic Messages API system block with prompt caching for stable brand context.
 * Callers that speak to Anthropic directly should send this as `system` (array form).
 */
export function anthropicBrandSystemBlocks(brandGuide: string): Array<{
  type: 'text'
  text: string
  cache_control: { type: 'ephemeral' }
}> {
  const text = brandGuide.trim()
  if (!text) return []
  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ]
}
