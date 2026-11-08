// Chapter 03 — minimal ReAct-lite agent loop (cognition only).
// Chapter 04 — optional onEvent hook for durable run_events.
import { createStructuredModel } from '../skills/model'
import {
  researchBriefToPromptBlock,
  type TopicResearch,
} from '../skills/topic-research'
import {
  assembleDraftFromHistory,
  canAssembleDraft,
  canWriteCaption,
  hasPostReview,
  invalidateDownstream,
  lastOk,
} from './assemble'
import { lintDraft } from './lint'
import { DecisionSchema } from './schemas'
import { tools, listToolDescriptions } from './tools'

function now() {
  return Date.now()
}

/** Prefer keeping carousel slide texts when truncating large tool observations. */
function compactObservation(obs: unknown) {
  const json = JSON.stringify(obs)
  if (json.length <= 3500) return json
  // If media_prompts / finish-shaped data has slides, keep a slim slide outline.
  try {
    const o = obs as {
      tool?: string
      data?: { slides?: Array<{ text?: string; stock_search_query?: string }> }
      draft?: { slides?: Array<{ text?: string }> }
    }
    const slides = o?.data?.slides || o?.draft?.slides
    if (Array.isArray(slides) && slides.length) {
      const slim = {
        ...(typeof obs === 'object' && obs ? obs : {}),
        data: o.data
          ? {
              ...o.data,
              slides: slides.map((s, i) => ({
                i: i + 1,
                text: s.text,
                stock_search_query: (s as { stock_search_query?: string }).stock_search_query,
              })),
            }
          : undefined,
        draft: o.draft
          ? {
              ...o.draft,
              slides: slides.map((s, i) => ({ i: i + 1, text: s.text })),
            }
          : undefined,
        _truncated: true,
      }
      const slimJson = JSON.stringify(slim)
      if (slimJson.length <= 3500) return slimJson
    }
  } catch {
    /* fall through */
  }
  return json.slice(0, 3500) + '…'
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
  /** Existing calendar / operator angle to bias research + planning. */
  angle?: string | null
  pillar?: string | null
  /** Prefer this format when drafting (e.g. post already set to carousel). */
  preferredFormat?: string | null
  maxSlides?: number
  /** Injected into media_prompts so Pexels keywords match operator style. */
  backgroundStyle?: string | null
  /** Forced into skill tool args — model does not need to invent brand fields. */
  brand?: BrandInject | null
  /** When false, skip the deterministic topic_research pre-step. Default true. */
  enableResearch?: boolean
  /** Operator "request changes" notes — threaded into plan/media/caption as must-address feedback. */
  revisionNotes?: string | null
  maxSteps?: number
  timeoutMs?: number
  log?: (line: string) => void
  onEvent?: ((event: AgentEvent) => void) | null
}

async function runAgent({
  goal,
  topic,
  angle = null,
  pillar = null,
  preferredFormat = null,
  maxSlides = 5,
  backgroundStyle,
  brand = null,
  enableResearch = process.env.AGENT_SKIP_RESEARCH !== '1',
  revisionNotes = null,
  // 12 = research + plan/media/caption/review + one full revision pass + finish.
  maxSteps = Number(process.env.AGENT_MAX_STEPS || 12),
  timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 240_000),
  // Default to stderr so agent logs don't corrupt the MCP stdio protocol stream.
  log = console.error,
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
  let researchBrief: string | null = null
  let researchData: TopicResearch | null = null

  // Deterministic research pre-step (before the decision loop)
  if (enableResearch && topic?.trim()) {
    const step = 0
    emit('decision', {
      step,
      tool: 'topic_research',
      thought: 'Research topic before planning',
      args: { topic, angle, pillar },
    })
    try {
      const data = (await tools.topic_research({
        topic: topic.trim(),
        angle: angle || undefined,
        pillar: pillar || undefined,
        brandGuide: brand?.brandGuide,
      })) as TopicResearch
      researchData = data
      researchBrief = researchBriefToPromptBlock(data)
      const observation = { ok: true, tool: 'topic_research', data }
      history.push(observation)
      emit('observation', { step, ok: true, tool: 'topic_research', data })
      log(
        `[agent] topic_research ok mode=${data.mode} facts=${data.key_facts?.length || 0} angles=${data.angles?.length || 0}`
      )
    } catch (err) {
      const observation = {
        ok: false,
        tool: 'topic_research',
        error: (err as Error).message,
      }
      history.push(observation)
      emit('observation', { step, ...observation })
      log(`[agent] topic_research failed: ${(err as Error).message} — continuing without research`)
    }
  }

  const formatNote = preferredFormat
    ? `\nPreferred format for this post: "${preferredFormat}". Keep this format unless the topic clearly requires otherwise.`
    : ''
  const researchNote = researchBrief
    ? `\nTopic research is already done (see observations). Use it when calling content_planning — do not call topic_research again unless it failed.`
    : ''
  const effectiveGoal = topic
    ? `${goal}\n\nPrimary topic to use with content_planning: "${topic}"${formatNote}${researchNote}`
    : `${goal}${formatNote}${researchNote}`

  const brandNote = brand?.brandGuide
    ? `\nBrand context is injected automatically into every skill call — stay on-brand.`
    : ''

  const system = `You are a drafting agent for Instagram posts.
You must choose exactly one tool per step.

Available tools:
${listToolDescriptions()}

Required order:
1) topic_research(topic) — already completed by the orchestrator when possible; skip if observations include a successful topic_research
2) content_planning(topic) — ground hook/angle/job/audience_problem/hook_on_image in research when available
3) media_prompts(hook, hook_on_image, angle, format${backgroundStyle ? `, backgroundStyle: "${backgroundStyle}"` : ''}) — scene must depict the tip; carousel slides[] with roles; reel beats[] + duration_sec (6–15s, one clip)
4) caption_writing — AFTER media so the caption matches the slides / beats (plan + media fields are injected)
5) post_review — REQUIRED before finish. Scores checklist + 10-second gate; deterministic rule failures are injected.
6) If post_review.approved is false, revise once: content_planning (if the hook/angle/job is the problem) or media_prompts (if visuals/slides/beats are the problem). Review issues are passed to the revised step automatically. Steps that depend on the revised one are invalidated and must be re-run in order, then post_review again; then finish even if still weak (HITL will decide).
7) finish with args {} (empty). Do NOT re-send the full draft — the orchestrator merges prior observations.
Observations marked "stale": true were superseded by a revision — ignore them.
${brandNote}

On-image hook rules (feed/carousel cover): use plan.hook_on_image — ≤12 words, one scannable takeaway (step, check, number, before/after), not a vague opinion.

Do not invent tool names. Do not call Pexels or publish — you only draft text artifacts.`

  const decide = createStructuredModel(DecisionSchema, { name: 'agent_decision' })
  /** Must-address notes threaded into plan / media / caption (operator notes + failed review). */
  const feedback: string[] = []
  if (revisionNotes?.trim()) feedback.push(`Operator: ${revisionNotes.trim()}`)
  let lastFailedTool: string | null = null
  let sameToolFailStreak = 0
  /** Counts successful post_review calls; finish after approve or 2nd review (one revision). */
  let reviewAttempts = 0

  const tryFinishAssembled = (step: number, thought: string) => {
    const draft = assembleDraftFromHistory(history, { preferredFormat, topic })
    emit('decision', { step, tool: 'finish', thought, args: {} })
    emit('observation', { step, ok: true, tool: 'finish', draft })
    log(`[agent] finished via assemble (${thought})`)
    return { ok: true as const, draft, steps: step, history }
  }

  const lastReviewApproved = () => {
    const review = lastOk(history, 'post_review') as { approved?: boolean } | null
    return Boolean(review?.approved)
  }

  /** Next tool in the required pipeline given (non-stale) history. */
  const nextRequiredTool = ():
    | 'content_planning'
    | 'media_prompts'
    | 'caption_writing'
    | 'post_review'
    | 'finish' => {
    if (!lastOk(history, 'content_planning')) return 'content_planning'
    if (!canWriteCaption(history, preferredFormat)) return 'media_prompts'
    if (!canAssembleDraft(history, preferredFormat)) return 'caption_writing'
    if (!hasPostReview(history)) return 'post_review'
    return 'finish'
  }

  /** Lint input from the latest plan + media + caption. */
  const currentLint = () => {
    const plan = lastOk(history, 'content_planning') || {}
    const media = lastOk(history, 'media_prompts') || {}
    const cap = lastOk(history, 'caption_writing') || {}
    const format = String(preferredFormat || plan.format || 'feed').toLowerCase()
    return lintDraft({
      format: Array.isArray(media.slides) && (media.slides as unknown[]).length >= 2 ? 'carousel' : format,
      hook_on_image: (plan.hook_on_image as string) || (plan.hook as string),
      caption: cap.caption as string,
      hashtags: cap.hashtags as string,
      first_line: cap.first_line as string,
      cta: cap.cta as string,
      slides: media.slides as Array<{ text?: string; role?: string }>,
      beats: media.beats as Array<{ t_start?: number; on_screen_text_intent?: string }>,
      duration_sec: media.duration_sec as number,
    })
  }

  /** Finish when review passed, or after second review (one revision allowed). */
  const readyToFinish = () => {
    if (!canAssembleDraft(history, preferredFormat) || !hasPostReview(history)) return false
    if (lastReviewApproved()) return true
    return reviewAttempts >= 2
  }

  for (let step = 1; step <= maxSteps; step++) {
    if (now() - started > timeoutMs) {
      const err = `Agent timeout after ${timeoutMs}ms (step ${step})`
      emit('error', { step, error: err })
      throw new Error(err)
    }

    // Auto-finish only after checklist review (avoids huge finish JSON + skips optional review).
    if (readyToFinish() && step > 1) {
      const last = history[history.length - 1] as { ok?: boolean; tool?: string; data?: { approved?: boolean } }
      const justReviewed =
        last?.ok && last.tool === 'post_review'
      if (justReviewed || step >= 5) {
        try {
          return tryFinishAssembled(step, 'Auto-assembled after post_review')
        } catch (err) {
          log(`[agent] assemble failed: ${(err as Error).message}`)
        }
      }
    }

    const required = nextRequiredTool()
    const nextHint = readyToFinish()
      ? '\nPlan + media + caption + post_review exist — choose finish with args {}.'
      : required === 'finish'
        ? '\npost_review failed — revise once (content_planning or media_prompts).'
        : `\nNext required step: ${required}.`
    const feedbackNote = feedback.length
      ? `\n\nMust-address feedback (threaded into revised steps automatically):\n- ${feedback.join('\n- ')}`
      : ''

    const prompt = `${system}

Goal:
${effectiveGoal}${feedbackNote}

Observations so far:
${history.length ? history.map((h, i) => `${i + 1}. ${compactObservation(h)}`).join('\n') : '(none)'}

Choose the next tool as JSON.${nextHint}`

    let decision
    try {
      decision = await decide.invoke(prompt)
    } catch (err) {
      if (readyToFinish()) {
        log(`[agent] decide failed (${(err as Error).message}); assembling draft from history`)
        return tryFinishAssembled(step, 'Recovered after decide JSON error via assemble')
      }
      emit('error', { step, error: (err as Error).message })
      throw err
    }
    log(`[agent] step ${step} tool=${decision.tool} thought=${decision.thought || ''}`)
    log(`[agent] step ${step} args=${JSON.stringify(decision.args || {})}`)
    emit('decision', {
      step,
      tool: decision.tool,
      thought: decision.thought || null,
      args: decision.args || {},
    })

    if (decision.tool === 'finish') {
      if (!canAssembleDraft(history, preferredFormat)) {
        // Draft incomplete — reject so the next step fills the missing piece.
        const observation = {
          ok: false as const,
          tool: 'finish',
          error: `Cannot finish yet: draft incomplete. Run ${nextRequiredTool()} next.`,
        }
        history.push(observation)
        emit('observation', { step, ...observation })
        log(`[agent] early finish rejected — next required ${nextRequiredTool()}`)
        continue
      } else if (!hasPostReview(history)) {
        // Force checklist review before finish
        decision = {
          thought: 'post_review required before finish',
          tool: 'post_review' as const,
          args: {},
        }
        emit('decision', {
          step,
          tool: 'post_review',
          thought: decision.thought,
          args: {},
        })
        log(`[agent] redirected finish → post_review`)
      } else {
        try {
          let draft
          const args = decision.args || {}
          if (!args.draft || typeof args.draft !== 'object') {
            draft = assembleDraftFromHistory(history, { preferredFormat, topic })
          } else {
            try {
              draft = await tools.finish(args)
            } catch {
              draft = assembleDraftFromHistory(history, { preferredFormat, topic })
            }
          }
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
    }

    // Enforce pipeline order: never run a step whose inputs are missing, and don't
    // repeat a completed step unless revising after a failed review.
    {
      const order = ['content_planning', 'media_prompts', 'caption_writing', 'post_review'] as const
      const chosen = order.indexOf(decision.tool as (typeof order)[number])
      const req = nextRequiredTool()
      const reqIdx = req === 'finish' ? order.length : order.indexOf(req)
      // req === 'finish' means a review exists: either done, or failed and the model may
      // revise any step — only redirect while the first pass is still incomplete.
      const skipAhead = chosen > reqIdx
      const repeatDone = chosen >= 0 && chosen < reqIdx
      if ((skipAhead || repeatDone) && req !== 'finish') {
        log(`[agent] redirected ${decision.tool} → ${req} (pipeline order)`)
        decision = { thought: `pipeline order: ${req} next`, tool: req, args: {} }
        emit('decision', { step, tool: req, thought: decision.thought, args: {} })
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
      if (decision.tool === 'media_prompts') {
        rawArgs.maxSlides = maxSlides
        if (preferredFormat && !rawArgs.format) rawArgs.format = preferredFormat
      }
      if (decision.tool === 'content_planning' && preferredFormat && !rawArgs.format) {
        rawArgs.preferredFormat = preferredFormat
      }
      if (decision.tool === 'content_planning') {
        if (!rawArgs.topic && topic) rawArgs.topic = topic
        if (!rawArgs.angle && angle) rawArgs.angle = angle
        if (researchBrief && !rawArgs.researchBrief) rawArgs.researchBrief = researchBrief
      }
      if (decision.tool === 'topic_research') {
        if (!rawArgs.topic && topic) rawArgs.topic = topic
        if (!rawArgs.angle && angle) rawArgs.angle = angle
        if (!rawArgs.pillar && pillar) rawArgs.pillar = pillar
        if (researchData) {
          const observation = {
            ok: true,
            tool: 'topic_research',
            data: researchData,
            note: 'skipped repeat topic_research',
          }
          history.push(observation)
          emit('observation', { step, ...observation })
          log(`[agent] skipped repeat topic_research`)
          continue
        }
      }

      // Inject plan / caption / media fields so tools stay consistent.
      const planData = lastOk(history, 'content_planning')
      const captionData = lastOk(history, 'caption_writing')
      const mediaData = lastOk(history, 'media_prompts')
      if (
        feedback.length &&
        (decision.tool === 'content_planning' ||
          decision.tool === 'media_prompts' ||
          decision.tool === 'caption_writing')
      ) {
        rawArgs.feedback = [...feedback]
      }
      if (decision.tool === 'caption_writing' && planData) {
        if (!rawArgs.hook) rawArgs.hook = planData.hook
        if (!rawArgs.hook_on_image && !rawArgs.hookOnImage) {
          rawArgs.hook_on_image = planData.hook_on_image
        }
        if (!rawArgs.angle) rawArgs.angle = planData.angle
        if (!rawArgs.format) rawArgs.format = preferredFormat || planData.format
        if (!rawArgs.targetAudience) rawArgs.targetAudience = planData.audience
        if (!rawArgs.job) rawArgs.job = planData.job
        if (!rawArgs.audienceProblem) rawArgs.audienceProblem = planData.audience_problem
        if (!rawArgs.hashtagTheme) rawArgs.hashtagTheme = planData.hashtag_theme
        if (mediaData) {
          if (!rawArgs.slides && Array.isArray(mediaData.slides)) rawArgs.slides = mediaData.slides
          if (!rawArgs.beats && Array.isArray(mediaData.beats)) rawArgs.beats = mediaData.beats
        }
      }
      if (decision.tool === 'media_prompts' && planData) {
        if (!rawArgs.hook) rawArgs.hook = planData.hook
        if (!rawArgs.hook_on_image && !rawArgs.hookOnImage) {
          rawArgs.hook_on_image = planData.hook_on_image || planData.hook
        }
        if (!rawArgs.angle) rawArgs.angle = planData.angle
        if (!rawArgs.format) rawArgs.format = preferredFormat || planData.format
      }
      if (decision.tool === 'post_review') {
        rawArgs.lintFailures = currentLint()
        if (planData) {
          if (!rawArgs.hook) rawArgs.hook = planData.hook
          if (!rawArgs.hook_on_image && !rawArgs.hookOnImage) {
            rawArgs.hook_on_image = planData.hook_on_image
          }
          if (!rawArgs.format) rawArgs.format = preferredFormat || planData.format
          if (!rawArgs.job) rawArgs.job = planData.job
          if (!rawArgs.audienceProblem) rawArgs.audienceProblem = planData.audience_problem
        }
        if (captionData) {
          if (!rawArgs.caption) rawArgs.caption = captionData.caption
          if (!rawArgs.hashtags) rawArgs.hashtags = captionData.hashtags
        }
        if (mediaData) {
          if (!rawArgs.imagePrompt && !rawArgs.image_prompt) {
            rawArgs.imagePrompt = mediaData.image_prompt
          }
          if (!rawArgs.reelPrompt && !rawArgs.reel_prompt) {
            rawArgs.reelPrompt = mediaData.reel_prompt
          }
          if (!rawArgs.slides && Array.isArray(mediaData.slides)) {
            rawArgs.slides = mediaData.slides
          }
          if (!rawArgs.beats && Array.isArray(mediaData.beats)) rawArgs.beats = mediaData.beats
          if (rawArgs.durationSec == null && typeof mediaData.duration_sec === 'number') {
            rawArgs.durationSec = mediaData.duration_sec
          }
        }
        if (captionData) {
          if (!rawArgs.cta) rawArgs.cta = captionData.cta
          if (!rawArgs.firstLine) rawArgs.firstLine = captionData.first_line
        }
      }

      if (brand) {
        if (decision.tool === 'content_planning' || decision.tool === 'topic_research') {
          if (brand.brandGuide) rawArgs.brandGuide = brand.brandGuide
          if (decision.tool === 'content_planning' && brand.brandConfig) {
            rawArgs.brandConfig = brand.brandConfig
          }
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
      lastFailedTool = null
      sameToolFailStreak = 0

      // A re-plan / re-brief invalidates everything built on the old version.
      const invalidated = invalidateDownstream(history, decision.tool)
      if (invalidated) {
        log(`[agent] ${decision.tool} revised — ${invalidated} downstream observation(s) marked stale`)
        emit('invalidate', { step, tool: decision.tool, count: invalidated })
      }

      if (decision.tool === 'post_review') {
        reviewAttempts += 1
        const approved = Boolean((data as { approved?: boolean })?.approved)
        if (approved) {
          try {
            return tryFinishAssembled(step, 'Assembled after approved post_review')
          } catch (err) {
            log(`[agent] post-review assemble failed: ${(err as Error).message}`)
          }
        } else if (reviewAttempts < 2) {
          const r = data as { issues?: string[]; suggestions?: string[]; lint?: string[] }
          for (const line of [...(r.issues || []), ...(r.suggestions || []).map((x) => `Fix: ${x}`)]) {
            if (line?.trim() && !feedback.includes(line.trim())) feedback.push(line.trim())
          }
          log(`[agent] post_review not approved; allowing one revision pass (${feedback.length} feedback items)`)
        } else {
          try {
            return tryFinishAssembled(
              step,
              'Assembled after post_review fail (HITL); revision budget exhausted'
            )
          } catch (err) {
            log(`[agent] post-review fail assemble failed: ${(err as Error).message}`)
          }
        }
      }
    } catch (err) {
      const observation = { ok: false, tool: decision.tool, error: (err as Error).message }
      history.push(observation)
      emit('observation', { step, ...observation })
      log(`[agent] step ${step} observe=${compactObservation(observation)}`)
      if (decision.tool === lastFailedTool) sameToolFailStreak += 1
      else {
        lastFailedTool = decision.tool
        sameToolFailStreak = 1
      }
      if (sameToolFailStreak >= 3) {
        const errMsg = `Agent aborted: ${decision.tool} failed ${sameToolFailStreak} times in a row — ${(err as Error).message}`
        emit('error', { step, error: errMsg })
        throw new Error(errMsg)
      }
    }
  }

  const err = `Agent exceeded MAX_STEPS=${maxSteps} without finish`
  emit('error', { error: err })
  throw new Error(err)
}

export { runAgent }
