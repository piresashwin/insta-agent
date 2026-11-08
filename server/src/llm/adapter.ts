/**
 * LLM adapter — the single entry point for all structured LLM calls.
 *
 * Usage:
 *   const result = await generateObject({
 *     role: 'writer',
 *     schema: MyZodSchema,
 *     system: 'You are a...',
 *     prompt: 'Write a caption for...',
 *     postId: 42,
 *   })
 *
 * Phase 0: routes through the existing createStructuredModel path, adding
 * spend tracking and role-based model selection on top.
 */

import { z, type ZodTypeAny } from 'zod'
import { resolveRole, type LlmRole } from './roles'
import { computeCostUsd } from './capabilities'
import db from '../db'

export type GenerateObjectOpts<T extends ZodTypeAny> = {
  role: LlmRole
  schema: T
  system: string
  prompt: string
  schemaName?: string
  postId?: number
  skill?: string
  promptRef?: string
  maxOutputTokens?: number
  /** Stable brand-context block — tagged for Anthropic prompt caching when used. */
  brandContext?: string
}

/** Last Anthropic-shaped system payload (for tests / future native Messages path). */
export let lastAnthropicSystemBlocks: Array<{
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}> | null = null

export type GenerateObjectResult<T extends ZodTypeAny> = {
  data: z.infer<T>
  usage: { tokensIn: number; tokensOut: number }
  provider: string
  model: string
  costUsd: number
}

export async function generateObject<T extends ZodTypeAny>(
  opts: GenerateObjectOpts<T>,
): Promise<GenerateObjectResult<T>> {
  const { role, schema, system, prompt, schemaName, postId, skill, promptRef } = opts
  const { modelId, maxOutputTokens } = resolveRole(role)
  const resolvedMaxOut = opts.maxOutputTokens ?? maxOutputTokens

  const start = Date.now()

  const brand = opts.brandContext?.trim()
  if (brand) {
    const { anthropicBrandSystemBlocks } = await import('../generation/brand-context')
    lastAnthropicSystemBlocks = [
      ...anthropicBrandSystemBlocks(brand),
      { type: 'text', text: system },
    ]
  } else {
    lastAnthropicSystemBlocks = [{ type: 'text', text: system }]
  }

  // Phase 0: delegate to the existing createStructuredModel path.
  // All existing skills keep working; new code gets role-based routing + spend tracking.
  const { createStructuredModel } = await import('../skills/model')
  const structured = createStructuredModel(schema, {
    name: schemaName ?? role,
    model: modelId,
  })

  // createStructuredModel.invoke takes a string prompt (system + user combined)
  const systemFull = brand ? `${brand}\n\n${system}` : system
  const fullPrompt = systemFull ? `${systemFull}\n\n${prompt}` : prompt

  // Eval response cache (no-op unless EVAL_CACHE_DIR is set) — lets `pnpm eval`
  // rerun fixtures without repeating paid LLM calls.
  let cacheHooks: typeof import('./eval-cache') | null = null
  let cacheKeyStr: string | null = null
  if (process.env.EVAL_CACHE_DIR) {
    try {
      cacheHooks = await import('./eval-cache')
      cacheKeyStr = cacheHooks.cacheKey({
        model: modelId,
        system,
        prompt,
        schemaName: schemaName ?? role,
      })
      const cached = cacheHooks.readCache(cacheKeyStr)
      if (cached !== undefined) {
        return {
          data: cached as z.infer<T>,
          usage: { tokensIn: 0, tokensOut: 0 },
          provider: 'cache',
          model: modelId,
          costUsd: 0,
        }
      }
    } catch {
      cacheHooks = null
    }
  }

  const data = await (structured as { invoke: (p: string) => Promise<z.infer<T>> }).invoke(fullPrompt)

  if (cacheHooks && cacheKeyStr) cacheHooks.writeCache(cacheKeyStr, data)

  // Phase 0: token usage isn't available on the promptJson path
  // (the LangChain wrapper doesn't expose it). We'll compute an estimate from
  // character length until Phase 1 wires up native SDK calls.
  const estimatedIn = Math.ceil((fullPrompt.length + 500) / 4)
  const estimatedOut = Math.ceil(resolvedMaxOut * 0.5)
  const costUsd = computeCostUsd(modelId, estimatedIn, estimatedOut)
  const durationMs = Date.now() - start

  // Log to skill_runs
  if (skill) {
    try {
      db.prepare(
        `INSERT INTO skill_runs (post_id, skill, prompt_ref, model, tokens_in, tokens_out, cost_usd, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(postId ?? null, skill, promptRef ?? null, modelId, estimatedIn, estimatedOut, costUsd, durationMs)
    } catch {
      // non-fatal
    }
  }

  // Record to spend_ledger
  if (costUsd > 0) {
    try {
      db.prepare(
        `INSERT INTO spend_ledger (kind, provider, model, cost_usd, post_id, estimated, budget_scope)
         VALUES ('text', 'runware', ?, ?, ?, 1, 'prod')`,
      ).run(modelId, costUsd, postId ?? null)
    } catch {
      // non-fatal
    }
  }

  const baseUrl = process.env.OPENAI_BASE_URL ?? 'local'
  const provider = baseUrl.includes('runware.ai')
    ? 'runware'
    : baseUrl.includes('openai.com')
      ? 'openai'
      : 'local'

  return {
    data,
    usage: { tokensIn: estimatedIn, tokensOut: estimatedOut },
    provider,
    model: modelId,
    costUsd,
  }
}
