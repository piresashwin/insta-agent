// Chains the four skills into one "post production" run.
import { planContent } from './content-planning'
import { writeCaption } from './caption-writing'
import { generateMediaPrompts } from './image-reel-generation'
import { reviewPost } from './post-review'

type PipelineArgs = {
  topic?: string
  brandGuide?: string
  brandConfig?: string
  brandVoice?: string
  audience?: string
  /** Lesson 10 — optional step notifications for live monitoring. */
  onStep?: (step: string, detail?: Record<string, unknown>) => void | Promise<void>
}

async function runContentPipeline({
  topic,
  brandGuide,
  brandConfig,
  brandVoice,
  audience,
  onStep,
}: PipelineArgs) {
  const notify = async (step: string, detail?: Record<string, unknown>) => {
    try {
      await onStep?.(step, detail)
    } catch {
      // monitoring must not break the pipeline
    }
  }

  await notify('plan', { status: 'running' })
  const plan = await planContent({ topic, audience, brandGuide, brandConfig })
  await notify('plan', { status: 'done', hook: plan.hook, format: plan.format })

  await notify('caption', { status: 'running' })
  const captionResult = await writeCaption({
    hook: plan.hook,
    angle: plan.angle,
    format: plan.format,
    brandVoice,
    targetAudience: plan.audience,
  })
  await notify('caption', { status: 'done' })

  await notify('media', { status: 'running' })
  const media = await generateMediaPrompts({
    hook: plan.hook,
    angle: plan.angle,
    caption: captionResult.caption,
    format: plan.format,
  })
  await notify('media', { status: 'done', media_type: media.media_type })

  await notify('review', { status: 'running' })
  const review = await reviewPost({
    hook: plan.hook,
    caption: captionResult.caption,
    hashtags: captionResult.hashtags,
    imagePrompt: media.image_prompt,
    reelPrompt: media.reel_prompt,
    brandVoice,
  })
  await notify('review', {
    status: 'done',
    score: (review as { score?: number }).score,
    approved: (review as { approved?: boolean }).approved,
  })

  // Shape matches what server.ts's agent-run handler writes into the `posts` row.
  return {
    topic: topic || '',
    hook: plan.hook,
    hook_alternates: plan.alt_hooks,
    caption: captionResult.caption,
    hashtags: captionResult.hashtags,
    image_prompt: media.image_prompt,
    stock_search_query: media.stock_search_query,
    reel_prompt: media.reel_prompt,
    tone: plan.tone,
    format: plan.format,
    plan,
    first_line: captionResult.first_line,
    cta: captionResult.cta,
    media_type: media.media_type,
    fallback_prompt: media.fallback_prompt,
    review,
  }
}

export type PipelineResult = Awaited<ReturnType<typeof runContentPipeline>>

export { runContentPipeline }
