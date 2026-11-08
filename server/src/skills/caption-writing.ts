// Skill 2 — Writes the caption + CTA + hashtags + alt text (runs AFTER media_prompts
// so carousel/reel captions can reference the actual slides / beats).
import { z } from 'zod'
import { createStructuredModel } from './model'
import {
  IG,
  findBait,
  fitCaption,
  normalizeAltText,
  normalizeHashtags,
} from '../instagram-rules'

const CaptionSchema = z.object({
  caption: z
    .string()
    .describe('Full caption with line breaks and sparing emojis. Names the topic in plain words in the first 2 lines.'),
  cta: z.string().describe('A single clear call to action matching the format (no engagement bait)'),
  hashtags: z
    .string()
    .describe(`${IG.hashtagMin}–${IG.hashtagMax} specific, space-separated hashtags (niche + topic). No generic tags.`),
  first_line: z
    .string()
    .describe(
      `Must equal the start of caption; ≤${IG.firstLineMax} chars so it works in feed preview before “more”`
    ),
  alt_text: z
    .string()
    .describe(
      'Accessibility alt text: 1–2 plain sentences describing what the image/cover shows, including its on-image words. No hashtags, no "image of".'
    ),
})

export type CaptionResult = z.infer<typeof CaptionSchema>

type WriteCaptionArgs = {
  hook: string
  hookOnImage?: string
  angle?: string
  format?: string
  brandVoice?: string
  targetAudience?: string
  job?: string
  audienceProblem?: string
  hashtagTheme?: string
  /** Carousel slide texts in order (from media_prompts). */
  slides?: Array<{ text?: string; role?: string }>
  /** Reel beat lines (from media_prompts). */
  beats?: Array<{ t_start?: number; on_screen_text_intent?: string }>
  /** Reviewer + operator notes to address on a revision pass. */
  feedback?: string[]
}

function formatCaptionRules(format?: string): string {
  const f = (format || 'feed').toLowerCase()
  if (f === 'reel') {
    return `Format=reel rules:
- Structure: hook → one tip that matches the on-screen beats → soft CTA.
- CTA: follow for more / share with someone who needs it / try this today.
- Keep scannable; support the on-screen tip, do not bury the value only in caption.`
  }
  if (f === 'carousel') {
    return `Format=carousel rules:
- Structure: hook → short context → tell them what the slides cover (use the slide list) → Save/Share CTA.
- CTA must ask to Save this carousel or Share it with someone who has the same problem.
- first_line must equal the caption start and work before “more”.`
  }
  return `Format=feed rules:
- Structure: hook → short context → ONE actionable tip → genuine question or save CTA.
- CTA: save this for later / try this today / a real open question about their experience.
- first_line must equal the caption start and stay ≤${IG.firstLineMax} characters for the feed preview.`
}

function mediaContext(args: WriteCaptionArgs): string {
  if (args.slides?.length) {
    return `\nCarousel slides (the caption must match these):\n${args.slides
      .map((s, i) => `${i + 1}. [${s.role || 'slide'}] ${s.text || ''}`)
      .join('\n')}`
  }
  if (args.beats?.length) {
    return `\nReel on-screen beats (the caption must match these):\n${args.beats
      .map((b) => `${Number(b.t_start ?? 0).toFixed(1)}s: ${b.on_screen_text_intent || ''}`)
      .join('\n')}`
  }
  return ''
}

async function writeCaption(args: WriteCaptionArgs) {
  const { hook, hookOnImage, angle, format, brandVoice, targetAudience, job, audienceProblem, hashtagTheme, feedback } =
    args
  const model = createStructuredModel(CaptionSchema, { name: 'caption' })
  const prompt = `You are an Instagram caption writer. Write a caption for this post.

Hook: ${hook}
${hookOnImage ? `On-image text (already on the visual — don't just repeat it): ${hookOnImage}` : ''}
Angle: ${angle || ''}
Format: ${format || 'feed'}
${job ? `Post job (one): ${job}` : ''}
${audienceProblem ? `Audience problem: ${audienceProblem}` : ''}
${hashtagTheme ? `Hashtag theme: ${hashtagTheme}` : ''}
${brandVoice ? `Brand voice: ${brandVoice}` : ''}
${targetAudience ? `Target audience: ${targetAudience}` : ''}${mediaContext(args)}
${feedback?.length ? `\nMust address (reviewer / operator feedback):\n- ${feedback.join('\n- ')}\n` : ''}
${formatCaptionRules(format)}

Instagram rules (hard):
- Search: say the topic in plain keywords within the first two lines (Instagram search indexes captions).
- Hashtags: ${IG.hashtagMin}–${IG.hashtagMax} specific tags built around the hashtag theme (mix one niche community tag + topic tags). Never #love #instagood #explore #fyp style tags. Hashtags go ONLY in the hashtags field, not in caption.
- No engagement bait: never "comment YES", "tag 3 friends", "like if", "share if you agree", "link in bio". Meta demotes these.
- caption + hashtags must fit ${IG.captionMax} characters total; aim for 300–1200 characters of caption.
- first_line MUST be the exact opening of caption (not a separate teaser).
- alt_text: describe the visual for screen readers, including the on-image words.`

  const result = await model.invoke(prompt)
  const hashtags = normalizeHashtags(result.hashtags)
  // Keep caption within the joined budget so publish never chops mid-sentence.
  const joined = fitCaption((result.caption || '').trim(), hashtags)
  const caption = hashtags ? joined.slice(0, joined.length - hashtags.length).trim() : joined
  let first_line = (result.first_line || '').trim()
  if (!first_line || !caption.startsWith(first_line.slice(0, Math.min(20, first_line.length)))) {
    first_line = caption.split('\n')[0]?.slice(0, IG.firstLineMax) || first_line
  } else if (first_line.length > IG.firstLineMax) {
    first_line = first_line.slice(0, IG.firstLineMax).replace(/\s+\S*$/, '').trim()
  }
  const cta = (result.cta || '').trim()
  return {
    ...result,
    caption,
    first_line,
    cta,
    hashtags,
    alt_text: normalizeAltText(result.alt_text) || normalizeAltText(hookOnImage || hook),
    bait: findBait(`${caption}\n${cta}`),
  }
}

export { writeCaption, CaptionSchema }
