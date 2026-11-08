// Skill 3 — Dual prompts: LLM-style image brief + short Pexels search query.
// Carousel: per-slide text + visuals with teaching roles.
// Reel: beat sheet that fits one clip (6–15s).
import { z } from 'zod'
import { createStructuredModel } from './model'
import {
  BACKGROUND_STYLES,

  type BackgroundStyle,
} from '@instagram-agent/shared'
import { shortOnImageText } from '../prompts/format-templates'
import { IG, clampReelDuration } from '../instagram-rules'

const SlideRoleSchema = z.enum(['cover', 'why', 'step', 'mistake', 'recap', 'point', 'cta'])

const SlidePromptSchema = z.object({
  role: SlideRoleSchema.optional().describe(
    'Slide role: cover (hook), why, step, mistake, recap, point, or cta (save/share)'
  ),
  text: z
    .string()
    .describe(
      'Short on-image copy for this slide. Cover ≤10 words; other slides ≤12 words; CTA must say Save or Share.'
    ),
  image_prompt: z
    .string()
    .describe(
      'SCENE ONLY that ILLUSTRATES this slide’s point (props/layout showing the tip — not lifestyle-only). No lettering/placement instructions.'
    ),
  stock_search_query: z
    .string()
    .describe('3–8 Pexels keywords for this slide. Distinct from other slides.'),
  alt_text: z
    .string()
    .optional()
    .describe('Accessibility alt text for this slide: what it shows + its on-image words, one sentence.'),
})

const ReelBeatSchema = z.object({
  t_start: z.number().describe('Beat start time in seconds from 0'),
  visual_change: z.string().describe('Camera/prop/subject change at this beat'),
  on_screen_text_intent: z
    .string()
    .describe('On-screen line intent for this beat (≤12 words when burned in)'),
})

function buildMediaPromptSchema(maxSlides: number) {
  const max = Math.min(7, Math.max(2, maxSlides))
  return z.object({
    image_prompt: z
      .string()
      .optional()
      .describe(
        'SCENE ONLY that visualizes the takeaway (framework, steps, before/after, checklist props). Do NOT embed lettering — compiler adds from hook / slide text. No lifestyle-only aesthetic when the angle teaches.'
      ),
    stock_search_query: z
      .string()
      .optional()
      .describe(
        '3-8 concrete keywords for Pexels/Unsplash search: subject + place + mood. No camera jargon (4k, cinematic, bokeh, editorial).'
      ),
    reel_prompt: z
      .string()
      .optional()
      .describe(
        'Motion / scene summary for reels ONLY (no on-screen lettering recipes). Omit for feed/carousel.'
      ),
    beats: z
      .array(ReelBeatSchema)
      .min(2)
      .max(12)
      .optional()
      .describe(
        'Required for reels: ordered beat sheet inside duration_sec. First beat at 0–1.5s = hook; new visual every ~1.5–3s; last beat = soft CTA.'
      ),
    duration_sec: z
      .number()
      .optional()
      .describe(`Reel length in whole seconds, ${IG.reelDuration.min}–${IG.reelDuration.max} (one continuous clip). Required for reels.`),
    media_type: z
      .enum(['image', 'reel'])
      .optional()
      .describe('Asset type; default image for feed/carousel'),
    fallback_prompt: z
      .string()
      .optional()
      .describe('Simpler stock keywords if the primary stock_search_query returns nothing'),
    slides: z
      .array(SlidePromptSchema)
      .min(2)
      .max(max)
      .optional()
      .describe(
        `Required when format is carousel: up to ${max} slides with role, distinct on-image text, and tip-depicting visuals.`
      ),
  })
}

export type MediaPrompts = z.infer<ReturnType<typeof buildMediaPromptSchema>>
export type SlidePrompt = z.infer<typeof SlidePromptSchema>

type GenerateMediaArgs = {
  hook: string
  hookOnImage?: string
  angle?: string
  caption?: string
  format?: string
  backgroundStyle?: string | null
  brandVisual?: string | null
  maxSlides?: number
  /** Reviewer + operator notes to address on a revision pass. */
  feedback?: string[]
}

function styleHint(backgroundStyle?: string | null): string {
  if (!backgroundStyle) return ''
  const hit = BACKGROUND_STYLES.find((s) => s.id === backgroundStyle)
  if (!hit) return `Operator background preference: ${backgroundStyle}`
  return `Operator background style: ${hit.label} (seed keywords: ${hit.keywords}). stock_search_query MUST include these style keywords (or close synonyms) plus the topic subject.`
}

function carouselRoleBlock(max: number): string {
  if (max >= 5) {
    return `
This is a CAROUSEL. Return slides[] with ${Math.max(5, Math.min(max, 6))}–${max} items (cut a slide rather than pad filler):
Required role sequence (compress only if under 5 slots — always keep cover + ≥1 step + cta):
1) role=cover — hook 6–10 words + scene that shows the promise
2) role=why — why it matters
3+) role=step — one teaching step per slide (scene illustrates that step)
Then when space: role=mistake (common trap), role=recap (one-line takeaway)
Last) role=cta — text MUST include "Save" or "Share" (e.g. "Save this for later" / "Share with a friend who…")
Each slide: unique text, tip-depicting image_prompt (NOT lifestyle-only desk/coffee), unique stock_search_query.
No filler — every swipe teaches or advances.
Also set top-level image_prompt / stock_search_query to match slide 1.`
  }
  return `
This is a CAROUSEL. Return slides[] with ${Math.max(2, max - 1)}–${max} items:
- First: role=cover — hook 6–10 words + scene showing the tip/promise
- Middle: role=step (or point) — one idea each; scene illustrates that idea
- Last: role=cta — text MUST include "Save" or "Share"
Cut slides rather than pad. No lifestyle-only filler.
Top-level image_prompt / stock_search_query = slide 1.`
}

function assignDefaultRoles(
  slides: Array<z.infer<typeof SlidePromptSchema>>,
  max: number
): Array<z.infer<typeof SlidePromptSchema>> {
  const n = slides.length
  return slides.map((s, i) => {
    if (s.role) return { ...s, text: shortOnImageText(s.text, i === 0 ? 70 : 110, i === 0 ? 10 : 12) }
    let role: z.infer<typeof SlideRoleSchema> = 'point'
    if (i === 0) role = 'cover'
    else if (i === n - 1) role = 'cta'
    else if (max >= 5 && i === 1) role = 'why'
    else if (max >= 5 && i === n - 2 && n >= 5) role = 'recap'
    else role = 'step'
    return {
      ...s,
      role,
      text: shortOnImageText(s.text, i === 0 ? 70 : 110, i === 0 ? 10 : 12),
    }
  })
}

async function generateMediaPrompts({
  hook,
  hookOnImage,
  angle,
  caption,
  format,
  backgroundStyle,
  brandVisual,
  maxSlides = 5,
  feedback,
}: GenerateMediaArgs) {
  const max = Math.min(7, Math.max(2, maxSlides))
  const schema = buildMediaPromptSchema(max)
  const model = createStructuredModel(schema, { name: 'media_prompts' })
  const fmt = (format || 'feed').toLowerCase()
  const isCarousel = fmt === 'carousel'
  const isReel = fmt === 'reel'
  const aspect = isReel ? '9:16' : '4:5 or 1:1'
  const onImage = shortOnImageText(hookOnImage || hook, 90, 12)

  const carouselBlock = isCarousel ? carouselRoleBlock(max) : ''
  const { min: dMin, max: dMax } = IG.reelDuration
  const reelBlock = isReel
    ? `
This is a REEL rendered as ONE continuous ${dMin}–${dMax}s AI video clip (silent, text painted into the video). You MUST return:
- media_type: "reel"
- duration_sec: whole seconds between ${dMin} and ${dMax} — shortest length that delivers the one idea
- beats[]: 3–6 ordered beats with t_start, visual_change, on_screen_text_intent — ALL t_start < duration_sec
  · Beat 1 at t_start 0–1.5s: hook (problem, bold claim, or result) + clear visual change
  · Tip starts immediately after — no intro
  · New visual or text beat every ~1.5–3s (each line must be readable: ≤8 words for beats under 2.5s)
  · One idea only; last beat starts at least 2.5s before the end = soft CTA (follow / share / try this)
- reel_prompt: motion/scene summary matching the beat sheet (NO lettering recipes)
- image_prompt + stock_search_query: still frame that depicts the tip (for cover / fallback)`
    : ''

  const feedBlock =
    !isCarousel && !isReel
      ? `
This is a FEED still. image_prompt MUST visualize the takeaway (framework layout, checklist props, before/after, numbered steps in scene).
FORBIDDEN when the angle teaches: lifestyle-only pretty desk/coffee/aesthetic with no tip depicted.
On-image lettering comes from hook_on_image: "${onImage}" — do not embed that text in image_prompt.`
      : ''

  const prompt = `You are producing media briefs for an Instagram post.

Hook (caption-side): ${hook}
On-image hook (lettering SoT, ≤12 words): ${onImage}
Angle: ${angle || ''}
${caption ? `Caption: ${caption}\n` : ''}Format: ${fmt} (target aspect ratio: ${aspect})
${feedback?.length ? `\nMust address (reviewer / operator feedback):\n- ${feedback.join('\n- ')}\n` : ''}
${styleHint(backgroundStyle)}
${brandVisual ? `\nBrand visual direction (MUST follow for scene/palette):\n${brandVisual}` : ''}
${carouselBlock}${reelBlock}${feedBlock}

CRITICAL SEPARATION OF CONCERNS:
- image_prompt / reel_prompt / slide image_prompt = SCENE ONLY that DEPICTS the tip (subject, setting, lighting, props that show the idea).
- Do NOT write "paint this exact text", placement, font recipes, or duplicate lettering inside image_prompt.
- On-image lettering is applied later by the plate compiler from hook_on_image (feed) or slides[].text (carousel) or beats (reel).
- Still avoid logos, watermarks, crosses/emblems, and UI chrome in the scene.
- Keep subjects and any future lettering area inset — do not compose important details flush to the bottom edge (Instagram crops feel).

Return:
1) image_prompt — rich SCENE brief that shows the tip (no lettering block).
2) stock_search_query — short Pexels keywords. Subject + place + mood (+ style keywords).
   Never copy image_prompt wholesale. No "4k", "cinematic", "bokeh", "editorial".
3) media_type — "image" for feed/carousel; "reel" only for reels.
4) reel_prompt + beats + duration_sec — required for reels (see above).
${isCarousel ? '5) slides[] — required for carousel (see above), each with alt_text. Top-level image/stock may match slide 1.' : ''}`

  const result = await model.invoke(prompt)
  if (isCarousel && (!result.slides || result.slides.length < 2)) {
    throw new Error(
      `media_prompts for carousel must return slides[] (≥2, ≤${max}); got ${result.slides?.length ?? 0}`
    )
  }
  if (isCarousel && result.slides && result.slides.length > max) {
    result.slides = result.slides.slice(0, max)
  }
  if (isCarousel && result.slides) {
    result.slides = assignDefaultRoles(result.slides, max)
    const last = result.slides[result.slides.length - 1]
    if (last && !/\b(save|share)\b/i.test(last.text || '')) {
      last.text = shortOnImageText(`Save this — ${last.text || 'for later'}`, 110, 12)
      last.role = 'cta'
    }
  }

  let duration_sec: number | undefined
  if (isReel) {
    duration_sec = clampReelDuration(result.duration_sec)
    result.beats = normalizeBeats(result.beats, duration_sec, onImage)
  }

  const cover = result.slides?.[0]
  const image_prompt = (result.image_prompt || cover?.image_prompt || '').trim()
  const stock_search_query = (result.stock_search_query || cover?.stock_search_query || '').trim()
  if (!image_prompt || !stock_search_query) {
    throw new Error(
      'media_prompts must include image_prompt + stock_search_query (or slides[0] with those fields)'
    )
  }
  const media_type = result.media_type || (isReel ? 'reel' : 'image')
  const reel_prompt =
    (result.reel_prompt || (media_type === 'reel' ? image_prompt : '')).trim() || ''
  return {
    ...result,
    image_prompt,
    stock_search_query,
    reel_prompt,
    media_type,
    duration_sec,
    beats: result.beats,
  }
}

type Beat = z.infer<typeof ReelBeatSchema>

/** Sort, clamp into the clip, cap at 6, guarantee a hook at ≤1.5s and a CTA beat near the end. */
function normalizeBeats(raw: Beat[] | undefined, duration: number, hook: string): Beat[] {
  let beats = (raw || [])
    .map((b) => ({ ...b, t_start: Math.max(0, Number(b.t_start) || 0) }))
    .filter((b) => b.t_start < duration)
    .sort((a, b) => a.t_start - b.t_start)
  if (beats.length > 6) beats = [...beats.slice(0, 5), beats[beats.length - 1]]
  if (!beats.length) {
    beats = [
      { t_start: 0, visual_change: 'Hook visual change — problem or result first', on_screen_text_intent: hook },
    ]
  }
  if (beats[0].t_start > 1.5) beats[0] = { ...beats[0], t_start: 0 }
  if (beats.length < 2) {
    beats.push({
      t_start: Math.max(2, duration - 3),
      visual_change: 'Soft CTA beat',
      on_screen_text_intent: 'Try this / share with a friend',
    })
  }
  // Keep the last beat readable (≥2.5s on screen).
  const last = beats[beats.length - 1]
  if (duration - last.t_start < 2.5) last.t_start = Math.max(beats[beats.length - 2].t_start + 1, duration - 2.5)
  return beats
}

const MediaPromptSchema = buildMediaPromptSchema(7)

export { generateMediaPrompts, MediaPromptSchema, SlidePromptSchema, buildMediaPromptSchema }
export type { BackgroundStyle }
