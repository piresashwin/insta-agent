// Zod contracts for the Chapter 03 agent loop decisions and finish payload.
import { z } from 'zod'
import { ContentPlanSchema } from '../skills/content-planning'

const DecisionSchema = z.object({
  thought: z.string().optional().describe('Short rationale for logs (one sentence)'),
  tool: z
    .enum(['content_planning', 'caption_writing', 'media_prompts', 'post_review', 'finish'])
    .describe('Which tool to run next'),
  args: z.record(z.any()).default({}).describe('Arguments for the chosen tool'),
})

const FinishSlideSchema = z.object({
  text: z.string().describe('On-image text for this carousel slide'),
  image_prompt: z.string().describe('Visual brief for this slide'),
  stock_search_query: z.string().describe('Pexels keywords for this slide'),
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
  /** Per-slide briefs when format is carousel (from media_prompts). */
  slides: z.array(FinishSlideSchema).min(2).max(7).optional(),
  review: z
    .object({
      score: z.number().optional(),
      approved: z.boolean().optional(),
      issues: z.array(z.string()).optional(),
      suggestions: z.array(z.string()).optional(),
    })
    .optional(),
}).describe('Final Instagram post draft')

export type Decision = z.infer<typeof DecisionSchema>
export type FinishDraft = z.infer<typeof FinishDraftSchema>

export { DecisionSchema, FinishDraftSchema }
