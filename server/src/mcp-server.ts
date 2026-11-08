#!/usr/bin/env node
/**
 * Stdio MCP harness — orchestrator tools + optional skill wrappers.
 * Same SQLite / policy / runAgent path as the React dashboard (via startAgentRunOnPost).
 */
import { lintDraft } from './agent/lint'
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
import { researchTopic } from './skills/topic-research'
import { startAgentRunOnPost } from './agent/start-run'
import { ApiError, getPost, listPosts } from './orchestrator'
import { getRunWithEvents } from './runs'
import { getBrandProfile, renderBrandBrief, resolveBrandContext } from './brand'
import { MCP_OPERATOR } from './policy'
import { registerOperatorTools } from './mcp-operator-tools'
import { defaultApiClient } from './services/api-client'

const server = new McpServer({ name: 'instagram-agent', version: '1.2.0' })

/** Captured from MCP initialize clientInfo (or MCP_CLIENT_NAME). */
let mcpClientName = process.env.MCP_CLIENT_NAME || 'mcp-client'

function asToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function asToolError(err: unknown) {
  const message =
    err instanceof ApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err)
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true as const,
  }
}

// MCP SDK ships its own Zod types; keep runtime schemas and loosen registerTool generics.
const register = server.registerTool.bind(server) as (
  name: string,
  config: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<unknown>
) => void

// ---------- Orchestrator tools (dashboard-visible truth) ----------

register(
  'list_posts',
  {
    title: 'List posts',
    description:
      'List Instagram draft posts from the shared SQLite DB (same as the React dashboard). Optional status filter. Returns id, topic, status, format, updated_at.',
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe('Optional status filter, e.g. draft, pending_approval, changes_requested'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50)'),
    },
  },
  async (args) => {
    try {
      const posts = listPosts({
        status: typeof args.status === 'string' ? args.status : null,
        limit: typeof args.limit === 'number' ? args.limit : 50,
      })
      return asToolResult(
        posts.map((p) => ({
          id: p.id,
          topic: p.topic,
          status: p.status,
          format: p.format,
          hook: p.hook,
          brand_profile_id: p.brand_profile_id,
          updated_at: p.updated_at,
        }))
      )
    } catch (e) {
      return asToolError(e)
    }
  }
)

register(
  'get_run',
  {
    title: 'Get agent run',
    description:
      'Load a durable agent run by run_id plus a summary of recent events. Poll this (or watch React Activity / SSE) after start_run_on_post.',
    inputSchema: {
      run_id: z.number().int().describe('Run id returned by start_run_on_post'),
      event_limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max recent events to include (default 40)'),
    },
  },
  async (args) => {
    try {
      const runId = Number(args.run_id)
      const timeline = getRunWithEvents(runId)
      if (!timeline) {
        return asToolError(new ApiError(404, `run ${runId} not found`))
      }
      const lim = typeof args.event_limit === 'number' ? args.event_limit : 40
      const events = timeline.events.slice(-lim).map((e) => ({
        seq: e.seq,
        type: e.type,
        created_at: e.created_at,
        payload: e.payload,
      }))
      return asToolResult({
        run: timeline.run,
        events,
        event_count: timeline.events.length,
        note: 'Same run_id as React Activity / GET /api/runs/:id/events',
      })
    } catch (e) {
      return asToolError(e)
    }
  }
)

register(
  'start_run_on_post',
  {
    title: 'Start agent run on post',
    description:
      'Operator loop (optional after fill_week commit): start the same agent-run as the React dashboard. Returns { run_id } — poll get_run until pending_approval, then STOP — approve/publish only in React. Prefer over run_content_pipeline for dashboard-visible runs. Does not publish.',
    inputSchema: {
      post_id: z.union([z.number().int(), z.string()]).describe('Post id (draft or changes_requested)'),
    },
  },
  async (args) => {
    try {
      const postId = args.post_id as string | number
      const clientName = mcpClientName

      // Prefer Express job worker via HTTP so MCP never writes SQLite concurrently.
      if (process.env.MCP_EMBEDDED_WORKER !== '1') {
        try {
          const api = defaultApiClient()
          const res = await api.startAgentRun(postId, {
            actor: { id: MCP_OPERATOR.id, name: MCP_OPERATOR.name, client: clientName },
          })
          if (res.ok) {
            return asToolResult({
              run_id: res.data.run_id,
              job_id: res.data.job_id,
              post_id: res.data.post?.id ?? postId,
              status: 'queued',
              post_status: res.data.post?.status,
              note: res.data.note || 'Enqueued via ApiClient',
              actor: { kind: 'mcp', name: MCP_OPERATOR.name, client: clientName },
            })
          }
          // Fall through to embedded if server is down / returned error.
          if (res.status !== 0 && res.status < 500) {
            return asToolError(new ApiError(res.status, res.data.error || 'agent-run failed'))
          }
        } catch {
          /* Express unreachable — embedded fallback below */
        }
      }

      const result = startAgentRunOnPost(postId, {
        initiator: { ...MCP_OPERATOR },
        inline: process.env.MCP_EMBEDDED_WORKER === '1',
      })
      return asToolResult({
        run_id: result.run_id,
        job_id: result.job_id,
        post_id: result.post.id,
        status: result.job_id ? 'queued' : 'running',
        post_status: result.post.status,
        note: result.note,
        actor: { kind: 'mcp', name: MCP_OPERATOR.name, client: clientName },
      })
    } catch (e) {
      return asToolError(e)
    }
  }
)

register(
  'get_brand_context',
  {
    title: 'Get brand context',
    description:
      'Resolve brand brief fields for a brand_profile_id and/or post (no secrets). Useful before drafting.',
    inputSchema: {
      brand_profile_id: z.union([z.number().int(), z.string()]).optional(),
      post_id: z.union([z.number().int(), z.string()]).optional(),
    },
  },
  async (args) => {
    try {
      if (args.post_id != null) {
        const post = getPost(args.post_id as string | number)
        if (!post) return asToolError(new ApiError(404, 'post not found'))
        const ctx = resolveBrandContext(post)
        return asToolResult({
          brand_profile_id: ctx.profile?.id ?? post.brand_profile_id ?? null,
          name: ctx.profile?.name ?? null,
          niche: ctx.profile?.niche ?? null,
          audience: ctx.profile?.audience ?? null,
          default_format: ctx.profile?.default_format ?? ctx.format,
          background_style: ctx.backgroundStyle,
          max_slides: ctx.maxSlides,
          brief_md: ctx.briefMd,
          voice_brief: ctx.voiceBrief || null,
          visual_brief: ctx.visualBrief || null,
          post_id: post.id,
        })
      }

      if (args.brand_profile_id != null) {
        const profile = getBrandProfile(args.brand_profile_id as string | number)
        if (!profile) return asToolError(new ApiError(404, 'brand profile not found'))
        return asToolResult({
          brand_profile_id: profile.id,
          name: profile.name,
          niche: profile.niche,
          audience: profile.audience,
          default_format: profile.default_format,
          background_style: profile.default_background_style ?? null,
          max_slides: profile.default_max_slides ?? null,
          brief_md: renderBrandBrief(profile),
          voice_brief: profile.voice || null,
          visual_brief: profile.visual || null,
        })
      }

      return asToolError(new ApiError(400, 'Provide brand_profile_id and/or post_id'))
    } catch (e) {
      return asToolError(e)
    }
  }
)

register(
  'topic_research',
  {
    title: 'Topic research',
    description:
      'Research a topic for Instagram planning (web search when TAVILY/SERPER configured, else model). Also useful before generate_brand_draft — paste findings into feedback. Does not persist a brand.',
    inputSchema: {
      topic: z.string(),
      angle: z.string().optional(),
      pillar: z.string().optional(),
      brandGuide: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asToolResult(
        await researchTopic({
          topic: String(args.topic || ''),
          angle: typeof args.angle === 'string' ? args.angle : undefined,
          pillar: typeof args.pillar === 'string' ? args.pillar : undefined,
          brandGuide: typeof args.brandGuide === 'string' ? args.brandGuide : undefined,
        })
      )
    } catch (e) {
      return asToolError(e)
    }
  }
)

// ---------- Operator tools (brand + calendar; HITL stop before approve) ----------
registerOperatorTools(register, asToolResult, asToolError)

// ---------- Skill tools (optional low-level) ----------

register(
  'content_planning',
  {
    title: 'Content planning',
    description:
      'Turn a seed topic into a full concept: audience, hook, angle, format, tone, hashtag theme, alt hooks. Low-level skill — prefer start_run_on_post for durable dashboard runs.',
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
      'Write the caption, CTA, 3–5 hashtags, alt text, and scroll-stopping first line for a given hook/angle/format.',
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
    description:
      'Produce free-stock-media search prompts (image + reel) for a post concept. Agent-loop equivalent tool is media_prompts.',
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
  async (args) => {
    const a = args as {
      hook: string
      caption: string
      hashtags: string
      imagePrompt?: string
      reelPrompt?: string
      brandVoice?: string
    }
    // Deterministic Instagram rule checks (hashtag cap, length, bait) feed the review.
    const lintFailures = lintDraft({ hook_on_image: a.hook, caption: a.caption, hashtags: a.hashtags })
    return asToolResult(await reviewPost({ ...a, lintFailures }))
  }
)

register(
  'run_content_pipeline',
  {
    title: 'Run full content pipeline',
    description:
      'Soft-deprecated for harness use: runs skills in-memory only (plan → media → caption → review) with no durable run_id. Prefer start_run_on_post for dashboard-visible runs.',
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
  // Best-effort: MCP SDK exposes clientInfo after initialize.
  try {
    const anyServer = server as unknown as {
      server?: { getClientVersion?: () => { name?: string; version?: string } }
      _clientInfo?: { name?: string }
    }
    const info =
      anyServer.server?.getClientVersion?.() ||
      anyServer._clientInfo ||
      null
    if (info?.name) mcpClientName = info.name
  } catch {
    /* keep env / default */
  }
}

main().catch((err) => {
  console.error('[instagram-agent MCP] fatal error:', err)
  process.exit(1)
})
