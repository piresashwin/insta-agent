/**
 * Eval harness runner.
 *
 *   pnpm eval                          # all fixtures, all topics, 1 rep
 *   pnpm eval --fixture 02-b2b-saas    # one fixture
 *   pnpm eval --models writer=<id>     # override a role's model (sets LLM_WRITER)
 *   pnpm eval --prompt caption@v2      # override active prompt version (informational)
 *   pnpm eval --baseline               # judge pipeline draft pairwise vs the gold post
 *   pnpm eval --n 3                    # reps per topic (averages scores)
 *
 * Set EVAL_CACHE_DIR (defaults below) to cache LLM responses so reruns are free.
 * The pipeline itself is pure — fixtures build a BrandContextV2 directly, with
 * no DB access.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { runPipeline, type PipelineDraft } from '../src/generation/pipeline'
import type { BrandContextV2, BrandRubric } from '../src/generation/brand-context'
import type {
  BrandPillar,
  BrandProfile,
  ExamplePost,
  HashtagSet,
  VisualIdentity,
  VoiceRules,
} from '@instagram-agent/shared'
import { generateObject } from '../src/llm/adapter'
import { runChecks, findForbiddenTerms } from './checks'
import { writeReport, type EvalReport, type TopicResult } from './report'

// ─── Fixture shape ───────────────────────────────────────────────────────────

interface EvalFixture {
  brand: {
    name: string
    niche: string
    audience: string
    goals?: string
    guide_md?: string
    pillars?: BrandPillar[]
    voice?: string
    voiceRules?: VoiceRules
    examples?: ExamplePost[]
    hashtagSets?: HashtagSet[]
    visualIdentity: VisualIdentity
    rubric?: BrandRubric
    recentHooks?: string[]
    maxSlides?: number
    timezone?: string
    backgroundStyle?: string | null
  }
  topics: string[]
  gold_posts?: Array<{ topic: string; hook: string; caption: string; format?: string }>
  forbidden_terms?: string[]
}

// Faith signature terms that must never leak into a non-faith brand's output.
const FAITH_TERMS = [
  'scripture',
  'psalm',
  'prayer',
  'devotional',
  'sabbath',
  'jesus',
  'gospel',
  'amen',
]

// ─── Fixture → BrandContextV2 (no DB) ──────────────────────────────────────────

function buildContext(fx: EvalFixture): BrandContextV2 {
  const b = fx.brand
  const identityJson = JSON.stringify(b.visualIdentity)
  const profile: BrandProfile = {
    id: 0,
    name: b.name,
    niche: b.niche,
    audience: b.audience,
    goals: b.goals ?? null,
    pillars: b.pillars ? JSON.stringify(b.pillars) : null,
    posts_per_week: 3,
    preferred_days: null,
    voice: b.voice ?? null,
    examples: null,
    visual: null,
    visual_identity: identityJson,
    format_mix: null,
    default_background_style: b.backgroundStyle ?? null,
    default_format: 'feed',
    default_max_slides: b.maxSlides ?? 5,
    guide_md: b.guide_md ?? null,
    voice_rules: b.voiceRules ? JSON.stringify(b.voiceRules) : null,
    example_posts: b.examples ? JSON.stringify(b.examples) : null,
    hashtag_sets: b.hashtagSets ? JSON.stringify(b.hashtagSets) : null,
    timezone: b.timezone ?? 'UTC',
    created_at: '',
    updated_at: null,
  }

  return {
    profile,
    voiceRules: b.voiceRules ?? {},
    voiceText: b.voice ?? '',
    examples: b.examples ?? [],
    audience: b.audience,
    pillars: b.pillars ?? [],
    hashtagSets: b.hashtagSets ?? [],
    visualIdentity: b.visualIdentity,
    visualText: `Structured identity JSON:\n${identityJson}`,
    backgroundStyle: b.backgroundStyle ?? null,
    rubric: b.rubric ?? null,
    recentHooks: b.recentHooks ?? [],
    format: 'feed',
    maxSlides: b.maxSlides ?? 5,
    timezone: b.timezone ?? 'UTC',
  }
}

// ─── CLI args ──────────────────────────────────────────────────────────────────

interface Args {
  fixture?: string
  models: Record<string, string>
  prompt?: string
  baseline: boolean
  n: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { models: {}, baseline: false, n: 1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--fixture') args.fixture = argv[++i]
    else if (a === '--models') {
      const [role, model] = (argv[++i] ?? '').split('=')
      if (role && model) args.models[role] = model
    } else if (a === '--prompt') args.prompt = argv[++i]
    else if (a === '--baseline') args.baseline = true
    else if (a === '--n') args.n = Math.max(1, Number(argv[++i]) || 1)
  }
  return args
}

// ─── Pairwise judge ──────────────────────────────────────────────────────────

const PairwiseSchema = z.object({
  winner: z.enum(['a', 'b']).describe('"a" = pipeline draft, "b" = gold post'),
  reason: z.string(),
})

async function pairwiseVsGold(
  draft: PipelineDraft,
  gold: { hook: string; caption: string },
  ctx: BrandContextV2
): Promise<boolean | null> {
  try {
    const res = await generateObject({
      role: 'judge',
      schema: PairwiseSchema,
      system: 'You are a brand content judge. Choose the post that better matches the brand voice and rubric.',
      prompt: `Brand: ${ctx.profile?.name}
Voice: ${ctx.voiceText}

Post A (pipeline):
Hook: ${draft.hook}
Caption: ${draft.caption}

Post B (gold reference):
Hook: ${gold.hook}
Caption: ${gold.caption}

Which post better fits the brand? Return "a" or "b".`,
      schemaName: 'pairwise',
      maxOutputTokens: 150,
    })
    return res.data.winner === 'a'
  } catch {
    return null
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // Apply model overrides (role → LLM_<ROLE>).
  for (const [role, model] of Object.entries(args.models)) {
    process.env[`LLM_${role.toUpperCase()}`] = model
  }

  const evalsDir = __dirname
  if (!process.env.EVAL_CACHE_DIR) {
    process.env.EVAL_CACHE_DIR = path.join(evalsDir, '.cache')
  }

  const fixturesDir = path.join(evalsDir, 'fixtures')
  const files = fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !args.fixture || f.startsWith(args.fixture) || f === `${args.fixture}.json`)
    .sort()

  if (!files.length) {
    console.error(`No fixtures matched${args.fixture ? ` "${args.fixture}"` : ''} in ${fixturesDir}`)
    process.exit(1)
  }

  const report: EvalReport = {
    startedAt: new Date().toISOString(),
    pipeline: 'main',
    baseline: args.baseline ? 'gold' : null,
    fixtures: files.map((f) => f.replace(/\.json$/, '')),
    results: [],
  }

  for (const file of files) {
    const name = file.replace(/\.json$/, '')
    const fx = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as EvalFixture
    const ctx = buildContext(fx)

    // Terms that must not leak into this brand's output.
    const isFaith = name.includes('faith')
    const forbidden = [...(fx.forbidden_terms ?? []), ...(isFaith ? [] : FAITH_TERMS)]

    for (const topic of fx.topics) {
      for (let rep = 0; rep < args.n; rep++) {
        const row: TopicResult = {
          fixture: name,
          topic,
          rep,
          detPassed: false,
          detFailures: [],
          rubricScore: null,
          leaks: [],
          pairwiseWin: null,
        }
        try {
          console.log(`▶ ${name} · "${topic}" (rep ${rep + 1}/${args.n})`)
          const { draft, review } = await runPipeline(ctx, {
            topic,
            format: 'feed',
          })

          const checks = runChecks(draft, ctx)
          const failed = checks.filter((c) => !c.passed)
          row.detPassed = failed.length === 0
          row.detFailures = failed.map((c) => `${c.id}: ${c.detail ?? 'failed'}`)
          row.rubricScore = review.overallScore
          row.leaks = findForbiddenTerms(draft, forbidden)

          if (args.baseline) {
            const gold = fx.gold_posts?.find((g) => g.topic === topic)
            if (gold) row.pairwiseWin = await pairwiseVsGold(draft, gold, ctx)
          }
        } catch (err) {
          row.error = (err as Error).message
        }
        report.results.push(row)
      }
    }
  }

  const reportsDir = path.join(evalsDir, 'reports')
  const { json, md } = writeReport(report, reportsDir)
  console.log(`\n✔ Report written:\n  ${md}\n  ${json}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
