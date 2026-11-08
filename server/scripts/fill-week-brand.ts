/**
 * Dry-run then commit fill_week for a brand via MCP.
 * Usage: pnpm exec tsx scripts/fill-week-brand.ts [brandId]
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

async function main() {
  const brandId = Number(process.argv[2] || 6)
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
  const client = new Client({ name: 'fill-week', version: '1.0.0' })
  await client.connect(transport)

  const weekStart = new Date().toISOString().slice(0, 10)
  console.log(`fill_week brand=${brandId} week_start=${weekStart} (auto-plan)`)

  const dry = textPayload(
    await client.callTool({
      name: 'fill_week',
      arguments: {
        brand_profile_id: brandId,
        week_start: weekStart,
        dry_run: true,
      },
    })
  ) as {
    dry_run?: boolean
    proposals?: Array<{
      date: string
      topic: string
      pillar: string | null
      format: string
      angle: string | null
    }>
    error?: string
  }

  if (dry.error || dry.dry_run !== true || !dry.proposals?.length) {
    throw new Error(`dry_run failed: ${JSON.stringify(dry)}`)
  }

  console.log('\nProposals (dry_run):')
  for (const [i, p] of dry.proposals.entries()) {
    console.log(
      `  ${i + 1}. [${p.date}] ${p.format} · ${p.pillar || '—'} — ${p.topic}`
    )
    if (p.angle) console.log(`      angle: ${p.angle}`)
  }

  const committed = textPayload(
    await client.callTool({
      name: 'fill_week',
      arguments: {
        brand_profile_id: brandId,
        week_start: weekStart,
        dry_run: false,
        proposals: dry.proposals,
      },
    })
  ) as {
    dry_run?: boolean
    posts?: Array<{ id: number; topic: string; status: string; format: string; scheduled_at: string }>
    error?: string
  }

  if (committed.error || committed.dry_run !== false || !committed.posts?.length) {
    throw new Error(`commit failed: ${JSON.stringify(committed)}`)
  }

  console.log('\nCommitted drafts:')
  for (const p of committed.posts) {
    console.log(`  #${p.id} [${p.status}] ${p.format} @ ${p.scheduled_at} — ${p.topic}`)
  }

  const to = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
  const cal = textPayload(
    await client.callTool({
      name: 'list_calendar',
      arguments: { from: weekStart, to, brand_profile_id: brandId },
    })
  ) as { posts?: Array<{ id: number; status: string; topic: string }> }

  console.log(`\nCalendar (${weekStart} → ${to}): ${(cal.posts || []).length} posts`)
  await client.close()
  console.log(
    `FILL_WEEK_OK brand_id=${brandId} posts=${committed.posts.map((p) => p.id).join(',')}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
