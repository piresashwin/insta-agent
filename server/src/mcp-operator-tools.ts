/**
 * Operator MCP tools — brand setup + calendar (same modules as REST).
 * HITL stop: no approve / request_changes / media / publish.
 */
import { z } from 'zod'
import type { CalendarProposal } from '@instagram-agent/shared'
import {
  createBrandProfile,
  getBrandProfile,
  listBrandProfiles,
  listCalendarPosts,
  updateBrandProfile,
  type BrandProfileInput,
} from './brand'
import { generateAndMaybePersistVisualIdentity } from './brand-visual'
import { fillWeekForBrand } from './fill-week'
import { ApiError } from './orchestrator'
import { assertAllowed, MCP_OPERATOR } from './policy'
import { generateBrandFromFeedback } from './skills/generate-brand-profile'
import type { BrandProfile } from '@instagram-agent/shared'

type RegisterFn = (
  name: string,
  config: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<unknown>
) => void

type AsResult = (value: unknown) => unknown
type AsError = (err: unknown) => unknown

const proposalSchema = z.object({
  date: z.string(),
  topic: z.string(),
  pillar: z.string().nullable().optional(),
  format: z.union([z.enum(['feed', 'reel', 'carousel']), z.string()]),
  angle: z.string().nullable().optional(),
  background_style: z.string().nullable().optional(),
})

function hasVisualIdentity(brand: BrandProfile | null | undefined): boolean {
  const raw = brand?.visual_identity
  if (!raw?.trim()) return false
  try {
    const parsed = JSON.parse(raw) as { palette?: Record<string, unknown> }
    return Boolean(parsed?.palette && Object.keys(parsed.palette).length > 0)
  } catch {
    return false
  }
}

/** Map generate_brand_draft output (or flat args) into BrandProfileInput — keep all fields. */
function brandInputFromArgs(args: Record<string, unknown>): BrandProfileInput {
  const draft =
    args.draft && typeof args.draft === 'object' && !Array.isArray(args.draft)
      ? (args.draft as Record<string, unknown>)
      : null
  // Top-level args override draft so the operator can tweak after review.
  const src: Record<string, unknown> = { ...(draft || {}), ...args }
  delete src.draft
  delete src.id
  delete src.with_visual_identity

  const name = String(src.name || '').trim()
  if (!name) throw new ApiError(400, 'name is required (pass draft from generate_brand_draft or name)')

  let pillars: BrandProfileInput['pillars'] = null
  if (Array.isArray(src.pillars)) {
    pillars = src.pillars.map((p) =>
      typeof p === 'string' ? { name: p } : { name: String((p as { name?: string }).name || '') }
    )
  } else if (typeof src.pillars === 'string') {
    pillars = src.pillars
  }

  const input: BrandProfileInput = {
    name,
    niche: typeof src.niche === 'string' ? src.niche : null,
    audience: typeof src.audience === 'string' ? src.audience : null,
    goals: typeof src.goals === 'string' ? src.goals : null,
    pillars,
    posts_per_week: typeof src.posts_per_week === 'number' ? src.posts_per_week : null,
    preferred_days: (src.preferred_days as BrandProfileInput['preferred_days']) ?? null,
    voice: typeof src.voice === 'string' ? src.voice : null,
    examples: typeof src.examples === 'string' ? src.examples : null,
    visual: typeof src.visual === 'string' ? src.visual : null,
    format_mix: (src.format_mix as BrandProfileInput['format_mix']) ?? null,
    default_background_style:
      typeof src.default_background_style === 'string' ? src.default_background_style : null,
    default_format: typeof src.default_format === 'string' ? src.default_format : null,
    default_max_slides:
      typeof src.default_max_slides === 'number' ? src.default_max_slides : null,
    guide_md: typeof src.guide_md === 'string' ? src.guide_md : null,
  }

  // Only set when explicitly provided — never wipe an existing structured identity with null.
  if (src.visual_identity !== undefined) {
    input.visual_identity = src.visual_identity as BrandProfileInput['visual_identity']
  }

  return input
}

export function registerOperatorTools(
  register: RegisterFn,
  asToolResult: AsResult,
  asToolError: AsError
) {
  register(
    'list_brand_profiles',
    {
      title: 'List brand profiles',
      description:
        'List saved brand profiles (id, name, niche, default_format, posts_per_week). Operator loop step: inspect brands before fill_week.',
      inputSchema: {},
    },
    async () => {
      try {
        const brands = listBrandProfiles().map((b) => ({
          id: b.id,
          name: b.name,
          niche: b.niche,
          audience: b.audience,
          default_format: b.default_format,
          posts_per_week: b.posts_per_week,
          default_background_style: b.default_background_style,
          has_visual_identity: hasVisualIdentity(b),
        }))
        return asToolResult({ brands })
      } catch (e) {
        return asToolError(e)
      }
    }
  )

  register(
    'generate_brand_draft',
    {
      title: 'Generate brand draft from research feedback',
      description:
        'Operator loop: turn research/feedback into a brand draft JSON. Does NOT persist — after the operator reviews in chat, call save_brand_profile. Paste niche research into feedback. Does not approve or publish.',
      inputSchema: {
        feedback: z
          .string()
          .describe('Freeform research + goals (faceless page niche, audience, voice, etc.)'),
        name: z.string().optional().describe('Optional name hint'),
      },
    },
    async (args) => {
      try {
        const feedback = String(args.feedback || '').trim()
        if (!feedback) throw new ApiError(400, 'feedback is required')
        const draft = await generateBrandFromFeedback({
          feedback,
          nameHint: typeof args.name === 'string' ? args.name : undefined,
        })
        return asToolResult({
          draft: {
            ...draft,
            pillars: draft.pillars.map((name) => ({ name })),
          },
          note:
            'Draft only — review, then save_brand_profile({ draft: <this.draft> }). By default save also generates structured visual_identity (palette/fonts/shot rules) for the Visual identity UI section. Approve/publish stay in React.',
        })
      } catch (e) {
        return asToolError(e)
      }
    }
  )

  register(
    'save_brand_profile',
    {
      title: 'Save or update brand profile',
      description:
        'Persist a full brand. Prefer save_brand_profile({ draft }) from generate_brand_draft. with_visual_identity defaults TRUE — fills the React “Visual identity” section (palette/fonts/shot rules) after save when missing. Pass id to update (does not wipe existing visual_identity unless you pass visual_identity). Then fill_week (dry_run). Never publishes.',
      inputSchema: {
        id: z.union([z.number().int(), z.string()]).optional().describe('Omit to create'),
        draft: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Full draft object from generate_brand_draft (recommended)'),
        with_visual_identity: z
          .boolean()
          .optional()
          .describe(
            'Default true. After save, generate structured visual_identity if the brand still lacks palette/fonts.'
          ),
        name: z.string().optional().describe('Required if draft omitted'),
        niche: z.string().optional(),
        audience: z.string().optional(),
        goals: z.string().optional(),
        pillars: z
          .union([z.array(z.string()), z.array(z.object({ name: z.string() })), z.string()])
          .optional(),
        posts_per_week: z.number().int().min(1).max(14).optional(),
        preferred_days: z.union([z.array(z.string()), z.string()]).optional(),
        voice: z.string().optional(),
        examples: z.string().optional(),
        visual: z.string().optional(),
        visual_identity: z.unknown().optional(),
        format_mix: z.unknown().optional(),
        default_background_style: z.string().optional(),
        default_format: z.enum(['feed', 'reel', 'carousel']).optional(),
        default_max_slides: z.number().int().min(2).max(7).optional(),
        guide_md: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const input = brandInputFromArgs(args)
        const withVisual = args.with_visual_identity !== false
        let brand: BrandProfile
        if (args.id != null) {
          const existing = getBrandProfile(args.id as string | number)
          if (!existing) throw new ApiError(404, 'brand not found')
          assertAllowed(MCP_OPERATOR, 'brand.update', { type: 'brand', brand: existing })
          brand = updateBrandProfile(existing.id, input) || existing
        } else {
          assertAllowed(MCP_OPERATOR, 'brand.create', {
            type: 'brand',
            brand: { name: input.name },
          })
          brand = createBrandProfile(input)
        }

        let visualNote: string | null = null
        if (withVisual && !hasVisualIdentity(brand)) {
          const vis = await generateAndMaybePersistVisualIdentity(brand.id, {
            persist: true,
            actor: MCP_OPERATOR,
          })
          brand = vis.brand
          visualNote = vis.note
        }

        return asToolResult({
          brand,
          has_visual_identity: hasVisualIdentity(brand),
          visual_identity: brand.visual_identity
            ? JSON.parse(brand.visual_identity)
            : null,
          note: visualNote
            ? `Brand saved with visual identity. ${visualNote} Next: fill_week (dry_run). Approve/publish only in React.`
            : hasVisualIdentity(brand)
              ? 'Brand saved (visual identity already present). Next: fill_week (dry_run).'
              : 'Brand saved without structured visual identity — call generate_visual_identity or re-save with with_visual_identity:true.',
        })
      } catch (e) {
        return asToolError(e)
      }
    }
  )

  register(
    'generate_visual_identity',
    {
      title: 'Generate brand visual identity',
      description:
        'Operator loop: generate palette/typography/shot_rules for a saved brand. persist defaults true. Does not publish.',
      inputSchema: {
        brand_profile_id: z.union([z.number().int(), z.string()]),
        persist: z
          .boolean()
          .optional()
          .describe('Default true — save on brand. Set false for preview only.'),
      },
    },
    async (args) => {
      try {
        const result = await generateAndMaybePersistVisualIdentity(
          args.brand_profile_id as string | number,
          {
            persist: typeof args.persist === 'boolean' ? args.persist : true,
            actor: MCP_OPERATOR,
          }
        )
        return asToolResult(result)
      } catch (e) {
        return asToolError(e)
      }
    }
  )

  register(
    'fill_week',
    {
      title: 'Fill calendar week',
      description:
        'Operator loop: plan or commit a week of draft posts for a brand. dry_run DEFAULTS TRUE — preview proposals only. After operator confirms in chat, call again with dry_run:false (optionally pass revised proposals[]). Creates draft posts only; does NOT approve or publish — hand off to React. Then optional start_run_on_post per draft.',
      inputSchema: {
        brand_profile_id: z.union([z.number().int(), z.string()]),
        week_start: z.string().optional().describe('ISO date (YYYY-MM-DD); default today'),
        count: z.number().int().min(1).max(14).optional(),
        dry_run: z
          .boolean()
          .optional()
          .describe('Default true. Set false only after operator confirms proposals.'),
        proposals: z
          .array(proposalSchema)
          .optional()
          .describe('Revised proposals from chat critique; omit to auto-plan'),
        account_id: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const dryRun = args.dry_run !== false
        const proposals = Array.isArray(args.proposals)
          ? (args.proposals as CalendarProposal[])
          : undefined
        const result = await fillWeekForBrand(args.brand_profile_id as string | number, {
          week_start: typeof args.week_start === 'string' ? args.week_start : null,
          count: typeof args.count === 'number' ? args.count : null,
          dry_run: dryRun,
          proposals,
          account_id: typeof args.account_id === 'string' ? args.account_id : null,
          actor: MCP_OPERATOR,
        })
        if (result.dry_run) {
          return asToolResult({
            dry_run: true,
            brand_profile_id: result.brand.id,
            proposals: result.proposals,
            note: 'Preview only — critique with operator, then fill_week with dry_run:false (and optional revised proposals).',
          })
        }
        return asToolResult({
          dry_run: false,
          brand_profile_id: result.brand.id,
          proposals: result.proposals,
          posts: result.posts.map((p) => ({
            id: p.id,
            topic: p.topic,
            status: p.status,
            format: p.format,
            scheduled_at: p.scheduled_at,
          })),
          note: 'Draft posts created. Optional: start_run_on_post. Approve/publish only in React dashboard.',
        })
      } catch (e) {
        return asToolError(e)
      }
    }
  )

  register(
    'list_calendar',
    {
      title: 'List calendar posts',
      description:
        'List scheduled posts in [from, to) for optional brand_profile_id. Confirm fill_week commits. from/to are ISO dates.',
      inputSchema: {
        from: z.string().describe('ISO date start inclusive'),
        to: z.string().describe('ISO date end exclusive'),
        brand_profile_id: z.union([z.number().int(), z.string()]).optional(),
        account_id: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const from = String(args.from || '').trim()
        const to = String(args.to || '').trim()
        if (!from || !to) throw new ApiError(400, 'from and to are required (ISO dates)')
        const brand_profile_id =
          args.brand_profile_id != null ? Number(args.brand_profile_id) : undefined
        const posts = listCalendarPosts({
          from,
          to,
          brand_profile_id: Number.isFinite(brand_profile_id) ? brand_profile_id : undefined,
          account_id: typeof args.account_id === 'string' ? args.account_id : undefined,
        })
        return asToolResult({
          posts: posts.map((p) => ({
            id: p.id,
            topic: p.topic,
            status: p.status,
            format: p.format,
            scheduled_at: p.scheduled_at,
            brand_profile_id: p.brand_profile_id,
          })),
        })
      } catch (e) {
        return asToolError(e)
      }
    }
  )
}
