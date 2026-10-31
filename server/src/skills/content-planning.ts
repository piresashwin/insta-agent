// Skill 1 — Turns a seed topic into a full concept.
import { z } from 'zod'
import { createStructuredModel } from './model'

const ContentPlanSchema = z.object({
  audience: z.string().describe('Who this post is for, in a short phrase'),
  hook: z.string().describe('A single strong, 1-2 sentence hook'),
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
}

async function planContent({ topic, audience, angle, brandGuide, brandConfig }: PlanContentArgs) {
  const model = createStructuredModel(ContentPlanSchema, { name: 'content_plan' })
  const prompt = `You are an Instagram content planner. Turn this seed into a full content concept.

Topic: ${topic || 'general'}
${audience ? `Suggested audience: ${audience}` : ''}
${angle ? `Suggested angle: ${angle}` : ''}
${brandGuide ? `\nBrand guide:\n${brandGuide}` : ''}
${brandConfig ? `\nBrand config:\n${brandConfig}` : ''}

Every post must end with a single strong hook (1-2 sentences). The angle must never be empty.`

  return model.invoke(prompt)
}

export { planContent, ContentPlanSchema }
