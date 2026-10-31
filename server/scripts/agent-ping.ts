#!/usr/bin/env node
// Chapter 03+04 smoke: agent loop + durable run timeline in SQLite.
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

import { runAgent } from '../src/agent/loop'
import {
  createRun,
  appendEvent,
  completeRun,
  getRunWithEvents,
  compactPayload,
} from '../src/runs'

async function main() {
  const topic = process.argv.slice(2).join(' ').trim() || '5-minute morning routine'
  const goal = `Draft an Instagram reel concept about: ${topic}`
  const model = process.env.OPENAI_MODEL || null

  console.log(`agent:ping model=${model} topic=${JSON.stringify(topic)}`)
  console.log('---')

  const run = createRun({ goal, model, kind: 'agent' })
  appendEvent(run.id, 'status', { status: 'running' })
  console.log(`[runs] created run_id=${run.id}`)

  try {
    const result = await runAgent({
      goal,
      topic,
      onEvent: ({ type, payload }) => {
        appendEvent(run.id, type, compactPayload(payload))
      },
    })
    completeRun(run.id, 'succeeded')
    console.log('---')
    console.log('ok')
    console.log(JSON.stringify(result.draft, null, 2))

    const timeline = getRunWithEvents(run.id)
    console.log('---')
    console.log(
      `[runs] timeline run_id=${run.id} status=${timeline?.run.status} events=${timeline?.events.length}`
    )
    for (const e of timeline?.events || []) {
      console.log(`  #${e.seq} ${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`)
    }
    console.log(`\nFetch via API: GET /api/runs/${run.id}`)
  } catch (err) {
    completeRun(run.id, 'failed', (err as Error).message || String(err))
    console.error('agent:ping failed:', (err as Error).message || err)
    console.error(`Inspect: GET /api/runs/${run.id}`)
    process.exit(1)
  }
}

main()
