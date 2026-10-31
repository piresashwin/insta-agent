#!/usr/bin/env node
// Ping the configured OpenAI-compatible chat model (LM Studio, OpenAI, …).
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

import { createModel } from '../src/skills/model'

async function main() {
  const modelId = process.env.OPENAI_MODEL
  const baseURL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:1234/v1'
  console.log(`Pinging model=${modelId} baseURL=${baseURL}`)

  const model = createModel()
  const result = await model.invoke('Reply with exactly: pong')
  const text =
    typeof result?.content === 'string'
      ? result.content
      : Array.isArray(result?.content)
        ? result.content.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text || '')).join('')
        : String(result?.content ?? result)

  console.log('ok')
  console.log(`model: ${modelId}`)
  console.log(`response: ${text.trim()}`)
}

main().catch((err) => {
  console.error('ping failed:', (err as Error).message || err)
  process.exit(1)
})
