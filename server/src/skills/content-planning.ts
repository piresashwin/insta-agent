// Skill 1 — Turns a seed topic into a full concept.
import { z } from 'zod'
import { createStructuredModel } from './model'

const ContentPlanSchema = z.object({
  job: z
    .enum(['educate', 'entertain', 'feel_seen'])
    .describe('One job only: educate XOR entertain XOR make them feel seen'),
  audience: z.string().describe('Who this post is for, in a short phrase'),
  audience_problem: z
    .string()
    .describe('Named pain or desire this post addresses (specific, not vague crowd)'),
  hook: z
    .string()
    .describe('Caption/narrative hook — can be 1–2 sentences; curiosity or pain promise'),
  hook_on_image: z
    .string()
    .describe(
      'On-image / cover line only: ≤12 words, one scannable takeaway (step, check, number, before/after) — not a vague opinion'
    ),
  angle: z.string().describe('The specific angle/take on the topic — never empty'),
  format: z.enum(['reel', 'feed', 'carousel']),
  tone: z.string().describe('One word describing the tone'),
  hashtag_theme: z.string().describe('The theme to build hashtags around'),
  alt_hooks: z.array(z.string()).length(3).describe('Exactly 3 alternate hooks'),
})

export type ContentPlan = z.infer<typeof ContentPlanSchema>

type PlanContentArgs = {
  topic?: string
  audience?: string
  angle?: string
  brandGuide?: string
  brandConfig?: string
  /** From topic_research skill — facts/angles to ground the plan. */
  researchBrief?: string
  /** Prefer this format when set (calendar / operator). */
  preferredFormat?: string
  /** Reviewer + operator notes to address on a revision pass. */
  feedback?: string[]
  /** Operator-chosen hook from an idea (Idea → Post craft). */
  seedHook?: string | null
  /** Creative direction from the operator. */
  direction?: string | null
}

function clipOnImageHook(raw: string): string {
  const words = (raw || '').trim().split(/\s+/).filter(Boolean)
  if (words.length <= 12) return words.join(' ')
  return words.slice(0, 12).join(' ')
}

async function planContent({
  topic,
  audience,
  angle,
  brandGuide,
  brandConfig,
  researchBrief,
  preferredFormat,
  feedback,
  seedHook,
  direction,
}: PlanContentArgs) {
  const model = createStructuredModel(ContentPlanSchema, { name: 'content_plan' })
  const formatHint =
    preferredFormat && ['feed', 'reel', 'carousel'].includes(preferredFormat.toLowerCase())
      ? `\nPreferred format: ${preferredFormat.toLowerCase()} — set format to this unless it clearly cannot work.`
      : ''

  const seedHookBlock = seedHook?.trim()
    ? `\nOperator-chosen hook to build on (keep its idea; you may tighten the wording to meet the rules below). Use it as "hook"; alt_hooks must be different alternatives:\n"${seedHook.trim()}"\n`
    : ''
  const directionBlock = direction?.trim()
    ? `\nCreative direction from the operator (follow it unless it breaks the rules):\n${direction.trim()}\n`
    : ''

  const prompt = `You are an Instagram content planner. Turn this seed into a full content concept.

Topic: ${topic || 'general'}
${audience ? `Suggested audience: ${audience}` : ''}
${angle ? `Suggested angle: ${angle}` : ''}
${brandGuide ? `\nBrand guide:\n${brandGuide}` : ''}
${brandConfig ? `\nBrand config:\n${brandConfig}` : ''}
${
  researchBrief
    ? `\nTopic research (use this to ground hook + angle; prefer researched angles over generic takes):\n${researchBrief}\n`
    : ''
}${formatHint}
${feedback?.length ? `\nMust address (reviewer / operator feedback — change the plan accordingly):\n- ${feedback.join('\n- ')}\n` : ''}${seedHookBlock}${directionBlock}
Rules:
- Pick exactly ONE job: educate OR entertain OR feel_seen (not all three).
- audience_problem must name a concrete pain/desire (not "busy people" alone).
- hook = caption-side promise (1–2 sentences OK).
- hook_on_image = ≤12 words, usable takeaway a stranger can apply without the caption (step, check, number, before/after). Not a vague opinion.
- angle must never be empty.
- hashtag_theme = the niche + topic the hashtags should target (e.g. "home espresso for beginners"), not a single generic word.
When research is provided, pick one researched angle (or a tight synthesis) and avoid the listed clichés.`

  const plan = await model.invoke(prompt)
  return {
    ...plan,
    hook_on_image: clipOnImageHook(plan.hook_on_image || plan.hook),
  }
}

export { planContent, ContentPlanSchema }
