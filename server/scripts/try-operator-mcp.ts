/**
 * Operator MCP loop: generate full brand draft → save → visual → dry/commit fill.
 * Usage: pnpm exec tsx scripts/try-operator-mcp.ts
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

function assertFilled(brand: Record<string, unknown>, keys: string[]) {
  const missing = keys.filter((k) => {
    const v = brand[k]
    return v == null || v === '' || (typeof v === 'string' && !v.trim())
  })
  if (missing.length) throw new Error(`brand missing fields: ${missing.join(', ')}`)
}

async function main() {
  const repoRoot = path.join(__dirname, '..', '..')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }

  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--filter', 'server', 'exec', 'tsx', 'src/mcp-server.ts'],
    cwd: repoRoot,
    env,
    stderr: 'pipe',
  })

  const client = new Client({ name: 'operator-try', version: '1.0.0' })
  await client.connect(transport)

  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name).sort()
  console.log('tools:', names.join(', '))

  const forbidden = ['approve', 'publish', 'request_changes', 'generate_media', 'approve_media']
  const leaked = names.filter((n) => forbidden.some((f) => n.includes(f)))
  if (leaked.length) throw new Error(`forbidden tools registered: ${leaked.join(', ')}`)

  console.log('generate_brand_draft…')
  const generated = textPayload(
    await client.callTool({
      name: 'generate_brand_draft',
      arguments: {
        name: 'Faceless Growth Lab',
        feedback: `Faceless Instagram page teaching audience growth for indie creators.
Goals: grow to 10k engaged followers in 6 months without showing a face.
Niche: content systems, hooks, and consistency for faceless brands.
Audience: solo creators and small agencies who want systems over vibes.
Voice: practical, encouraging, no hype. Short sentences.
Visual: clean typography-on-image, soft gradients, muted blues and cream, plenty of negative space for text.
Post 4x/week Mon Tue Thu Sat. Mix feed + carousel + occasional reel.`,
      },
    })
  ) as { draft?: Record<string, unknown>; error?: string }
  if (!generated.draft || generated.error) {
    throw new Error(`generate_brand_draft failed: ${JSON.stringify(generated)}`)
  }
  console.log('draft keys:', Object.keys(generated.draft).sort().join(', '))

  const saved = textPayload(
    await client.callTool({
      name: 'save_brand_profile',
      arguments: { draft: generated.draft }, // with_visual_identity defaults true
    })
  ) as {
    brand?: Record<string, unknown> & { id: number }
    has_visual_identity?: boolean
    visual_identity?: unknown
    error?: string
  }
  console.log('save_brand_profile:', {
    id: saved.brand?.id,
    name: saved.brand?.name,
    has_visual_identity: saved.has_visual_identity,
    error: saved.error,
  })
  if (!saved.brand?.id) throw new Error(`save failed: ${JSON.stringify(saved)}`)
  if (!saved.has_visual_identity || !saved.brand.visual_identity) {
    throw new Error(`visual identity missing after save: ${JSON.stringify(saved)}`)
  }

  assertFilled(saved.brand, [
    'name',
    'niche',
    'audience',
    'goals',
    'pillars',
    'voice',
    'examples',
    'visual',
    'guide_md',
    'default_background_style',
    'default_format',
    'visual_identity',
  ])
  console.log('brand + visual identity filled OK')

  const brandId = saved.brand.id

  const restBrand = await fetch(`http://127.0.0.1:3001/api/brand-profiles/${brandId}`).then((r) =>
    r.json()
  )
  const b = (restBrand as { brand: Record<string, unknown> }).brand
  assertFilled(b, [
    'examples',
    'visual',
    'guide_md',
    'default_background_style',
    'visual_identity',
  ])
  const palette = JSON.parse(String(b.visual_identity)).palette
  console.log('REST brand complete:', {
    id: b.id,
    name: b.name,
    has_examples: Boolean(b.examples),
    has_visual: Boolean(b.visual),
    has_guide: Boolean(b.guide_md),
    has_identity: Boolean(b.visual_identity),
    palette_primary: palette?.primary,
    bg: b.default_background_style,
  })

  const weekStart = new Date().toISOString().slice(0, 10)
  const stamp = Date.now().toString(36)
  const proposals = [
    {
      date: weekStart,
      topic: `Full brand topic A ${stamp}`,
      pillar: 'Audience growth',
      format: 'feed',
      angle: 'Practical tip',
    },
    {
      date: weekStart,
      topic: `Full brand topic B ${stamp}`,
      pillar: 'Content systems',
      format: 'carousel',
      angle: 'Checklist',
    },
  ]

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
  ) as { dry_run?: boolean; proposals?: unknown[] }
  if (dry.dry_run !== true) throw new Error('expected dry_run true')

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
  ) as { dry_run?: boolean; posts?: Array<{ id: number; status: string }> }
  if (committed.dry_run !== false || !committed.posts?.length) {
    throw new Error(`commit failed: ${JSON.stringify(committed)}`)
  }
  console.log(
    'fill_week commit posts:',
    committed.posts.map((p) => p.id)
  )

  const started = textPayload(
    await client.callTool({
      name: 'start_run_on_post',
      arguments: { post_id: committed.posts[0].id },
    })
  ) as { run_id?: number }
  if (!started.run_id) throw new Error(`start_run failed: ${JSON.stringify(started)}`)

  const restRun = await fetch(`http://127.0.0.1:3001/api/runs/${started.run_id}`).then((r) =>
    r.json()
  )
  const runId = (restRun as { run?: { id: number } }).run?.id
  if (runId !== started.run_id) throw new Error('run_id mismatch vs REST')

  await client.close()
  console.log(`OPERATOR_HARNESS_OK brand_id=${brandId} run_id=${started.run_id}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
