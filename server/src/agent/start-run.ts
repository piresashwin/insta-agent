/**
 * Shared agent-run starter for REST and MCP.
 * Creates a durable run_id, policy-gates, returns immediately, then runs cognition async.
 *
 * AGENT_MODE env var selects execution path:
 *   (default) pipeline  — deterministic pipeline in generation/pipeline.ts
 *   loop                — legacy ReAct loop in agent/loop.ts
 */
import type { Post, PostFormat } from '@instagram-agent/shared'
import { runAgent } from './loop'
import type { FinishDraft } from './schemas'
import { resolveBrandContextV2 } from '../generation/brand-context'
import { runPipeline } from '../generation/pipeline'
import db from '../db'
import {
  appendEvent,
  compactPayload,
  completeRun,
  createRun,
  getRun,
  listRuns,
} from '../runs'
import {
  ApiError,
  canStartAgentRun,
  getPost,
  transitionPost,
} from '../orchestrator'
import { AGENT_PIPELINE, assertAllowed, type PolicyActor } from '../policy'
import { storeProposedVersion, snapshotFromPost } from '../services/versions'
import { historyActorFrom } from '../services/attribution'
import { resolveBrandContext } from '../brand'
import {
  emptyCanvasDoc,
  sceneOnlySubject,
  seedPromptVars,
  shortOnImageText,
} from '../prompts/format-templates'
import { applyPlatePromptsFromVars } from '../media/autogen'
import { clampReelDuration, normalizeAltText } from '../instagram-rules'
import {
  applyCarouselSlidePlan,
  ensureSlidesForFormat,
} from '../slides'

function normalizeFormat(raw?: string | null): PostFormat {
  if (raw === 'reel' || raw === 'carousel' || raw === 'feed') return raw
  return 'feed'
}

export type StartAgentRunResult = {
  post: Post
  run_id: number
  job_id?: number
  note: string
  /** Resolves when the inline cognition body finishes (inline path only). */
  done?: Promise<void>
}

export type StartAgentRunOpts = {
  /** Who initiates the run (dashboard human or MCP). Cognition still uses AGENT_PIPELINE. */
  initiator?: PolicyActor | null
  /**
   * inline=true: run cognition in-process (job worker / MCP_EMBEDDED_WORKER).
   * inline=false (default): create the run, enqueue an agent_run job, return immediately.
   */
  inline?: boolean
  /** Resume an already-created run (job worker path). */
  existingRunId?: number
}

/**
 * Start cognition on a post. By default enqueues a job and returns { run_id, job_id }.
 * Job worker calls with `{ inline: true, existingRunId }` to execute.
 */
export function startAgentRunOnPost(
  postId: string | number,
  opts: StartAgentRunOpts = {}
): StartAgentRunResult {
  const post = getPost(postId)
  if (!post) throw new ApiError(404, 'post not found')

  if (!canStartAgentRun(post)) {
    throw new ApiError(
      409,
      `Cannot run agent from status "${post.status}" (allowed: draft, changes_requested)`
    )
  }

  const alreadyRunning = listRuns({ postId: Number(post.id), limit: 5 }).find(
    (r) => r.status === 'running' && (r.kind === 'agent' || r.kind === 'pipeline')
  )
  if (alreadyRunning && !opts.existingRunId) {
    const err = new ApiError(
      409,
      `Agent already running (run_id=${alreadyRunning.id})`
    ) as ApiError & { run_id?: number }
    err.run_id = alreadyRunning.id
    throw err
  }

  const revisionNote =
    post.status === 'changes_requested' && post.revision_comments
      ? `\nOperator revision notes (must address): ${post.revision_comments}`
      : ''

  const brandCtx = resolveBrandContext(post)
  const styleNote = brandCtx.backgroundStyle
    ? `\nPreferred background style: "${brandCtx.backgroundStyle}". When calling media_prompts, pass backgroundStyle: "${brandCtx.backgroundStyle}" so stock_search_query aligns.`
    : ''
  const brandNote = brandCtx.profile
    ? `\nBrand profile: "${brandCtx.profile.name}". Stay on-brand (voice + visual).`
    : ''
  const pillarNote = post.pillar ? `\nContent pillar: ${post.pillar}.` : ''
  const angleNote = post.angle ? `\nAngle / POV: ${post.angle}.` : ''

  const preferredFormat = post.format ? normalizeFormat(post.format) : null
  const maxSlides = brandCtx.maxSlides
  const formatNote = preferredFormat
    ? `\nThis post is already set to format "${preferredFormat}" — keep it unless clearly wrong.`
    : ''
  const carouselNote =
    preferredFormat === 'carousel' || brandCtx.profile?.default_format === 'carousel'
      ? `\nFor carousel: media_prompts and finish MUST include slides[] (≤${maxSlides}) with distinct text + visuals per slide.`
      : ''

  const goal = `Draft a complete Instagram post for topic "${post.topic || '(no topic)'}".
Produce hook, caption, hashtags, image_prompt, and stock_search_query (short Pexels keywords).
Do not publish or fetch media.${formatNote}${carouselNote}${styleNote}${brandNote}${pillarNote}${angleNote}${revisionNote}

Brand brief:
${brandCtx.briefMd}`

  let run = opts.existingRunId ? getRun(opts.existingRunId) : null
  if (opts.existingRunId && !run) {
    throw new ApiError(404, `run ${opts.existingRunId} not found`)
  }
  if (!run) {
    const hist = historyActorFrom(
      opts.initiator
        ? {
            id: opts.initiator.id,
            name: opts.initiator.name,
            role: opts.initiator.role,
          }
        : { id: 'agent:pipeline', name: 'content-pipeline', role: 'agent' },
    )
    run = createRun({
      goal,
      postId: Number(post.id),
      model: process.env.OPENAI_MODEL || null,
      kind: process.env.AGENT_MODE === 'loop' ? 'agent' : 'pipeline',
      actor_kind: hist.kind,
      actor_name: hist.name,
      actor_client: hist.client ?? null,
    })
    appendEvent(run.id, 'status', { status: 'running' })
  }

  const agentActor: PolicyActor = { ...AGENT_PIPELINE, run_id: run.id }
  // Gate: agent may draft. Initiator (MCP/human) also must be allowed to start drafts.
  assertAllowed(agentActor, 'post.draft', { type: 'post', post }, run.id)
  if (opts.initiator) {
    assertAllowed(opts.initiator, 'post.draft', { type: 'post', post }, run.id)
  }

  const post_id = post.id
  const versionAtStart = Number((post as Post & { version?: number }).version ?? 1)
  const inline = opts.inline === true

  if (!inline) {
    // Dynamic import avoids a circular dependency with jobs.ts (handler → start-run).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { enqueueJob } = require('../jobs') as typeof import('../jobs')
    const jobId = enqueueJob({
      kind: 'agent_run',
      post_id: Number(post.id),
      run_id: run.id,
      payload: {
        post_id: Number(post.id),
        run_id: run.id,
        initiator: opts.initiator
          ? { id: opts.initiator.id, name: opts.initiator.name, role: opts.initiator.role }
          : null,
      },
      dedupe_key: `agent_run:${post.id}`,
    })
    return {
      post,
      run_id: run.id,
      job_id: jobId,
      note: 'Agent run queued — worker will execute; subscribe to GET /api/runs/:id/events or GET /api/jobs/:id',
    }
  }

  const done = (async () => {
    try {
      if (process.env.AGENT_MODE === 'loop') {
        // ── Legacy ReAct loop path ────────────────────────────────────────────
        const result = await runAgent({
          goal,
          topic: post.topic || undefined,
          angle: post.angle || undefined,
          pillar: post.pillar || undefined,
          preferredFormat,
          maxSlides,
          backgroundStyle: brandCtx.backgroundStyle,
          revisionNotes:
            post.status === 'changes_requested' ? post.revision_comments || null : null,
          brand: {
            brandGuide: brandCtx.briefMd,
            brandConfig: brandCtx.profile
              ? JSON.stringify({
                  name: brandCtx.profile.name,
                  niche: brandCtx.profile.niche,
                  audience: brandCtx.profile.audience,
                  goals: brandCtx.profile.goals,
                  visual_identity: brandCtx.visualIdentity,
                  default_format: brandCtx.profile.default_format,
                })
              : undefined,
            brandVoice: brandCtx.voiceBrief || brandCtx.briefMd,
            brandVisual: brandCtx.visualBrief,
          },
          onEvent: (event) => {
            appendEvent(run.id, event.type, compactPayload(event.payload))
          },
        })

        const draft = result.draft as FinishDraft & { research?: unknown }
        const researchObs = [...(result.history || [])]
          .reverse()
          .find(
            (h) =>
              h &&
              typeof h === 'object' &&
              (h as { ok?: boolean; tool?: string }).ok &&
              (h as { tool?: string }).tool === 'topic_research'
          ) as { data?: unknown } | undefined
        if (researchObs?.data) {
          draft.research = researchObs.data
        }
        const latest = getPost(post_id)
        if (!latest) {
          completeRun(run.id, 'failed', 'post missing after agent loop')
          return
        }

        const hookAlternates = draft.alt_hooks
          ? JSON.stringify(draft.alt_hooks)
          : latest.hook_alternates

        let format = normalizeFormat(draft.format)
        if (
          preferredFormat === 'carousel' &&
          format !== 'carousel' &&
          draft.slides &&
          draft.slides.length >= 2
        ) {
          format = 'carousel'
        } else if (preferredFormat && preferredFormat !== 'feed' && format === 'feed') {
          format = preferredFormat
        }

        if (format === 'carousel' && (!draft.slides || draft.slides.length < 2)) {
          throw new Error(
            'Carousel draft missing slides[] — re-run agent (media_prompts must return per-slide briefs)'
          )
        }

        if (format === 'carousel' && draft.slides && draft.slides.length > maxSlides) {
          draft.slides = draft.slides.slice(0, maxSlides)
        }

        const fontFamily = draft.font_family || null
        const canvas = JSON.stringify(emptyCanvasDoc(format))
        const seededVars = seedPromptVars(
          {
            ...latest,
            format,
            hook: draft.hook || latest.hook,
            caption: draft.caption || latest.caption,
            hashtags: draft.hashtags || latest.hashtags,
            reel_prompt: draft.reel_prompt || latest.reel_prompt,
            topic: latest.topic,
          },
          brandCtx.visualIdentity
        )
        if (seededVars.format === 'feed' && fontFamily) seededVars.font = fontFamily
        if (seededVars.format === 'carousel' && fontFamily) seededVars.font = fontFamily
        if (seededVars.format === 'reel' && fontFamily) seededVars.font = fontFamily
        const hookOnImage =
          draft.hook_on_image ||
          shortOnImageText(draft.hook || latest.hook || '', 90, 12)

        if (seededVars.format === 'carousel' && draft.slides?.length) {
          const n = draft.slides.length
          seededVars.slide_count = n
          seededVars.slides = draft.slides.map((s, i) => {
            const roleFromDraft = s.role
            const role =
              roleFromDraft === 'cover' ||
              roleFromDraft === 'why' ||
              roleFromDraft === 'step' ||
              roleFromDraft === 'mistake' ||
              roleFromDraft === 'recap' ||
              roleFromDraft === 'point' ||
              roleFromDraft === 'cta'
                ? roleFromDraft
                : i === 0
                  ? 'cover'
                  : i === n - 1
                    ? 'cta'
                    : 'step'
            return {
              on_image_text: shortOnImageText(
                s.text || (i === 0 ? hookOnImage : `Point ${i}`),
                role === 'cover' ? 70 : 110,
                role === 'cover' ? 10 : 12
              ),
              role,
              visual_subject: sceneOnlySubject(
                s.image_prompt || s.stock_search_query || latest.topic || 'scene'
              ),
            }
          })
        }
        if (seededVars.format === 'feed') {
          seededVars.hook_on_image = shortOnImageText(hookOnImage, 90, 12)
          seededVars.subject = sceneOnlySubject(
            draft.image_prompt ||
              latest.topic ||
              draft.stock_search_query ||
              seededVars.subject ||
              'typography-led brand graphic'
          )
          if (brandCtx.visualIdentity?.layout_defaults?.scrim) {
            seededVars.scrim = brandCtx.visualIdentity.layout_defaults.scrim
          }
        }
        if (seededVars.format === 'reel') {
          const dur = clampReelDuration(draft.duration_sec)
          seededVars.duration = dur
          if (draft.reel_prompt?.trim()) {
            seededVars.motion_brief = sceneOnlySubject(draft.reel_prompt.trim())
          }
          const beats = [...(draft.beats || [])]
            .map((b) => ({ ...b, t_start: Math.max(0, Number(b.t_start) || 0) }))
            .filter((b) => b.t_start < dur)
            .sort((a, b) => a.t_start - b.t_start)
          if (beats.length) {
            const textBeats = beats.filter((b) => (b.on_screen_text_intent || '').trim())
            if (textBeats.length && textBeats[0].t_start > 1.5) textBeats[0] = { ...textBeats[0], t_start: 0 }
            seededVars.timed_cues = textBeats.map((b, i) => {
              const isFirst = i === 0
              const isLast = i === textBeats.length - 1
              return {
                text: shortOnImageText(
                  b.on_screen_text_intent || (isFirst ? hookOnImage : ''),
                  80,
                  12
                ),
                startSec: isFirst ? 0 : b.t_start,
                endSec: isLast ? dur : textBeats[i + 1].t_start,
                enterAnim: isLast && !isFirst ? 'slideUp' : 'fade',
                exitAnim: 'fade',
              }
            })
            if (!seededVars.timed_cues.length && hookOnImage) {
              seededVars.timed_cues = [
                { text: shortOnImageText(hookOnImage, 80, 12), startSec: 0, endSec: dur, enterAnim: 'fade', exitAnim: 'fade' },
              ]
            }
            seededVars.beat_visuals = beats
              .filter((b) => (b.visual_change || '').trim())
              .map((b) => ({ t: b.t_start, visual: b.visual_change }))
          } else {
            const cues = seededVars.timed_cues || []
            if (cues[0]) cues[0].text = shortOnImageText(hookOnImage || cues[0].text || '', 80, 12)
            if (cues.length) cues[cues.length - 1].endSec = dur
          }
        }
        const altText = normalizeAltText(draft.alt_text) || null
        applyAgentDraftPatch(
          post_id,
          'pending_approval',
          {
            hook: draft.hook || latest.hook,
            hook_alternates: hookAlternates,
            caption: draft.caption || latest.caption,
            hashtags: draft.hashtags || latest.hashtags,
            format,
            image_prompt: draft.image_prompt || latest.image_prompt,
            stock_search_query: draft.stock_search_query || null,
            reel_prompt: draft.reel_prompt || latest.reel_prompt,
            media_type: format === 'reel' ? 'reel' : format === 'carousel' ? 'carousel' : 'image',
            canvas_json: canvas,
            prompt_vars: JSON.stringify(seededVars),
            agent_output: JSON.stringify(draft),
            alt_text: altText,
          },
          { runId: run.id, expectedVersion: versionAtStart },
        )
        if (format === 'carousel') {
          applyCarouselSlidePlan(
            Number(post_id),
            draft.slides!,
            draft.hook || latest.hook,
            maxSlides,
            { fontFamily }
          )
        } else {
          ensureSlidesForFormat(Number(post_id), format, draft.hook || latest.hook, {
            fontFamily,
          })
        }
        applyPlatePromptsFromVars(post_id, seededVars, brandCtx.visualIdentity, {
          angle: latest.angle,
          visualBrief: brandCtx.visualBrief,
        })
        completeRun(run.id, 'succeeded')

      } else {
        // ── Deterministic pipeline path ───────────────────────────────────────
        const latest = getPost(post_id)
        if (!latest) {
          completeRun(run.id, 'failed', 'post missing before pipeline run')
          return
        }

        const pipeCtx = resolveBrandContextV2(latest)
        const idea =
          latest.idea_id != null
            ? (await import('../services/ideas')).tryGetIdea(Number(latest.idea_id))
            : null
        const pResult = await runPipeline(pipeCtx, {
          topic: latest.topic ?? '',
          angle: latest.angle ?? null,
          pillar: latest.pillar ?? null,
          format: (latest.format as PostFormat) ?? null,
          feedback:
            latest.status === 'changes_requested' && latest.revision_comments
              ? [latest.revision_comments]
              : undefined,
          seedHook: idea?.chosen_hook ?? null,
          direction: idea?.direction ?? null,
          onStep: (step, detail) => {
            appendEvent(run.id, 'step', compactPayload({ step, ...detail }))
          },
        })

        // Persist review — log but don't fail the run on write error
        try {
          db.prepare(`
            INSERT INTO post_reviews
              (post_id, post_version, rubric_version, judge_model, scores_json, items_json, passed, overall_score, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(
            Number(latest.id),
            Number((latest as unknown as Record<string, unknown>).version ?? 0),
            pipeCtx.rubric?.version ?? 0,
            'pipeline',
            JSON.stringify(pResult.review.rubricScores),
            JSON.stringify(pResult.review.critiqueItems),
            pResult.review.passed ? 1 : 0,
            pResult.review.overallScore,
          )
        } catch (reviewErr) {
          console.warn('[pipeline] could not persist post_review:', (reviewErr as Error).message)
        }

        // Build media/canvas patch using the same helpers as the loop path
        const pDraft = pResult.draft
        const format = normalizeFormat(pDraft.format)

        if (format === 'carousel' && (!pDraft.slides || pDraft.slides.length < 2)) {
          throw new Error('Carousel draft missing slides — re-run pipeline')
        }
        if (format === 'carousel' && pDraft.slides && pDraft.slides.length > pipeCtx.maxSlides) {
          pDraft.slides = pDraft.slides.slice(0, pipeCtx.maxSlides)
        }

        const canvas = JSON.stringify(emptyCanvasDoc(format))
        const seededVars = seedPromptVars(
          {
            ...latest,
            format,
            hook: pDraft.hook,
            caption: pDraft.caption,
            hashtags: pDraft.hashtags,
            reel_prompt: pDraft.reelPrompt || latest.reel_prompt,
            topic: latest.topic,
          },
          pipeCtx.visualIdentity
        )

        const hookOnImage = pDraft.hookOnImage || shortOnImageText(pDraft.hook, 90, 12)

        if (seededVars.format === 'carousel' && pDraft.slides?.length) {
          const n = pDraft.slides.length
          seededVars.slide_count = n
          seededVars.slides = pDraft.slides.map((s, i) => {
            const roleFromDraft = s.role
            const role =
              roleFromDraft === 'cover' ||
              roleFromDraft === 'why' ||
              roleFromDraft === 'step' ||
              roleFromDraft === 'mistake' ||
              roleFromDraft === 'recap' ||
              roleFromDraft === 'point' ||
              roleFromDraft === 'cta'
                ? roleFromDraft
                : i === 0
                  ? 'cover'
                  : i === n - 1
                    ? 'cta'
                    : 'step'
            return {
              on_image_text: shortOnImageText(
                s.text || (i === 0 ? hookOnImage : `Point ${i}`),
                role === 'cover' ? 70 : 110,
                role === 'cover' ? 10 : 12
              ),
              role,
              visual_subject: sceneOnlySubject(s.image_prompt || latest.topic || 'scene'),
            }
          })
        }
        if (seededVars.format === 'feed') {
          seededVars.hook_on_image = shortOnImageText(hookOnImage, 90, 12)
          seededVars.subject = sceneOnlySubject(
            pDraft.imagePrompt || latest.topic || 'typography-led brand graphic'
          )
          if (pipeCtx.visualIdentity?.layout_defaults?.scrim) {
            seededVars.scrim = pipeCtx.visualIdentity.layout_defaults.scrim
          }
        }
        if (seededVars.format === 'reel') {
          const dur = clampReelDuration(undefined)
          seededVars.duration = dur
          if (pDraft.reelPrompt?.trim()) {
            seededVars.motion_brief = sceneOnlySubject(pDraft.reelPrompt.trim())
          }
          const beats = [...(pDraft.beats || [])]
            .map((b) => ({ ...b, t_start: Math.max(0, Number(b.t_start) || 0) }))
            .filter((b) => b.t_start < dur)
            .sort((a, b) => a.t_start - b.t_start)
          if (beats.length) {
            const textBeats = beats.filter((b) => (b.on_screen_text_intent || '').trim())
            if (textBeats.length && textBeats[0].t_start > 1.5) textBeats[0] = { ...textBeats[0], t_start: 0 }
            seededVars.timed_cues = textBeats.map((b, i) => {
              const isFirst = i === 0
              const isLast = i === textBeats.length - 1
              return {
                text: shortOnImageText(
                  b.on_screen_text_intent || (isFirst ? hookOnImage : ''),
                  80,
                  12
                ),
                startSec: isFirst ? 0 : b.t_start,
                endSec: isLast ? dur : textBeats[i + 1].t_start,
                enterAnim: isLast && !isFirst ? 'slideUp' : 'fade',
                exitAnim: 'fade',
              }
            })
            if (!seededVars.timed_cues.length && hookOnImage) {
              seededVars.timed_cues = [
                { text: shortOnImageText(hookOnImage, 80, 12), startSec: 0, endSec: dur, enterAnim: 'fade', exitAnim: 'fade' },
              ]
            }
          } else {
            const cues = seededVars.timed_cues || []
            if (cues[0]) cues[0].text = shortOnImageText(hookOnImage || cues[0].text || '', 80, 12)
            if (cues.length) cues[cues.length - 1].endSec = dur
          }
        }

        const hookAlternatesJson = pDraft.altHooks.length
          ? JSON.stringify(pDraft.altHooks)
          : latest.hook_alternates

        applyAgentDraftPatch(
          post_id,
          'pending_approval',
          {
            hook: pDraft.hook,
            hook_alternates: hookAlternatesJson,
            caption: pDraft.caption,
            hashtags: pDraft.hashtags,
            format,
            image_prompt: pDraft.imagePrompt || latest.image_prompt,
            stock_search_query: null,
            reel_prompt: pDraft.reelPrompt || latest.reel_prompt,
            media_type: format === 'reel' ? 'reel' : format === 'carousel' ? 'carousel' : 'image',
            canvas_json: canvas,
            prompt_vars: JSON.stringify(seededVars),
            agent_output: JSON.stringify({
              research_mode: pDraft.researchMode,
              research_sources: pDraft.researchSources,
              hook_alternates: pDraft.altHooks,
              slides: pDraft.slides ?? [],
              trace: pResult.trace,
            }),
            alt_text: normalizeAltText(pDraft.altText) || null,
          },
          { runId: run.id, expectedVersion: versionAtStart },
        )

        if (format === 'carousel') {
          applyCarouselSlidePlan(
            Number(post_id),
            pDraft.slides!,
            pDraft.hook,
            pipeCtx.maxSlides,
            { fontFamily: null }
          )
        } else {
          ensureSlidesForFormat(Number(post_id), format, pDraft.hook, { fontFamily: null })
        }
        applyPlatePromptsFromVars(post_id, seededVars, pipeCtx.visualIdentity, {
          angle: latest.angle,
          visualBrief: pipeCtx.visualText,
        })
        completeRun(run.id, 'succeeded')
      }

    } catch (e) {
      const err = e as Error
      console.error('[content-agent] agent-run failed:', err.message)
      completeRun(run.id, 'failed', err.message || String(e))
    }
  })()

  return {
    post,
    run_id: run.id,
    note: 'Agent loop started — subscribe to GET /api/runs/:id/events or MCP get_run',
    done,
  }
}

/** Apply agent draft patch; on version conflict store a proposed version instead of overwriting. */
export function applyAgentDraftPatch(
  postId: string | number,
  nextStatus: 'pending_approval',
  patch: Record<string, string | number | null>,
  opts: { runId: number; expectedVersion?: number },
): void {
  const latest = getPost(postId)
  if (!latest) throw new ApiError(404, 'post not found')
  const currentVersion = Number((latest as Post & { version?: number }).version ?? 1)
  if (
    opts.expectedVersion != null &&
    Number.isFinite(opts.expectedVersion) &&
    opts.expectedVersion !== currentVersion
  ) {
    storeProposedVersion({
      postId,
      baseVersion: currentVersion,
      snapshot: { ...snapshotFromPost(latest), ...patch, status: nextStatus },
      runId: opts.runId,
      actor: historyActorFrom({ id: 'agent:pipeline', name: 'content-pipeline', role: 'agent' }),
    })
    return
  }
  // transitionPost snapshots pending_approval; pass actor for attribution.
  transitionPost(postId, nextStatus, {
    patch,
    actor: { id: 'agent:pipeline', name: 'content-pipeline' },
  })
}
