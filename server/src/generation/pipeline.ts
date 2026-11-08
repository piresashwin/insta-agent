/**
 * Deterministic content pipeline (Phase 1).
 * Pure — takes BrandContextV2 + run parameters, returns Draft + trace.
 * DB persistence lives in agent/start-run.ts.
 *
 * Flow:
 *   research → plan (hook + 3 alts) → judge picks best hook
 *   → media brief → caption
 *   → lint + rubric judge
 *   → route critique to owning skill → re-run → re-judge (≤2 rounds)
 */
import { z } from 'zod'
import { researchTopic, researchBriefToPromptBlock } from '../skills/topic-research'
import { planContent, type ContentPlan } from '../skills/content-planning'
import { writeCaption, type CaptionResult } from '../skills/caption-writing'
import { generateMediaPrompts } from '../skills/image-reel-generation'
import { lintDraft } from '../agent/lint'
import { generateObject } from '../llm/adapter'
import { renderContext } from './brand-context'
import type { BrandContextV2 } from './brand-context'
import type { PostFormat } from '@instagram-agent/shared'

// ─── Types ──────────────────────────────────────────────────────────────────

export type PipelineDraft = {
  hook: string
  hookOnImage: string
  caption: string
  firstLine: string
  cta: string
  hashtags: string
  altText: string
  altHooks: string[]
  imagePrompt?: string
  reelPrompt?: string
  slides?: Array<{ role?: string; text: string; image_prompt?: string }>
  beats?: Array<{ t_start?: number; on_screen_text_intent?: string }>
  format: string
  researchMode?: 'web' | 'model' | 'none'
  researchSources?: string[]
}

export type RubricScore = {
  criterion_id: string
  score: number
  passed: boolean
  note: string
}

export type CritiqueItem = {
  target: 'hook' | 'caption' | 'slides' | 'visual' | 'hashtags' | 'cta'
  criterion_id: string
  problem: string
  fix: string
  severity: 'must_fix' | 'should_fix' | 'nice_to_have'
}

export type PipelineReview = {
  overallScore: number
  passed: boolean
  rubricScores: RubricScore[]
  critiqueItems: CritiqueItem[]
  lintFailures: string[]
}

export type PipelineTrace = {
  steps: Array<{ name: string; durationMs: number; detail?: Record<string, unknown> }>
  rounds: number
  researchMode?: 'web' | 'model' | 'none'
  hookChosen?: string
  hookAlternates?: string[]
}

export type PipelineResult = {
  draft: PipelineDraft
  review: PipelineReview
  trace: PipelineTrace
}

export type PipelineOpts = {
  topic: string
  angle?: string | null
  pillar?: string | null
  format?: PostFormat | string | null
  feedback?: string[]
  /** Operator-chosen hook from linked idea. */
  seedHook?: string | null
  /** Creative direction from linked idea. */
  direction?: string | null
  onStep?: (step: string, detail?: Record<string, unknown>) => void | Promise<void>
}

// ─── Judge schemas ───────────────────────────────────────────────────────────

const HookPickSchema = z.object({
  winner_index: z.number().int().min(0).max(3).describe('0-based index of the best hook'),
  reasoning: z.string().describe('One sentence explaining why'),
})

const RubricJudgeSchema = z.object({
  scores: z.array(
    z.object({
      criterion_id: z.string(),
      score: z.number().min(0).max(10),
      note: z.string().describe('One sentence explaining the score'),
      passed: z.boolean(),
    })
  ),
  items: z.array(
    z.object({
      target: z.enum(['hook', 'caption', 'slides', 'visual', 'hashtags', 'cta']),
      criterion_id: z.string(),
      problem: z.string(),
      fix: z.string().describe('Specific actionable fix'),
      severity: z.enum(['must_fix', 'should_fix', 'nice_to_have']),
    })
  ),
  overall_score: z.number().min(0).max(10),
})

// ─── Pipeline ────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 2

export async function runPipeline(
  ctx: BrandContextV2,
  opts: PipelineOpts
): Promise<PipelineResult> {
  const notify = async (step: string, detail?: Record<string, unknown>) => {
    try {
      await opts.onStep?.(step, detail)
    } catch {
      // monitoring must not break pipeline
    }
  }

  const trace: PipelineTrace = { steps: [], rounds: 0 }
  const addStep = (name: string, start: number, detail?: Record<string, unknown>) => {
    trace.steps.push({ name, durationMs: Date.now() - start, detail })
  }

  // ── 1. Research ───────────────────────────────────────────────────────────
  let researchBrief: string | undefined
  let researchMode: 'web' | 'model' | 'none' = 'none'
  let researchSources: string[] = []

  if (opts.topic?.trim() && process.env.AGENT_SKIP_RESEARCH !== '1') {
    const t0 = Date.now()
    await notify('research', { status: 'running' })
    try {
      const briefCtx = renderContext(ctx, ['audience', 'voice'], 600)
      const research = await researchTopic({
        topic: opts.topic,
        angle: opts.angle,
        pillar: opts.pillar,
        brandGuide: briefCtx,
      })
      researchBrief = researchBriefToPromptBlock(research)
      researchMode = research.mode
      researchSources = research.source_lines ?? []
      ctx = { ...ctx, research: researchBrief }
      await notify('research', { status: 'done', mode: research.mode })
    } catch (err) {
      await notify('research', { status: 'failed', error: (err as Error).message })
    }
    addStep('research', t0, { mode: researchMode })
  }

  // ── 2. Plan ───────────────────────────────────────────────────────────────
  const t1 = Date.now()
  await notify('plan', { status: 'running' })
  const brandGuide = renderContext(ctx, ['voice', 'audience', 'examples', 'performance'], 3500)
  const plan = await planContent({
    topic: opts.topic,
    audience: ctx.audience || undefined,
    angle: opts.angle ?? undefined,
    brandGuide,
    brandConfig: ctx.profile?.guide_md ?? undefined,
    researchBrief,
    preferredFormat: opts.format ?? undefined,
    feedback: opts.feedback,
    seedHook: opts.seedHook,
    direction: opts.direction,
  })
  addStep('plan', t1, { hook: plan.hook, format: plan.format })
  await notify('plan', { status: 'done', hook: plan.hook, format: plan.format })

  // ── 3. Judge picks best hook ───────────────────────────────────────────────
  const t2 = Date.now()
  const allHooks = [plan.hook, ...(plan.alt_hooks ?? [])]
  let chosenHook = plan.hook
  let chosenPlan = plan

  if (allHooks.length >= 2 && ctx.rubric) {
    try {
      const hookCriteria = ctx.rubric.criteria
        .filter((c) => c.target === 'hook')
        .map((c) => `- ${c.description}`)
        .join('\n') ||
        '- Strong curiosity or pain promise\n- Brand voice match\n- Specific, not generic'

      const pick = await generateObject({
        role: 'judge',
        schema: HookPickSchema,
        system: 'You are a content judge. Pick the hook that best matches the brand criteria.',
        brandContext: brandGuide,
        prompt: `Pick the best hook for this brand's Instagram post.

Brand: ${ctx.profile?.name ?? 'Unknown'}
Topic: ${opts.topic}
Hook criteria:
${hookCriteria}

Hooks (0-indexed):
${allHooks.map((h, i) => `${i}. ${h}`).join('\n')}

Return winner_index (0-based) and one sentence of reasoning.`,
        schemaName: 'hook_pick',
        maxOutputTokens: 200,
      })

      const idx = Math.min(pick.data.winner_index, allHooks.length - 1)
      chosenHook = allHooks[idx]
      chosenPlan = { ...plan, hook: chosenHook }
    } catch {
      // keep original plan hook on judge failure
    }
  }

  trace.hookChosen = chosenHook
  trace.hookAlternates = allHooks.filter((h) => h !== chosenHook)
  addStep('hook_pick', t2)

  // ── 4. Media brief ────────────────────────────────────────────────────────
  const t3 = Date.now()
  await notify('media', { status: 'running' })
  const visualCtx = renderContext(ctx, ['visual'], 1500)
  const mediaResult = await generateMediaPrompts({
    hook: chosenHook,
    hookOnImage: chosenPlan.hook_on_image,
    angle: chosenPlan.angle,
    format: chosenPlan.format,
    maxSlides: ctx.maxSlides,
    brandVisual: visualCtx,
    backgroundStyle: ctx.backgroundStyle ?? undefined,
  })
  addStep('media', t3, { format: chosenPlan.format })
  await notify('media', { status: 'done', format: chosenPlan.format })

  // ── 5. Caption ────────────────────────────────────────────────────────────
  const t4 = Date.now()
  await notify('caption', { status: 'running' })
  const voiceCtx = renderContext(ctx, ['voice', 'hashtags'], 2000)
  const captionResult = await writeCaption({
    hook: chosenHook,
    hookOnImage: chosenPlan.hook_on_image,
    angle: chosenPlan.angle,
    format: chosenPlan.format,
    brandVoice: voiceCtx,
    targetAudience: ctx.audience || undefined,
    job: chosenPlan.job,
    audienceProblem: chosenPlan.audience_problem,
    hashtagTheme: chosenPlan.hashtag_theme,
    slides: mediaResult.slides?.map((s: { text: string; role?: string; image_prompt?: string }) => ({ text: s.text, role: s.role })),
    beats: mediaResult.beats?.map((b: { t_start?: number; on_screen_text_intent?: string }) => ({
      t_start: b.t_start,
      on_screen_text_intent: b.on_screen_text_intent,
    })),
  })
  addStep('caption', t4)
  await notify('caption', { status: 'done' })

  // ── Build initial draft ───────────────────────────────────────────────────
  let draft = buildDraft(chosenPlan, mediaResult, captionResult, {
    format: chosenPlan.format,
    altHooks: allHooks.filter((h) => h !== chosenHook),
    researchMode,
    researchSources,
  })

  // ── 6-9. Review loop ──────────────────────────────────────────────────────
  let review: PipelineReview = {
    overallScore: 0,
    passed: false,
    rubricScores: [],
    critiqueItems: [],
    lintFailures: [],
  }
  let bestDraft = draft
  let bestScore = -1

  for (let round = 0; round < MAX_ROUNDS; round++) {
    trace.rounds = round + 1
    const tR = Date.now()
    await notify('review', { status: 'running', round })

    const lintFailures = lintDraft({
      format: draft.format,
      hook_on_image: draft.hookOnImage,
      caption: draft.caption,
      hashtags: draft.hashtags,
      first_line: draft.firstLine,
      cta: draft.cta,
      slides: draft.slides,
      beats: draft.beats,
    })

    review = await judgeWithRubric(draft, ctx, lintFailures)
    addStep(`review_round_${round}`, tR, { score: review.overallScore, passed: review.passed })
    await notify('review', {
      status: 'done',
      score: review.overallScore,
      passed: review.passed,
      round,
    })

    if (review.overallScore > bestScore) {
      bestScore = review.overallScore
      bestDraft = { ...draft }
    }

    const mustFix = review.critiqueItems.filter((i) => i.severity === 'must_fix')
    if (review.passed || mustFix.length === 0 || round === MAX_ROUNDS - 1) break

    // ── Revision ──────────────────────────────────────────────────────────
    const tRev = Date.now()
    await notify('revision', { status: 'running', round, fixes: mustFix.length })

    const hookItems = mustFix.filter((i) => i.target === 'hook')
    const captionItems = mustFix.filter(
      (i) => i.target === 'caption' || i.target === 'hashtags' || i.target === 'cta'
    )
    const mediaItems = mustFix.filter(
      (i) => i.target === 'slides' || i.target === 'visual'
    )

    if (hookItems.length > 0) {
      try {
        const revisedPlan = await planContent({
          topic: opts.topic,
          audience: ctx.audience || undefined,
          angle: opts.angle ?? undefined,
          brandGuide,
          researchBrief,
          preferredFormat: chosenPlan.format,
          feedback: hookItems.map((i) => i.fix),
        })
        chosenPlan = revisedPlan
        draft = {
          ...draft,
          hook: revisedPlan.hook,
          hookOnImage: revisedPlan.hook_on_image,
          altHooks: revisedPlan.alt_hooks ?? [],
        }
      } catch {
        // keep existing
      }
    }

    if (captionItems.length > 0) {
      try {
        const revisedCaption = await writeCaption({
          hook: draft.hook,
          hookOnImage: draft.hookOnImage,
          angle: chosenPlan.angle,
          format: draft.format,
          brandVoice: voiceCtx,
          targetAudience: ctx.audience || undefined,
          job: chosenPlan.job,
          audienceProblem: chosenPlan.audience_problem,
          hashtagTheme: chosenPlan.hashtag_theme,
          slides: draft.slides?.map((s) => ({ text: s.text, role: s.role })),
          beats: draft.beats?.map((b) => ({
            t_start: b.t_start,
            on_screen_text_intent: b.on_screen_text_intent,
          })),
          feedback: captionItems.map((i) => i.fix),
        })
        draft = {
          ...draft,
          caption: revisedCaption.caption,
          firstLine: revisedCaption.first_line,
          cta: revisedCaption.cta,
          hashtags: revisedCaption.hashtags,
          altText: revisedCaption.alt_text,
        }
      } catch {
        // keep existing
      }
    }

    if (mediaItems.length > 0) {
      try {
        const revisedMedia = await generateMediaPrompts({
          hook: draft.hook,
          hookOnImage: draft.hookOnImage,
          angle: chosenPlan.angle,
          format: draft.format,
          maxSlides: ctx.maxSlides,
          brandVisual: visualCtx,
          backgroundStyle: ctx.backgroundStyle ?? undefined,
          feedback: mediaItems.map((i) => i.fix),
        })
        draft = {
          ...draft,
          imagePrompt: revisedMedia.image_prompt,
          reelPrompt: revisedMedia.reel_prompt,
          slides: revisedMedia.slides?.map((s: { text: string; role?: string; image_prompt?: string }) => ({
            role: s.role,
            text: s.text,
            image_prompt: s.image_prompt,
          })),
          beats: revisedMedia.beats?.map((b: { t_start?: number; on_screen_text_intent?: string }) => ({
            t_start: b.t_start,
            on_screen_text_intent: b.on_screen_text_intent,
          })),
        }
      } catch {
        // keep existing
      }
    }

    addStep(`revision_round_${round}`, tRev)
    await notify('revision', { status: 'done', round })
  }

  return { draft: bestDraft, review, trace }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDraft(
  plan: ContentPlan,
  media: Awaited<ReturnType<typeof generateMediaPrompts>>,
  caption: CaptionResult,
  extra: {
    format: string
    altHooks: string[]
    researchMode: 'web' | 'model' | 'none'
    researchSources: string[]
  }
): PipelineDraft {
  return {
    hook: plan.hook,
    hookOnImage: plan.hook_on_image,
    caption: caption.caption,
    firstLine: caption.first_line,
    cta: caption.cta,
    hashtags: caption.hashtags,
    altText: caption.alt_text,
    altHooks: extra.altHooks,
    imagePrompt: media.image_prompt,
    reelPrompt: media.reel_prompt,
    slides: media.slides?.map((s: { text: string; role?: string; image_prompt?: string }) => ({
      role: s.role,
      text: s.text,
      image_prompt: s.image_prompt,
    })),
    beats: media.beats?.map((b: { t_start?: number; on_screen_text_intent?: string }) => ({
      t_start: b.t_start,
      on_screen_text_intent: b.on_screen_text_intent,
    })),
    format: extra.format,
    researchMode: extra.researchMode,
    researchSources: extra.researchSources,
  }
}

async function judgeWithRubric(
  draft: PipelineDraft,
  ctx: BrandContextV2,
  lintFailures: string[]
): Promise<PipelineReview> {
  const rubric = ctx.rubric
  if (!rubric?.criteria.length) {
    return {
      overallScore: 7,
      passed: true,
      rubricScores: [],
      critiqueItems: lintFailures.map((f) => ({
        target: 'caption' as const,
        criterion_id: 'lint',
        problem: f,
        fix: f,
        severity: 'must_fix' as const,
      })),
      lintFailures,
    }
  }

  const criteriaBlock = rubric.criteria
    .map(
      (c) =>
        `[${c.id}] ${c.description} (weight ${(c.weight * 100).toFixed(0)}%, target: ${c.target})`
    )
    .join('\n')

  const draftBlock = [
    `Hook: ${draft.hook}`,
    `On-image: ${draft.hookOnImage}`,
    `First line: ${draft.firstLine}`,
    `Caption: ${draft.caption.slice(0, 500)}${draft.caption.length > 500 ? '…' : ''}`,
    `Hashtags: ${draft.hashtags}`,
    draft.slides?.length
      ? `Slides: ${draft.slides.map((s, i) => `${i + 1}. ${s.text}`).join(' | ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  const lintBlock = lintFailures.length
    ? `\nDeterministic failures (must address):\n${lintFailures.map((f) => `- ${f}`).join('\n')}`
    : ''

  try {
    const perfGuide = renderContext(ctx, ['performance'], 800)
    const result = await generateObject({
      role: 'judge',
      schema: RubricJudgeSchema,
      system: `You are a brand content judge. Score this Instagram post against each criterion.
Be critical but fair. A score of 7+ means passing for that criterion.
Return criterion_id values exactly as listed.`,
      brandContext: perfGuide || undefined,
      prompt: `Brand rubric criteria:
${criteriaBlock}
${lintBlock}

Post draft:
${draftBlock}

For each criterion, return a score (0-10), whether it passed (score ≥ 6), and a one-sentence note.
For any criterion scoring below 7, add a critique item with a specific actionable fix.`,
      schemaName: 'rubric_judge',
      maxOutputTokens: 600,
    })

    return {
      overallScore: result.data.overall_score,
      passed: result.data.overall_score >= 7 && lintFailures.length === 0,
      rubricScores: result.data.scores.map((s) => ({
        criterion_id: s.criterion_id,
        score: s.score,
        passed: s.passed,
        note: s.note,
      })),
      critiqueItems: result.data.items as CritiqueItem[],
      lintFailures,
    }
  } catch {
    return {
      overallScore: 6.5,
      passed: lintFailures.length === 0,
      rubricScores: [],
      critiqueItems: lintFailures.map((f) => ({
        target: 'caption' as const,
        criterion_id: 'lint',
        problem: f,
        fix: f,
        severity: 'must_fix' as const,
      })),
      lintFailures,
    }
  }
}
