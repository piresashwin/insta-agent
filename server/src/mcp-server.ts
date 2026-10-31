#!/usr/bin/env node
// Exposes the four content skills as MCP tools.
import path from 'path'
import dotenv from 'dotenv'
// __dirname is server/src — the real .env.local lives at the repo root, two levels up.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { planContent } from './skills/content-planning'
import { writeCaption } from './skills/caption-writing'
import { generateMediaPrompts } from './skills/image-reel-generation'
import { reviewPost } from './skills/post-review'
import { runContentPipeline } from './skills/pipeline'

const server = new McpServer({ name: 'instagram-content-skills', version: '1.0.0' })

function asToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

// MCP SDK ships its own Zod types; keep runtime schemas and loosen registerTool generics.
const register = server.registerTool.bind(server) as (
  name: string,
  config: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<unknown>
) => void

register(
  'content_planning',
  {
    title: 'Content planning',
    description:
      'Turn a seed topic into a full concept: audience, hook, angle, format, tone, hashtag theme, alt hooks.',
    inputSchema: {
      topic: z.string(),
      audience: z.string().optional(),
      angle: z.string().optional(),
      brandGuide: z.string().optional(),
      brandConfig: z.string().optional(),
    },
  },
  async (args) =>
    asToolResult(
      await planContent(args as {
        topic: string
        audience?: string
        angle?: string
        brandGuide?: string
        brandConfig?: string
      })
    )
)

register(
  'caption_writing',
  {
    title: 'Caption writing',
    description:
      'Write the caption, CTA, hashtags, and scroll-stopping first line for a given hook/angle/format.',
    inputSchema: {
      hook: z.string(),
      angle: z.string().optional(),
      format: z.enum(['reel', 'feed', 'carousel']).optional(),
      brandVoice: z.string().optional(),
      targetAudience: z.string().optional(),
    },
  },
  async (args) =>
    asToolResult(
      await writeCaption(args as {
        hook: string
        angle?: string
        format?: 'reel' | 'feed' | 'carousel'
        brandVoice?: string
        targetAudience?: string
      })
    )
)

register(
  'image_reel_generation',
  {
    title: 'Image/reel prompt generation',
    description: 'Produce free-stock-media search prompts (image + reel) for a post concept.',
    inputSchema: {
      hook: z.string(),
      angle: z.string().optional(),
      caption: z.string().optional(),
      format: z.enum(['reel', 'feed', 'carousel']).optional(),
    },
  },
  async (args) =>
    asToolResult(
      await generateMediaPrompts(args as {
        hook: string
        angle?: string
        caption?: string
        format?: 'reel' | 'feed' | 'carousel'
      })
    )
)

register(
  'post_review',
  {
    title: 'Post review',
    description:
      'Critique a full post draft (hook/caption/hashtags/media prompts) against brand voice; never silently approves.',
    inputSchema: {
      hook: z.string(),
      caption: z.string(),
      hashtags: z.string(),
      imagePrompt: z.string().optional(),
      reelPrompt: z.string().optional(),
      brandVoice: z.string().optional(),
    },
  },
  async (args) =>
    asToolResult(
      await reviewPost(args as {
        hook: string
        caption: string
        hashtags: string
        imagePrompt?: string
        reelPrompt?: string
        brandVoice?: string
      })
    )
)

register(
  'run_content_pipeline',
  {
    title: 'Run full content pipeline',
    description:
      'Run all four skills in sequence for one topic: plan -> caption -> media prompts -> review. Returns the full post payload.',
    inputSchema: {
      topic: z.string(),
      brandGuide: z.string().optional(),
      brandConfig: z.string().optional(),
      brandVoice: z.string().optional(),
      audience: z.string().optional(),
    },
  },
  async (args) =>
    asToolResult(
      await runContentPipeline(args as {
        topic: string
        brandGuide?: string
        brandConfig?: string
        brandVoice?: string
        audience?: string
      })
    )
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('[instagram-content-skills MCP] fatal error:', err)
  process.exit(1)
})
