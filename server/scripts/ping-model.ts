#!/usr/bin/env node
// Ping each LLM role to verify connectivity and configuration.
// Usage: pnpm model:ping
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

import { resolveRole, type LlmRole } from '../src/llm/roles'
import { createModel } from '../src/skills/model'

const roles: LlmRole[] = ['writer', 'judge', 'planner', 'vision']

async function pingRole(role: LlmRole): Promise<{ role: string; model: string; ok: boolean; detail: string }> {
  const { modelId } = resolveRole(role)
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1234/v1'
  try {
    const model = createModel({ model: modelId, maxTokens: 10 })
    const result = await model.invoke('Reply with exactly: pong')
    const text =
      typeof result?.content === 'string'
        ? result.content
        : Array.isArray(result?.content)
          ? result.content
              .map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text || ''))
              .join('')
          : String(result?.content ?? result)
    return { role, model: modelId, ok: true, detail: text.trim().slice(0, 80) }
  } catch (err) {
    return { role, model: modelId, ok: false, detail: (err as Error).message?.slice(0, 120) ?? String(err) }
  }
}

async function main() {
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1234/v1'
  console.log(`Base URL: ${baseUrl}\n`)

  let allOk = true
  for (const role of roles) {
    const r = await pingRole(role)
    const status = r.ok ? '✓' : '✗'
    console.log(`${status} ${r.role.padEnd(8)} model=${r.model}`)
    if (!r.ok) {
      console.log(`  error: ${r.detail}`)
      allOk = false
    } else {
      console.log(`  reply: ${r.detail}`)
    }
  }

  if (!allOk) {
    console.error('\nSome roles failed. Set LLM_WRITER / LLM_JUDGE / LLM_PLANNER / LLM_VISION or OPENAI_* env vars.')
    process.exit(1)
  }
  console.log('\nAll roles OK.')
}

main().catch((err) => {
  console.error('ping failed:', (err as Error).message || err)
  process.exit(1)
})
