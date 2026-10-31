// Skill 2 — Writes the caption + CTA + hashtags.
import { z } from 'zod'
import { createStructuredModel } from './model'

const CaptionSchema = z.object({
  caption: z.string().describe('Full caption with line breaks and strategic emojis, <= 2200 chars'),
  cta: z.string().describe('A single clear call to action'),
  hashtags: z.string().describe('Curated, space-separated hashtags'),
  first_line: z
    .string()
    .describe('The first 1-2 lines, written to hook mid-scroll in the feed preview'),
})

export type CaptionResult = z.infer<typeof CaptionSchema>

type WriteCaptionArgs = {
  hook: string
  angle?: string
  format?: string
  brandVoice?: string
  targetAudience?: string
}

async function writeCaption({ hook, angle, format, brandVoice, targetAudience }: WriteCaptionArgs) {
  const model = createStructuredModel(CaptionSchema, { name: 'caption' })
  const prompt = `You are an Instagram caption writer. Write a caption for this post.

Hook: ${hook}
Angle: ${angle || ''}
Format: ${format || 'feed'}
${brandVoice ? `Brand voice: ${brandVoice}` : ''}
${targetAudience ? `Target audience: ${targetAudience}` : ''}

The caption + CTA must fit Instagram's 2,200-character limit. The first line must hook a reader mid-scroll.`

  return model.invoke(prompt)
}

export { writeCaption, CaptionSchema }
