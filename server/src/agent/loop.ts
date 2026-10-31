// Chapter 03 — minimal ReAct-lite agent loop (cognition only).
// Chapter 04 — optional onEvent hook for durable run_events.
import { createStructuredModel } from '../skills/model'
import { DecisionSchema } from './schemas'
import { tools, listToolDescriptions } from './tools'

function now() {
  return Date.now()
}

function compactObservation(obs: unknown) {
  // Keep history small for local models
  const json = JSON.stringify(obs)
  if (json.length <= 2000) return json
  return json.slice(0, 2000) + '…'
}

type AgentEvent = { type: string; payload: Record<string, unknown> }

type BrandInject = {
  brandGuide?: string
  brandConfig?: string
  brandVoice?: string
  brandVisual?: string
}

type RunAgentOpts = {
  goal: string
  topic?: string
  /** Injected into media_prompts so Pexels keywords match operator style. */
  backgroundStyle?: string | null
  /** Forced into skill tool args — model does not need to invent brand fields. */
  brand?: BrandInject | null
  maxSteps?: number
  timeoutMs?: number
  log?: (line: string) => void
  onEvent?: ((event: AgentEvent) => void) | null
}

async function runAgent({
  goal,
  topic,
  backgroundStyle,
  brand = null,
  maxSteps = Number(process.env.AGENT_MAX_STEPS || 8),
  timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 180_000),
  log = console.log,
  onEvent = null,
}: RunAgentOpts) {
  if (!goal || typeof goal !== 'string') {
    throw new Error('runAgent requires a string goal')
  }

  const emit = (type: string, payload: Record<string, unknown>) => {
    if (typeof onEvent === 'function') {
      try {
        onEvent({ type, payload })
      } catch (err) {
        log(`[agent] onEvent error: ${(err as Error).message}`)
      }
    }
  }

  const started = now()
  const history: unknown[] = []
  const effectiveGoal = topic
    ? `${goal}\n\nPrimary topic to use with content_planning: "${topic}"`
    : goal

  const brandNote = brand?.brandGuide
    ? `\nBrand context is injected automatically into every skill call — stay on-brand.`
    : ''

  const system = `You are a drafting agent for Instagram posts.
You must choose exactly one tool per step.

Available tools:
${listToolDescriptions()}

Preferred path:
1) content_planning(topic)
2) caption_writing(hook, angle, format, targetAudience from the plan)
3) media_prompts(hook, angle, caption, format${backgroundStyle ? `, backgroundStyle: "${backgroundStyle}"` : ''}) — produces image_prompt AND stock_search_query; for carousel also slides[]
4) optional post_review
5) finish with a draft that includes ALL of:
   audience, hook, angle, format, tone, hashtag_theme, alt_hooks,
   caption, hashtags, image_prompt, stock_search_query
   (plus optional first_line, cta, reel_prompt, media_type, review)
   If format is carousel, include slides[] (text + image_prompt + stock_search_query per slide) from media_prompts.
${brandNote}

Do not invent tool names. Do not call Pexels or publish — you only draft text artifacts.`

  const decide = createStructuredModel(DecisionSchema, { name: 'agent_decision' })

  for (let step = 1; step <= maxSteps; step++) {
    if (now() - started > timeoutMs) {
      const err = `Agent timeout after ${timeoutMs}ms (step ${step})`
      emit('error', { step, error: err })
      throw new Error(err)
    }

    const prompt = `${system}

Goal:
${effectiveGoal}

Observations so far:
${history.length ? history.map((h, i) => `${i + 1}. ${compactObservation(h)}`).join('\n') : '(none)'}

Choose the next tool as JSON.`

    const decision = await decide.invoke(prompt)
    log(`[agent] step ${step} tool=${decision.tool} thought=${decision.thought || ''}`)
    log(`[agent] step ${step} args=${JSON.stringify(decision.args || {})}`)
    emit('decision', {
      step,
      tool: decision.tool,
      thought: decision.thought || null,
      args: decision.args || {},
    })

    if (decision.tool === 'finish') {
      try {
        const draft = await tools.finish(decision.args || {})
        emit('observation', { step, ok: true, tool: 'finish', draft })
        log(`[agent] finished in ${step} step(s)`)
        return { ok: true as const, draft, steps: step, history }
      } catch (err) {
        const observation = { ok: false, tool: 'finish', error: (err as Error).message }
        history.push(observation)
        emit('observation', { step, ...observation })
        log(`[agent] step ${step} observe=${compactObservation(observation)}`)
        continue
      }
    }

    const fn = tools[decision.tool as keyof typeof tools]
    if (!fn) {
      const observation = { ok: false, error: `unknown tool: ${decision.tool}` }
      history.push(observation)
      emit('observation', { step, ...observation })
      log(`[agent] step ${step} observe=${compactObservation(observation)}`)
      continue
    }

    try {
      const rawArgs = { ...(decision.args || {}) }
      if (
        decision.tool === 'media_prompts' &&
        backgroundStyle &&
        !rawArgs.backgroundStyle &&
        !rawArgs.background_style
      ) {
        rawArgs.backgroundStyle = backgroundStyle
      }
      // Orchestrator-forced brand injection (do not rely on the model passing these).
      if (brand) {
        if (decision.tool === 'content_planning') {
          if (brand.brandGuide) rawArgs.brandGuide = brand.brandGuide
          if (brand.brandConfig) rawArgs.brandConfig = brand.brandConfig
        }
        if (decision.tool === 'caption_writing' || decision.tool === 'post_review') {
          if (brand.brandVoice) rawArgs.brandVoice = brand.brandVoice
        }
        if (decision.tool === 'media_prompts' && brand.brandVisual) {
          rawArgs.brandVisual = brand.brandVisual
        }
      }
      const data = await fn(rawArgs)
      const observation = { ok: true, tool: decision.tool, data }
      history.push(observation)
      emit('observation', { step, ok: true, tool: decision.tool, data })
      log(`[agent] step ${step} observe ok (keys=${Object.keys(data as object).join(',')})`)
    } catch (err) {
      const observation = { ok: false, tool: decision.tool, error: (err as Error).message }
      history.push(observation)
      emit('observation', { step, ...observation })
      log(`[agent] step ${step} observe=${compactObservation(observation)}`)
    }
  }

  const err = `Agent exceeded MAX_STEPS=${maxSteps} without finish`
  emit('error', { error: err })
  throw new Error(err)
}

export { runAgent }
