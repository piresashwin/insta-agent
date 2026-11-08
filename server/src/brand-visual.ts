/**
 * Shared visual-identity generate (+ optional persist) for REST and MCP.
 */
import type { BrandProfile, VisualIdentity } from '@instagram-agent/shared'
import { getBrandProfile, updateBrandProfile } from './brand'
import { ApiError } from './orchestrator'
import { assertAllowed, type PolicyActor } from './policy'
import { generateVisualIdentity } from './skills/generate-visual-identity'

export type GenerateVisualIdentityOpts = {
  /** Default true — persist on brand. */
  persist?: boolean
  actor?: PolicyActor | null
}

export type GenerateVisualIdentityResult = {
  identity: VisualIdentity
  visual_summary: string
  brand: BrandProfile
  note: string
}

export async function generateAndMaybePersistVisualIdentity(
  brandId: string | number,
  opts: GenerateVisualIdentityOpts = {}
): Promise<GenerateVisualIdentityResult> {
  const brand = getBrandProfile(brandId)
  if (!brand) throw new ApiError(404, 'brand not found')

  if (opts.actor) {
    assertAllowed(opts.actor, 'brand.update', { type: 'brand', brand })
  }

  const generated = await generateVisualIdentity({
    name: brand.name,
    niche: brand.niche,
    audience: brand.audience,
    voice: brand.voice,
    visual: brand.visual,
    goals: brand.goals,
  })

  const identity: VisualIdentity = {
    palette: generated.palette,
    typography: generated.typography,
    shot_rules: generated.shot_rules,
    layout_defaults: generated.layout_defaults,
    logo_url: null,
  }

  const persist = opts.persist !== false
  let saved = brand
  if (persist) {
    saved =
      updateBrandProfile(brand.id, {
        visual_identity: identity,
        visual: generated.visual_summary || brand.visual,
      }) || brand
  }

  return {
    identity,
    visual_summary: generated.visual_summary,
    brand: saved,
    note: persist ? 'Visual identity saved on brand' : 'Draft only — not saved',
  }
}
