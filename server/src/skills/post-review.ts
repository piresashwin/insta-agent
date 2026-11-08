// Skill 4 — Critiques draft against Instagram checklist + 10-second gate.
import { z } from 'zod'
import { createStructuredModel } from './model'

const ReviewSchema = z.object({
  score: z.number().min(0).max(10),
  issues: z.array(z.string()).describe('Concrete problems found, [] only if truly none'),
  suggestions: z.array(z.string()).describe('Actionable rewrites/fixes, [] only if truly none'),
  approved: z
    .boolean()
    .describe('True only if score >= threshold AND all three gate questions pass'),
  gate: z.object({
    stop_scroll: z.boolean().describe('Would a stranger stop scrolling?'),
    value_without_caption: z
      .boolean()
      .describe('Can they learn a usable takeaway without opening the caption?'),
    save_or_send: z
      .boolean()
      .describe('Would they save this or send it to someone with the same problem?'),
  }),
  format_checks: z
    .array(z.string())
    .optional()
    .describe('Format-specific pass/fail notes (feed/reel/carousel checklist items)'),
})

export type ReviewResult = z.infer<typeof ReviewSchema>

const APPROVAL_THRESHOLD = 7
/** Deterministic lint failures cap the score below approval. */
const LINT_SCORE_CAP = 6

type ReviewPostArgs = {
  hook: string
  hookOnImage?: string
  caption: string
  hashtags: string
  format?: string
  imagePrompt?: string
  reelPrompt?: string
  brandVoice?: string
  job?: string
  audienceProblem?: string
  slides?: Array<{ text?: string; role?: string; image_prompt?: string }>
  beats?: Array<{ t_start?: number; visual_change?: string; on_screen_text_intent?: string }>
  durationSec?: number
  cta?: string
  firstLine?: string
  /** Deterministic rule failures from lintDraft — listed as automatic issues. */
  lintFailures?: string[]
}

async function reviewPost({
  hook,
  hookOnImage,
  caption,
  hashtags,
  format,
  imagePrompt,
  reelPrompt,
  brandVoice,
  job,
  audienceProblem,
  slides,
  beats,
  durationSec,
  cta,
  firstLine,
  lintFailures = [],
}: ReviewPostArgs) {
  const model = createStructuredModel(ReviewSchema, { name: 'post_review' })
  const fmt = (format || 'feed').toLowerCase()
  const slidesBlock =
    slides && slides.length
      ? `\nCarousel slides:\n${slides
          .map(
            (s, i) =>
              `${i + 1}. role=${s.role || '?'} text="${s.text || ''}" scene="${(s.image_prompt || '').slice(0, 120)}"`
          )
          .join('\n')}`
      : ''
  const beatsBlock =
    beats && beats.length
      ? `\nReel beats (clip length ${durationSec ?? '?'}s):\n${beats
          .map(
            (b) =>
              `${Number(b.t_start ?? 0).toFixed(1)}s: visual="${(b.visual_change || '').slice(0, 100)}" text="${b.on_screen_text_intent || ''}"`
          )
          .join('\n')}`
      : ''
  const lintBlock = lintFailures.length
    ? `\nAutomatic rule failures (already confirmed — include each in issues and propose a fix):\n- ${lintFailures.join('\n- ')}`
    : ''

  const formatChecklist =
    fmt === 'reel'
      ? `Reel checks: hook text + visual change by 1.5s; tip immediately; beat every ~1.5–3s; each line readable in its window; one idea + end CTA; text sits in the middle band (not under the caption/buttons UI).`
      : fmt === 'carousel'
        ? `Carousel checks: slide 1 hook ~6–10 words; one idea/slide; flow hook→why→steps→mistake→recap→CTA; last slide Save/Share; no filler.`
        : `Feed checks: on-image ≤12 words; visual SHOWS the tip (not lifestyle+opinion only); caption hook→tip→CTA; first line works before more.`

  const prompt = `You are reviewing a drafted Instagram post against a quality checklist before human approval.
Score honestly out of 10. Set approved=true ONLY if score >= ${APPROVAL_THRESHOLD} AND gate.stop_scroll AND gate.value_without_caption AND gate.save_or_send are all true.
Always list concrete issues and suggestions.

Universal checklist:
- One job (educate XOR entertain XOR feel_seen)
- Specific audience / named problem
- Hook = promise (works in preview / first 1–3s alone)
- Value without the caption (visual alone teaches)
- CTA matches format and is not engagement bait ("comment YES", "tag 3 friends", "like if", "link in bio")
- Truth test (hook delivers; no clickbait)
- Caption names the topic in plain words early (search), hashtags are few and specific

${formatChecklist}

10-second gate (set each boolean honestly):
1) stop_scroll — Would I stop scrolling?
2) value_without_caption — Do I learn something without the caption?
3) save_or_send — Would I save or send this?

Format: ${fmt}
Job: ${job || '(unspecified)'}
Audience problem: ${audienceProblem || '(unspecified)'}
Hook: ${hook}
On-image hook: ${hookOnImage || '(same as hook / unspecified)'}
First line (preview): ${firstLine || '(first line of caption)'}
Caption: ${caption}
CTA: ${cta || '(in caption)'}
Hashtags: ${hashtags}
Image prompt: ${imagePrompt || '(none)'}
Reel prompt: ${reelPrompt || '(none)'}
${slidesBlock}${beatsBlock}${lintBlock}
${brandVoice ? `Brand voice to check against: ${brandVoice}` : ''}

Fail hard on: pretty lifestyle scene + opinion lettering with tip only in caption; vague audience; missing Save/Share on carousel last slide; reel with no early hook.`

  const result = await model.invoke(prompt)
  const issues = [...(result.issues || [])]
  for (const f of lintFailures) {
    if (!issues.some((i) => i.includes(f))) issues.push(`[rule] ${f}`)
  }
  const score = lintFailures.length ? Math.min(result.score, LINT_SCORE_CAP) : result.score
  const gate = result.gate || {
    stop_scroll: false,
    value_without_caption: false,
    save_or_send: false,
  }
  const gatePass = Boolean(gate.stop_scroll && gate.value_without_caption && gate.save_or_send)
  const approved = Boolean(result.approved) && score >= APPROVAL_THRESHOLD && gatePass
  return {
    ...result,
    score,
    issues,
    gate,
    approved,
    lint: lintFailures,
  }
}

export { reviewPost, ReviewSchema, APPROVAL_THRESHOLD }
