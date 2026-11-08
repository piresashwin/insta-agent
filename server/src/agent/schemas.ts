// Zod contracts for the Chapter 03 agent loop decisions and finish payload.
import { z } from 'zod'
import { ContentPlanSchema } from '../skills/content-planning'

const DecisionSchema = z.object({
  thought: z.string().optional().describe('Short rationale for logs (one sentence)'),
  tool: z
    .enum([
      'topic_research',
      'content_planning',
      'caption_writing',
      'media_prompts',
      'post_review',
      'finish',
    ])
    .describe('Which tool to run next'),
  args: z.record(z.any()).default({}).describe('Arguments for the chosen tool'),
})

const FinishSlideSchema = z.object({
  text: z.string().describe('On-image text for this carousel slide'),
  image_prompt: z.string().describe('Visual brief for this slide'),
  stock_search_query: z.string().describe('Pexels keywords for this slide'),
  role: z
    .enum(['cover', 'why', 'step', 'mistake', 'recap', 'point', 'cta'])
    .optional()
    .describe('Slide role in teaching flow'),
  alt_text: z.string().optional().describe('Accessibility alt text for this slide'),
})

const ReelBeatSchema = z.object({
  t_start: z.number().describe('Beat start time in seconds'),
  visual_change: z.string().describe('What changes on screen at this beat'),
  on_screen_text_intent: z
    .string()
    .describe('Short on-screen line intent for this beat (≤12 words when used as lettering)'),
})

/** Full draft returned by finish — plan + caption + media prompts. */
const FinishDraftSchema = ContentPlanSchema.extend({
  topic: z.string().optional(),
  caption: z.string().describe('Full Instagram caption'),
  hashtags: z.string().describe('Space-separated hashtags'),
  first_line: z.string().optional(),
  cta: z.string().optional(),
  image_prompt: z.string().describe('Full visual brief'),
  stock_search_query: z.string().describe('Short Pexels keyword query'),
  reel_prompt: z.string().optional(),
  media_type: z.enum(['image', 'reel']).optional(),
  fallback_prompt: z.string().optional(),
  /** Google Font for canvas overlay (from curated catalog). */
  font_family: z.string().optional(),
  /** Per-slide briefs — required when format is carousel. */
  slides: z.array(FinishSlideSchema).min(2).max(7).optional(),
  /** Reel beat sheet from media_prompts. */
  beats: z.array(ReelBeatSchema).optional(),
  /** Reel clip length in seconds (6–15, one Runware clip). */
  duration_sec: z.number().optional(),
  /** Accessibility alt text for the feed image / reel cover. */
  alt_text: z.string().optional(),
  /** Deterministic rule failures from lintDraft at review time. */
  lint: z.array(z.string()).optional(),
  review: z
    .object({
      score: z.number().optional(),
      approved: z.boolean().optional(),
      issues: z.array(z.string()).optional(),
      suggestions: z.array(z.string()).optional(),
      gate: z
        .object({
          stop_scroll: z.boolean().optional(),
          value_without_caption: z.boolean().optional(),
          save_or_send: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
})
  .superRefine((draft, ctx) => {
    if ((draft.format || '').toLowerCase() !== 'carousel') return
    if (!draft.slides || draft.slides.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slides'],
        message: 'carousel finish requires slides[] with at least 2 items (text, image_prompt, stock_search_query)',
      })
    }
  })
  .describe('Final Instagram post draft')

export type Decision = z.infer<typeof DecisionSchema>
export type FinishDraft = z.infer<typeof FinishDraftSchema>

export { DecisionSchema, FinishDraftSchema, FinishSlideSchema, ReelBeatSchema }
