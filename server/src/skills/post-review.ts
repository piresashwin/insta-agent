// Skill 4 — Critiques the full draft against brand voice / hook / caption quality.
import { z } from 'zod'
import { createStructuredModel } from './model'

const ReviewSchema = z.object({
  score: z.number().min(0).max(10),
  issues: z.array(z.string()).describe('Concrete problems found, [] only if truly none'),
  suggestions: z.array(z.string()).describe('Actionable rewrites/fixes, [] only if truly none'),
  approved: z.boolean().describe('True only if score is at or above the approval threshold'),
})

export type ReviewResult = z.infer<typeof ReviewSchema>

const APPROVAL_THRESHOLD = 7

type ReviewPostArgs = {
  hook: string
  caption: string
  hashtags: string
  imagePrompt?: string
  reelPrompt?: string
  brandVoice?: string
}

async function reviewPost({
  hook,
  caption,
  hashtags,
  imagePrompt,
  reelPrompt,
  brandVoice,
}: ReviewPostArgs) {
  const model = createStructuredModel(ReviewSchema, { name: 'post_review' })
  const prompt = `You are reviewing a drafted Instagram post before it goes to a human for approval.
Score honestly out of 10 and only set approved=true if score >= ${APPROVAL_THRESHOLD}. Never silently
approve — always list concrete issues and suggestions, even for a strong draft.

Hook: ${hook}
Caption: ${caption}
Hashtags: ${hashtags}
Image prompt: ${imagePrompt || '(none)'}
Reel prompt: ${reelPrompt || '(none)'}
${brandVoice ? `Brand voice to check against: ${brandVoice}` : ''}`

  return model.invoke(prompt)
}

export { reviewPost, ReviewSchema, APPROVAL_THRESHOLD }
