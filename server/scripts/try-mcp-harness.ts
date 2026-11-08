/**
 * Drive the stdio MCP harness like Cursor would.
 * Usage: pnpm exec tsx scripts/try-mcp-harness.ts
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

  const stderrChunks: string[] = []
  transport.stderr?.on('data', (buf: Buffer) => {
    stderrChunks.push(buf.toString())
  })

  const client = new Client({ name: 'harness-try', version: '1.0.0' })
  await client.connect(transport)

  const tools = await client.listTools()
  console.log(
    'tools:',
    tools.tools.map((t) => t.name).sort().join(', ')
  )

  const listed = textPayload(
    await client.callTool({ name: 'list_posts', arguments: { status: 'draft', limit: 5 } })
  ) as Array<{ id: number; topic?: string; status?: string; format?: string }>
  console.log(
    'list_posts:',
    Array.isArray(listed)
      ? listed.map((p) => ({
          id: p.id,
          status: p.status,
          format: p.format,
          topic: (p.topic || '').slice(0, 48),
        }))
      : listed
  )

  const draft = Array.isArray(listed) ? listed[0] : null
  if (!draft?.id) throw new Error('no draft from list_posts')

  const brand = textPayload(
    await client.callTool({
      name: 'get_brand_context',
      arguments: { post_id: draft.id },
    })
  )
  console.log('get_brand_context:', {
    name: (brand as { name?: string }).name,
    default_format: (brand as { default_format?: string }).default_format,
    brand_profile_id: (brand as { brand_profile_id?: number }).brand_profile_id,
  })

  const started = textPayload(
    await client.callTool({
      name: 'start_run_on_post',
      arguments: { post_id: draft.id },
    })
  ) as { run_id?: number; post_id?: number; status?: string; error?: string }
  console.log('start_run_on_post:', started)
  if (!started.run_id) {
    throw new Error(`start failed: ${JSON.stringify(started)}`)
  }

  const runId = started.run_id
  let lastStatus = ''
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 2500))
    const got = textPayload(
      await client.callTool({
        name: 'get_run',
        arguments: { run_id: runId, event_limit: 12 },
      })
    ) as {
      run?: { id: number; status: string; post_id: number }
      events?: Array<{ type: string }>
      event_count?: number
    }
    lastStatus = got.run?.status || ''
    const types = [...new Set((got.events || []).map((e) => e.type))]
    console.log(`get_run poll#${i + 1}:`, {
      id: got.run?.id,
      status: got.run?.status,
      post_id: got.run?.post_id,
      event_count: got.event_count,
      recent_types: types,
    })

    const rest = await fetch(`http://127.0.0.1:3001/api/runs/${runId}`)
    const body = (await rest.json()) as { run?: { id: number; status: string } }
    console.log('  REST same run_id:', {
      http: rest.status,
      id: body.run?.id,
      status: body.run?.status,
    })

    if (lastStatus && lastStatus !== 'running') break
  }

  const postRes = await fetch(`http://127.0.0.1:3001/api/posts/${draft.id}`)
  const postBody = (await postRes.json()) as { post?: { id: number; status: string }; status?: string }
  const postStatus = postBody.post?.status || postBody.status
  console.log('post after run:', { id: draft.id, status: postStatus })

  await client.close()
  if (stderrChunks.length) {
    console.log('mcp stderr (tail):\n', stderrChunks.join('').slice(-800))
  }
  console.log(
    lastStatus === 'succeeded' || postStatus === 'pending_approval'
      ? `HARNESS_OK run_id=${runId}`
      : `HARNESS_DONE run_id=${runId} run_status=${lastStatus} post_status=${postStatus}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
