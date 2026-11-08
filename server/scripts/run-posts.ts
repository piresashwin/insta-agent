/**
 * start_run_on_post for one or more post ids; poll until done.
 * Usage: pnpm exec tsx scripts/run-posts.ts 39 40 41 42
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
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  if (!ids.length) throw new Error('Usage: tsx scripts/run-posts.ts <postId>…')

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
  const client = new Client({ name: 'run-posts', version: '1.0.0' })
  await client.connect(transport)

  for (const postId of ids) {
    console.log(`\n=== start_run_on_post ${postId} ===`)
    const started = textPayload(
      await client.callTool({
        name: 'start_run_on_post',
        arguments: { post_id: postId },
      })
    ) as { run_id?: number; error?: string; post_status?: string }

    if (!started.run_id) {
      console.error('failed:', started)
      continue
    }
    console.log(`run_id=${started.run_id} (was ${started.post_status})`)

    let status = 'running'
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const got = textPayload(
        await client.callTool({
          name: 'get_run',
          arguments: { run_id: started.run_id, event_limit: 8 },
        })
      ) as {
        run?: { status: string; error?: string | null }
        event_count?: number
        events?: Array<{ type: string }>
      }
      status = got.run?.status || status
      const types = [...new Set((got.events || []).map((e) => e.type))]
      console.log(`  poll#${i + 1} status=${status} events=${got.event_count} types=${types.join(',')}`)
      if (status && status !== 'running') {
        if (got.run?.error) console.log('  error:', got.run.error)
        break
      }
    }

    const postRes = await fetch(`http://127.0.0.1:3001/api/posts/${postId}`)
    const body = (await postRes.json()) as {
      post?: { id: number; status: string; hook?: string; caption?: string; format?: string }
    }
    const p = body.post
    console.log('  post:', {
      id: p?.id,
      status: p?.status,
      format: p?.format,
      hook: (p?.hook || '').slice(0, 80),
      caption: (p?.caption || '').slice(0, 80),
    })
  }

  await client.close()
  console.log('\nRUN_POSTS_DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
