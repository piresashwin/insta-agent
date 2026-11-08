// Chains skills into one "post production" run (research → plan → media → caption → lint → review).
import { planContent } from './content-planning'
import { writeCaption } from './caption-writing'
import { generateMediaPrompts } from './image-reel-generation'
import { reviewPost } from './post-review'
import { researchBriefToPromptBlock, researchTopic } from './topic-research'
import { lintDraft } from '../agent/lint'

type PipelineArgs = {
  topic?: string
  angle?: string
  pillar?: string
  brandGuide?: string
  brandConfig?: string
  brandVoice?: string
  audience?: string
  /** Lesson 10 — optional step notifications for live monitoring. */
  onStep?: (step: string, detail?: Record<string, unknown>) => void | Promise<void>
}

async function runContentPipeline({
  topic,
  angle,
  pillar,
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

  let researchBrief: string | undefined
  let research: Awaited<ReturnType<typeof researchTopic>> | undefined
  if (topic?.trim() && process.env.AGENT_SKIP_RESEARCH !== '1') {
    await notify('research', { status: 'running' })
    try {
      research = await researchTopic({
        topic,
        angle,
        pillar,
        brandGuide,
      })
      researchBrief = researchBriefToPromptBlock(research)
      await notify('research', {
        status: 'done',
        mode: research.mode,
        angles: research.angles?.length,
      })
    } catch (err) {
      await notify('research', {
        status: 'failed',
        error: (err as Error).message,
      })
    }
  }

  await notify('plan', { status: 'running' })
  const plan = await planContent({
    topic,
    audience,
    angle,
    brandGuide,
    brandConfig,
    researchBrief,
  })
  await notify('plan', {
    status: 'done',
    hook: plan.hook,
    hook_on_image: plan.hook_on_image,
    format: plan.format,
    job: plan.job,
  })

  // Media before caption so the caption can match the slides / beats.
  await notify('media', { status: 'running' })
  const media = await generateMediaPrompts({
    hook: plan.hook,
    hookOnImage: plan.hook_on_image,
    angle: plan.angle,
    format: plan.format,
  })
  await notify('media', { status: 'done', media_type: media.media_type })

  await notify('caption', { status: 'running' })
  const captionResult = await writeCaption({
    hook: plan.hook,
    hookOnImage: plan.hook_on_image,
    angle: plan.angle,
    format: plan.format,
    brandVoice,
    targetAudience: plan.audience,
    job: plan.job,
    audienceProblem: plan.audience_problem,
    hashtagTheme: plan.hashtag_theme,
    slides: media.slides,
    beats: media.beats,
  })
  await notify('caption', { status: 'done' })

  const isCarousel = Array.isArray(media.slides) && media.slides.length >= 2
  const lint = lintDraft({
    format: isCarousel ? 'carousel' : plan.format,
    hook_on_image: plan.hook_on_image,
    caption: captionResult.caption,
    hashtags: captionResult.hashtags,
    first_line: captionResult.first_line,
    cta: captionResult.cta,
    slides: media.slides,
    beats: media.beats,
    duration_sec: media.duration_sec,
  })

  await notify('review', { status: 'running' })
  const review = await reviewPost({
    hook: plan.hook,
    hookOnImage: plan.hook_on_image,
    caption: captionResult.caption,
    hashtags: captionResult.hashtags,
    format: plan.format,
    imagePrompt: media.image_prompt,
    reelPrompt: media.reel_prompt,
    brandVoice,
    job: plan.job,
    audienceProblem: plan.audience_problem,
    slides: media.slides,
    beats: media.beats,
    durationSec: media.duration_sec,
    cta: captionResult.cta,
    firstLine: captionResult.first_line,
    lintFailures: lint,
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
    hook_on_image: plan.hook_on_image,
    hook_alternates: plan.alt_hooks,
    caption: captionResult.caption,
    hashtags: captionResult.hashtags,
    image_prompt: media.image_prompt,
    stock_search_query: media.stock_search_query,
    reel_prompt: media.reel_prompt,
    tone: plan.tone,
    format: plan.format,
    plan,
    research,
    first_line: captionResult.first_line,
    cta: captionResult.cta,
    media_type: media.media_type,
    fallback_prompt: media.fallback_prompt,
    font_family: media.font_family,
    beats: media.beats,
    duration_sec: media.duration_sec,
    alt_text: captionResult.alt_text,
    lint,
    slides: media.slides,
    review,
  }
}

export type PipelineResult = Awaited<ReturnType<typeof runContentPipeline>>

export { runContentPipeline }
