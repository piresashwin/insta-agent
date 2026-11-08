/**
 * Create a fresh brand, fill week (feed + carousel + reel), run agent on each post,
 * and assert checklist hardening fields (hook_on_image, job, review.gate, beats/roles).
 *
 * Usage: pnpm exec tsx scripts/test-checklist-brand.ts
 */
import path from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function textPayload(result: { content?: Array<{ type: string; text?: string }> }) {
  const block = result.content?.find((c) => c.type === 'text')
  const raw = block?.text || JSON.stringify(result)
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function wordCount(s: string) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length
}

async function main() {
  const repoRoot = path.join(__dirname, '..', '..')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }

  const health = await fetch('http://127.0.0.1:3001/api/brand-profiles').catch(() => null)
  if (!health || !health.ok) {
    throw new Error('API not reachable at http://127.0.0.1:3001 — start server first')
  }

  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--filter', 'server', 'exec', 'tsx', 'src/mcp-server.ts'],
    cwd: repoRoot,
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'checklist-brand-test', version: '1.0.0' })
  await client.connect(transport)

  const stamp = Date.now().toString(36)
  const brandName = `Quiet Kitchen Notes ${stamp}`

  console.log(`\n=== 1) generate_brand_draft: ${brandName} ===`)
  const generated = textPayload(
    await client.callTool({
      name: 'generate_brand_draft',
      arguments: {
        name: brandName,
        feedback: `Faceless cooking education Instagram for busy home cooks who want weeknight dinners without waste.
Niche: 15-minute prep systems, fridge-first cooking, one-pan meals.
Audience: parents and remote workers who hate decision fatigue at 6pm.
Goals: 5k saves/month on recipe carousels; grow to 8k followers in 4 months.
Voice: calm, practical, zero food-shaming. Short lines. Teach one move per post.
Visual: warm wood counters, soft daylight, muted terracotta + cream, typography-led plates, negative space for text.
Post 3x/week Mon Wed Fri. Mix: one feed tip, one carousel checklist, one reel demo.`,
      },
    })
  ) as { draft?: Record<string, unknown>; error?: string }
  if (!generated.draft || generated.error) {
    throw new Error(`generate_brand_draft failed: ${JSON.stringify(generated)}`)
  }
  console.log('draft keys:', Object.keys(generated.draft).sort().join(', '))

  console.log('\n=== 2) save_brand_profile (+ visual) ===')
  const saved = textPayload(
    await client.callTool({
      name: 'save_brand_profile',
      arguments: { draft: generated.draft },
    })
  ) as {
    brand?: Record<string, unknown> & { id: number; name?: string }
    has_visual_identity?: boolean
    error?: string
  }
  if (!saved.brand?.id || !saved.has_visual_identity) {
    throw new Error(`save failed: ${JSON.stringify(saved)}`)
  }
  const brandId = saved.brand.id
  console.log(`brand_id=${brandId} name=${saved.brand.name} visual=ok`)

  const weekStart = new Date().toISOString().slice(0, 10)
  const proposals = [
    {
      date: weekStart,
      topic: `Fridge-first dinner rule ${stamp}`,
      pillar: 'Weeknight systems',
      format: 'feed',
      angle: 'One check before you shop',
    },
    {
      date: weekStart,
      topic: `5-step one-pan reset ${stamp}`,
      pillar: 'One-pan meals',
      format: 'carousel',
      angle: 'Checklist from empty pan to plated',
    },
    {
      date: weekStart,
      topic: `Chop-once herb jar demo ${stamp}`,
      pillar: 'Prep systems',
      format: 'reel',
      angle: '15-second tip with payoff',
    },
  ]

  console.log('\n=== 3) fill_week dry_run + commit ===')
  const dry = textPayload(
    await client.callTool({
      name: 'fill_week',
      arguments: {
        brand_profile_id: brandId,
        week_start: weekStart,
        dry_run: true,
        proposals,
      },
    })
  ) as { dry_run?: boolean; error?: string }
  if (dry.dry_run !== true || dry.error) throw new Error(`dry_run failed: ${JSON.stringify(dry)}`)

  const committed = textPayload(
    await client.callTool({
      name: 'fill_week',
      arguments: {
        brand_profile_id: brandId,
        week_start: weekStart,
        dry_run: false,
        proposals,
      },
    })
  ) as {
    dry_run?: boolean
    posts?: Array<{ id: number; format: string; topic: string; status: string }>
    error?: string
  }
  if (committed.dry_run !== false || !committed.posts?.length) {
    throw new Error(`commit failed: ${JSON.stringify(committed)}`)
  }
  const postIds = committed.posts.map((p) => p.id)
  console.log(
    'posts:',
    committed.posts.map((p) => `#${p.id} ${p.format}`).join(', ')
  )

  console.log('\n=== 4) start_run_on_post + poll (all formats) ===')
  const results: Array<Record<string, unknown>> = []

  for (const post of committed.posts) {
    console.log(`\n--- post #${post.id} (${post.format}) ---`)
    const started = textPayload(
      await client.callTool({
        name: 'start_run_on_post',
        arguments: { post_id: post.id },
      })
    ) as { run_id?: number; error?: string }
    if (!started.run_id) throw new Error(`start_run failed for ${post.id}: ${JSON.stringify(started)}`)
    console.log(`run_id=${started.run_id}`)

    let status = 'running'
    let runError: string | null = null
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 4000))
      const got = textPayload(
        await client.callTool({
          name: 'get_run',
          arguments: { run_id: started.run_id, event_limit: 12 },
        })
      ) as {
        run?: { status: string; error?: string | null }
        event_count?: number
        events?: Array<{ type: string }>
      }
      status = got.run?.status || status
      runError = got.run?.error || null
      const types = [...new Set((got.events || []).map((e) => e.type))]
      if (i % 3 === 0 || status !== 'running') {
        console.log(
          `  poll#${i + 1} status=${status} events=${got.event_count} types=${types.join(',')}`
        )
      }
      if (status && status !== 'running') break
    }
    if (status !== 'succeeded') {
      throw new Error(`run ${started.run_id} ended ${status}: ${runError || 'unknown'}`)
    }

    const postRes = await fetch(`http://127.0.0.1:3001/api/posts/${post.id}`)
    const body = (await postRes.json()) as {
      post?: {
        id: number
        status: string
        format?: string
        hook?: string
        caption?: string
        agent_output?: string | null
        prompt_vars?: string | null
      }
    }
    const p = body.post
    if (!p) throw new Error(`post ${post.id} missing`)
    const agent = p.agent_output ? (JSON.parse(p.agent_output) as Record<string, unknown>) : {}
    const vars = p.prompt_vars ? (JSON.parse(p.prompt_vars) as Record<string, unknown>) : {}
    const plan = (agent.plan || agent) as Record<string, unknown>
    const review = agent.review as
      | {
          approved?: boolean
          score?: number
          gate?: Record<string, boolean>
          issues?: string[]
        }
      | undefined

    const hookOnImage =
      (typeof agent.hook_on_image === 'string' && agent.hook_on_image) ||
      (typeof plan.hook_on_image === 'string' && plan.hook_on_image) ||
      (typeof vars.hook_on_image === 'string' && vars.hook_on_image) ||
      ''

    const fmt = (p.format || post.format || '').toLowerCase()
    const checks: string[] = []

    if (!['educate', 'entertain', 'feel_seen'].includes(String(agent.job || plan.job || ''))) {
      checks.push('missing job enum')
    }
    if (!(agent.audience_problem || plan.audience_problem)) {
      checks.push('missing audience_problem')
    }
    if (fmt === 'feed') {
      if (!hookOnImage) checks.push('missing hook_on_image')
      else if (wordCount(hookOnImage) > 12) {
        checks.push(`hook_on_image too long (${wordCount(hookOnImage)} words): ${hookOnImage}`)
      }
    }
    if (fmt === 'carousel') {
      const slides = (agent.slides || []) as Array<{ text?: string; role?: string }>
      if (!Array.isArray(slides) || slides.length < 2) checks.push('carousel missing slides')
      else {
        const last = slides[slides.length - 1]
        if (last.role && last.role !== 'cta') checks.push(`last role=${last.role} expected cta`)
        if (!/\b(save|share)\b/i.test(last.text || '')) {
          checks.push(`last slide missing Save/Share: "${last.text}"`)
        }
        const roles = slides.map((s) => s.role).filter(Boolean)
        if (!roles.includes('cover') && slides[0]?.role !== 'cover') {
          // role may be inferred at seed time; check prompt_vars
          const vSlides = (vars.slides || []) as Array<{ role?: string }>
          if (vSlides[0]?.role !== 'cover') checks.push('cover role missing')
        }
      }
    }
    if (fmt === 'reel') {
      const beats = agent.beats as unknown[] | undefined
      if (!Array.isArray(beats) || beats.length < 2) {
        // timed_cues in prompt_vars are the bake path
        const cues = (vars.timed_cues || []) as unknown[]
        if (cues.length < 2) checks.push('reel missing beats/timed_cues')
      }
      if (agent.duration_sec == null && vars.duration == null) {
        checks.push('reel missing duration_sec/duration')
      }
    }
    if (!review) checks.push('missing post_review on draft')
    else if (!review.gate) checks.push('review missing gate')
    else {
      for (const k of ['stop_scroll', 'value_without_caption', 'save_or_send']) {
        if (typeof review.gate[k] !== 'boolean') checks.push(`gate.${k} missing`)
      }
    }
    if (p.status !== 'pending_approval') {
      checks.push(`expected pending_approval got ${p.status}`)
    }

    const summary = {
      id: p.id,
      format: fmt,
      status: p.status,
      job: agent.job || plan.job,
      hook_on_image: hookOnImage.slice(0, 80),
      hook_words: wordCount(hookOnImage),
      review_score: review?.score,
      review_approved: review?.approved,
      gate: review?.gate,
      issues: (review?.issues || []).slice(0, 3),
      checks_failed: checks,
    }
    console.log(JSON.stringify(summary, null, 2))
    results.push(summary)
    if (checks.length) {
      throw new Error(`checklist assertions failed on #${p.id}: ${checks.join('; ')}`)
    }
  }

  await client.close()
  console.log('\nCHECKLIST_BRAND_TEST_OK')
  console.log(
    JSON.stringify(
      {
        brand_id: brandId,
        brand_name: brandName,
        posts: postIds,
        results: results.map((r) => ({
          id: r.id,
          format: r.format,
          review_approved: r.review_approved,
          hook_words: r.hook_words,
        })),
      },
      null,
      2
    )
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
