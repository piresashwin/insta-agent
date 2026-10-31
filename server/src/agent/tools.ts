// Tool registry for the Chapter 03 agent loop.
// Skill = implementation; tool = named surface the loop can call.
import { planContent } from '../skills/content-planning'
import { writeCaption } from '../skills/caption-writing'
import { generateMediaPrompts } from '../skills/image-reel-generation'
import { reviewPost } from '../skills/post-review'
import { FinishDraftSchema } from './schemas'

const TOOL_DESCRIPTIONS = {
  content_planning:
    'Produce an Instagram content concept from a topic. args: { topic: string }. Returns hook, angle, format, audience, tone, hashtag_theme, alt_hooks[3].',
  caption_writing:
    'Write caption + hashtags from a plan. args: { hook: string, angle?: string, format?: string, targetAudience?: string }.',
  media_prompts:
    'Produce image_prompt + stock_search_query. For format=carousel also return slides[] (3–5 items with text, image_prompt, stock_search_query each). args: { hook, angle?, caption?, format?, backgroundStyle? }.',
  post_review:
    'Advisory critique only (not human approval). args: { hook, caption, hashtags, imagePrompt?, reelPrompt? }.',
  finish:
    'End the run with the final draft. args: { draft } must include plan fields + caption, hashtags, image_prompt, stock_search_query. For carousel include slides[] from media_prompts. Call when complete.',
} as const

type ToolArgs = Record<string, unknown>

function str(args: ToolArgs, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
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
  })
}

async function runMediaPrompts(args: ToolArgs = {}) {
  const hook = str(args, 'hook')
  if (!hook) throw new Error('media_prompts requires args.hook (string)')
  return generateMediaPrompts({
    hook,
    angle: str(args, 'angle'),
    caption: str(args, 'caption'),
    format: str(args, 'format'),
    backgroundStyle: str(args, 'backgroundStyle') || str(args, 'background_style'),
    brandVisual: str(args, 'brandVisual') || str(args, 'brand_visual'),
  })
}

async function runPostReview(args: ToolArgs = {}) {
  const hook = str(args, 'hook')
  const caption = str(args, 'caption')
  const hashtags = str(args, 'hashtags')
  if (!hook || !caption || !hashtags) {
    throw new Error('post_review requires args.hook, caption, hashtags')
  }
  return reviewPost({
    hook,
    caption,
    hashtags,
    imagePrompt: str(args, 'imagePrompt') || str(args, 'image_prompt'),
    reelPrompt: str(args, 'reelPrompt') || str(args, 'reel_prompt'),
    brandVoice: str(args, 'brandVoice'),
  })
}

function runFinish(args: ToolArgs = {}) {
  const draft = args.draft
  if (!draft || typeof draft !== 'object') {
    throw new Error('finish requires args.draft (object)')
  }
  return FinishDraftSchema.parse(draft)
}

const tools = {
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
  runContentPlanning,
  runCaptionWriting,
  runMediaPrompts,
  runPostReview,
  runFinish,
}
