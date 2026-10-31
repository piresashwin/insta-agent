// Skill 3 — Dual prompts: LLM-style image brief + short Pexels search query.
// Carousel: also returns per-slide text + visuals (cover → points → CTA).
import { z } from 'zod'
import { createStructuredModel } from './model'
import { BACKGROUND_STYLES, type BackgroundStyle } from '@instagram-agent/shared'

const SlidePromptSchema = z.object({
  text: z
    .string()
    .describe('Short on-image copy for this slide (hook / point / CTA). Keep under ~12 words.'),
  image_prompt: z
    .string()
    .describe('Visual brief unique to this slide (subject, setting, lighting).'),
  stock_search_query: z
    .string()
    .describe('3–8 Pexels keywords for this slide. Distinct from other slides.'),
})

const MediaPromptSchema = z.object({
  image_prompt: z
    .string()
    .describe(
      'Full descriptive visual brief (subject, setting, lighting, composition). For feed/reel, or slide 1 cover for carousel.'
    ),
  stock_search_query: z
    .string()
    .describe(
      '3-8 concrete keywords for Pexels/Unsplash search: subject + place + mood. No camera jargon (4k, cinematic, bokeh, editorial).'
    ),
  reel_prompt: z
    .string()
    .describe('A concrete prompt for sourcing/matching a short free stock video clip'),
  media_type: z.enum(['image', 'reel']).describe('Which asset type this post should actually use'),
  fallback_prompt: z
    .string()
    .optional()
    .describe('Simpler stock keywords if the primary stock_search_query returns nothing'),
  slides: z
    .array(SlidePromptSchema)
    .min(2)
    .max(7)
    .optional()
    .describe(
      'Required when format is carousel: 3–5 slides with distinct on-image text AND distinct visuals (cover, value points, CTA).'
    ),
})

export type MediaPrompts = z.infer<typeof MediaPromptSchema>
export type SlidePrompt = z.infer<typeof SlidePromptSchema>

type GenerateMediaArgs = {
  hook: string
  angle?: string
  caption?: string
  format?: string
  backgroundStyle?: string | null
  brandVisual?: string | null
}

function styleHint(backgroundStyle?: string | null): string {
  if (!backgroundStyle) return ''
  const hit = BACKGROUND_STYLES.find((s) => s.id === backgroundStyle)
  if (!hit) return `Operator background preference: ${backgroundStyle}`
  return `Operator background style: ${hit.label} (seed keywords: ${hit.keywords}). stock_search_query MUST include these style keywords (or close synonyms) plus the topic subject.`
}

async function generateMediaPrompts({
  hook,
  angle,
  caption,
  format,
  backgroundStyle,
  brandVisual,
}: GenerateMediaArgs) {
  const model = createStructuredModel(MediaPromptSchema, { name: 'media_prompts' })
  const isCarousel = (format || '').toLowerCase() === 'carousel'
  const aspect = format === 'reel' ? '9:16' : '4:5 or 1:1'
  const carouselBlock = isCarousel
    ? `
This is a CAROUSEL. You MUST return slides[] with 3–5 items:
- Slide 1: cover — punchy hook text (can match the post hook) + strong hero visual
- Middle slides: one distinct teaching/value point each + different visuals
- Last slide: clear CTA text + supporting visual
Each slide needs unique text, image_prompt, and stock_search_query (do not reuse the same photo brief).
Also set top-level image_prompt / stock_search_query to match slide 1 (cover).`
    : ''

  const prompt = `You are producing media briefs for an Instagram post.

Hook: ${hook}
Angle: ${angle || ''}
Caption: ${caption || ''}
Format: ${format || 'feed'} (target aspect ratio: ${aspect})
${styleHint(backgroundStyle)}
${brandVisual ? `\nBrand visual direction (MUST follow):\n${brandVisual}` : ''}
${carouselBlock}

Return:
1) image_prompt — rich visual description matching brand + background style when set.
2) stock_search_query — short Pexels keywords. Subject + place + mood (+ style keywords).
   Never copy image_prompt wholesale. No "4k", "cinematic", "bokeh", "editorial".
3) reel_prompt and media_type. Prefer media_type "image" for stills / carousels.`

  return model.invoke(prompt)
}

export { generateMediaPrompts, MediaPromptSchema, SlidePromptSchema }
export type { BackgroundStyle }
