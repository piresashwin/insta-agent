// Tool registry for the Chapter 03 agent loop.
// Skill = implementation; tool = named surface the loop can call.
import { planContent } from '../skills/content-planning'
import { writeCaption } from '../skills/caption-writing'
import { generateMediaPrompts } from '../skills/image-reel-generation'
import { reviewPost } from '../skills/post-review'
import { researchTopic } from '../skills/topic-research'
import { FinishDraftSchema } from './schemas'

const TOOL_DESCRIPTIONS = {
  topic_research:
    'Research the topic (web when TAVILY_API_KEY/SERPER_API_KEY set, else model knowledge). args: { topic: string, angle?, pillar? }. Returns summary, key_facts, angles, sources. Usually run once before content_planning.',
  content_planning:
    'Produce an Instagram content concept from a topic (+ research when available). args: { topic: string }. Returns job, audience, audience_problem, hook, hook_on_image (≤12 words), angle, format, tone, hashtag_theme, alt_hooks[3].',
  media_prompts:
    'Run right after content_planning. Produce SCENE-ONLY image_prompt + stock_search_query + font_family. Do NOT embed exact lettering/placement in image_prompt — the plate compiler adds on-image text from hook_on_image / slides[].text. For carousel return slides[] with roles. For reel return beats[] + duration_sec (6–15). args: { hook, hookOnImage?, angle?, format?, backgroundStyle?, maxSlides? } (plan fields are injected).',
  caption_writing:
    'Run after media_prompts. Write caption + 3–5 hashtags + CTA + alt_text matching the slides/beats. args: { hook: string, angle?, format? } (plan + media fields are injected).',
  post_review:
    'Score draft against Instagram checklist + 10-second gate (required before finish). Deterministic rule checks are injected automatically. args: {} (draft fields are injected).',
  finish:
    'End the run when plan + caption + media_prompts + post_review are done. Prefer args: {} — the orchestrator assembles the draft from prior observations. Optional args.draft overrides/merges fields.',
} as const

type ToolArgs = Record<string, unknown>

function str(args: ToolArgs, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

function strList(args: ToolArgs, key: string): string[] | undefined {
  const v = args[key]
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  return out.length ? out : undefined
}

function arr<T>(args: ToolArgs, key: string): T[] | undefined {
  const v = args[key]
  return Array.isArray(v) ? (v as T[]) : undefined
}

function num(args: ToolArgs, key: string): number | undefined {
  const v = Number(args[key])
  return args[key] != null && Number.isFinite(v) ? v : undefined
}

async function runTopicResearch(args: ToolArgs = {}) {
  const topic = args.topic
  if (!topic || typeof topic !== 'string') {
    throw new Error('topic_research requires args.topic (string)')
  }
  return researchTopic({
    topic,
    angle: str(args, 'angle'),
    pillar: str(args, 'pillar'),
    brandGuide: str(args, 'brandGuide'),
  })
}

async function runContentPlanning(args: ToolArgs = {}) {
  const topic = args.topic
  if (!topic || typeof topic !== 'string') {
    throw new Error('content_planning requires args.topic (string)')
  }
  return planContent({
    topic,
    audience: str(args, 'audience'),
    angle: str(args, 'angle'),
    brandGuide: str(args, 'brandGuide'),
    brandConfig: str(args, 'brandConfig'),
    researchBrief: str(args, 'researchBrief'),
    preferredFormat: str(args, 'preferredFormat') || str(args, 'format'),
    feedback: strList(args, 'feedback'),
  })
}

async function runCaptionWriting(args: ToolArgs = {}) {
  const hook = str(args, 'hook')
  if (!hook) throw new Error('caption_writing requires args.hook (string)')
  return writeCaption({
    hook,
    angle: str(args, 'angle'),
    format: str(args, 'format'),
    brandVoice: str(args, 'brandVoice'),
    targetAudience: str(args, 'targetAudience'),
    job: str(args, 'job'),
    audienceProblem: str(args, 'audienceProblem') || str(args, 'audience_problem'),
    hookOnImage: str(args, 'hookOnImage') || str(args, 'hook_on_image'),
    hashtagTheme: str(args, 'hashtagTheme') || str(args, 'hashtag_theme'),
    slides: arr(args, 'slides'),
    beats: arr(args, 'beats'),
    feedback: strList(args, 'feedback'),
  })
}

async function runMediaPrompts(args: ToolArgs = {}) {
  const hook = str(args, 'hook')
  if (!hook) throw new Error('media_prompts requires args.hook (string)')
  const maxRaw = args.maxSlides ?? args.max_slides
  const maxSlides =
    typeof maxRaw === 'number'
      ? maxRaw
      : typeof maxRaw === 'string'
        ? Number(maxRaw)
        : undefined
  return generateMediaPrompts({
    hook,
    hookOnImage: str(args, 'hookOnImage') || str(args, 'hook_on_image'),
    angle: str(args, 'angle'),
    caption: str(args, 'caption'),
    format: str(args, 'format'),
    backgroundStyle: str(args, 'backgroundStyle') || str(args, 'background_style'),
    brandVisual: str(args, 'brandVisual') || str(args, 'brand_visual'),
    maxSlides: Number.isFinite(maxSlides) ? maxSlides : 5,
    feedback: strList(args, 'feedback'),
  })
}

async function runPostReview(args: ToolArgs = {}) {
  const hook = str(args, 'hook')
  const caption = str(args, 'caption')
  const hashtags = str(args, 'hashtags')
  if (!hook || !caption || !hashtags) {
    throw new Error('post_review requires args.hook, caption, hashtags')
  }
  const slidesRaw = args.slides
  const slides = Array.isArray(slidesRaw)
    ? (slidesRaw as Array<{ text?: string; role?: string; image_prompt?: string }>)
    : undefined
  return reviewPost({
    hook,
    hookOnImage: str(args, 'hookOnImage') || str(args, 'hook_on_image'),
    caption,
    hashtags,
    format: str(args, 'format'),
    imagePrompt: str(args, 'imagePrompt') || str(args, 'image_prompt'),
    reelPrompt: str(args, 'reelPrompt') || str(args, 'reel_prompt'),
    brandVoice: str(args, 'brandVoice'),
    slides,
    job: str(args, 'job'),
    audienceProblem: str(args, 'audienceProblem') || str(args, 'audience_problem'),
    beats: arr(args, 'beats'),
    durationSec: num(args, 'durationSec') ?? num(args, 'duration_sec'),
    cta: str(args, 'cta'),
    firstLine: str(args, 'firstLine') || str(args, 'first_line'),
    lintFailures: strList(args, 'lintFailures'),
  })
}

function runFinish(args: ToolArgs = {}) {
  const draft = args.draft
  if (!draft || typeof draft !== 'object') {
    throw new Error(
      'finish requires args.draft (object), or call with {} so the orchestrator can assemble from history'
    )
  }
  return FinishDraftSchema.parse(draft)
}

const tools = {
  topic_research: runTopicResearch,
  content_planning: runContentPlanning,
  caption_writing: runCaptionWriting,
  media_prompts: runMediaPrompts,
  post_review: runPostReview,
  finish: runFinish,
}

function listToolDescriptions() {
  return Object.entries(TOOL_DESCRIPTIONS)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join('\n')
}

export {
  tools,
  TOOL_DESCRIPTIONS,
  listToolDescriptions,
  runTopicResearch,
  runContentPlanning,
  runCaptionWriting,
  runMediaPrompts,
  runPostReview,
  runFinish,
}
