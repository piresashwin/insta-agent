/** On-demand structured visual identity from brand context. */
import { z } from 'zod'
import { CANVAS_GOOGLE_FONTS } from '@instagram-agent/shared'
import { createStructuredModel } from './model'

/**
 * Flat schema — nested objects frequently come back empty from local/Luna models.
 * Mapped back to VisualIdentity shape after invoke.
 */
const VisualIdentityFlatSchema = z.object({
  primary: z.string().describe('Hex primary, e.g. #1a1a1a'),
  secondary: z.string().describe('Hex secondary'),
  accent: z.string().describe('Hex accent for CTAs / highlights'),
  background: z.string().describe('Hex soft background / scrim companion'),
  heading_font: z
    .string()
    .describe(`Must be one of: ${CANVAS_GOOGLE_FONTS.join(', ')}`),
  body_font: z
    .string()
    .describe(`Must be one of: ${CANVAS_GOOGLE_FONTS.join(', ')}`),
  must: z.array(z.string()).min(2).max(6).describe('Visual must-haves'),
  avoid: z.array(z.string()).min(2).max(6).describe('Visual avoid list'),
  scrim: z.enum(['none', 'bottom', 'full']),
  text_align: z.enum(['left', 'center', 'right']),
  safe_margin: z.number().min(0.04).max(0.16),
  visual_summary: z
    .string()
    .describe('2–4 sentences of narrative visual direction (also stored as visual prose)'),
})

export type GeneratedVisualIdentity = {
  palette: {
    primary: string
    secondary: string
    accent: string
    background: string
  }
  typography: {
    heading_font: string
    body_font: string
  }
  shot_rules: {
    must: string[]
    avoid: string[]
  }
  layout_defaults: {
    scrim: 'none' | 'bottom' | 'full'
    text_align: 'left' | 'center' | 'right'
    safe_margin: number
  }
  visual_summary: string
}

function pickFont(raw: string | undefined, fallback: string): string {
  const cleaned = (raw || '').trim()
  if (CANVAS_GOOGLE_FONTS.includes(cleaned as (typeof CANVAS_GOOGLE_FONTS)[number])) {
    return cleaned
  }
  const hit = CANVAS_GOOGLE_FONTS.find(
    (f) => f.toLowerCase() === cleaned.toLowerCase()
  )
  return hit || fallback
}

export async function generateVisualIdentity(opts: {
  name: string
  niche?: string | null
  audience?: string | null
  voice?: string | null
  visual?: string | null
  goals?: string | null
}): Promise<GeneratedVisualIdentity> {
  const model = createStructuredModel(VisualIdentityFlatSchema, {
    name: 'visual_identity',
  })
  const flat = await model.invoke(`Design a structured Instagram visual identity for this brand.
Return FLAT fields only (primary, secondary, accent, background, heading_font, body_font, must, avoid, scrim, text_align, safe_margin, visual_summary).

Brand: ${opts.name}
Niche: ${opts.niche || '(unset)'}
Audience: ${opts.audience || '(unset)'}
Goals: ${opts.goals || '(unset)'}
Voice: ${opts.voice || '(unset)'}
Existing visual notes: ${opts.visual || '(none)'}

Fonts MUST be chosen from: ${CANVAS_GOOGLE_FONTS.join(', ')}.
Palette hex codes must be readable on social (strong contrast for white overlay text when scrim=bottom/full).
Be specific — no vague "modern clean" without concrete shot rules.`)

  return {
    palette: {
      primary: flat.primary,
      secondary: flat.secondary,
      accent: flat.accent,
      background: flat.background,
    },
    typography: {
      heading_font: pickFont(flat.heading_font, 'Inter'),
      body_font: pickFont(flat.body_font, 'Inter'),
    },
    shot_rules: {
      must: flat.must,
      avoid: flat.avoid,
    },
    layout_defaults: {
      scrim: flat.scrim,
      text_align: flat.text_align,
      safe_margin: flat.safe_margin,
    },
    visual_summary: flat.visual_summary,
  }
}
