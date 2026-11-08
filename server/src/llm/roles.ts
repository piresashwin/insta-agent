/**
 * Role → model mapping.
 *
 * Env keys:
 *   LLM_WRITER=anthropic:claude-sonnet-5-5
 *   LLM_JUDGE=gemini:gemini-3.8-flash
 *   LLM_PLANNER=gemini:gemini-3.8-flash
 *   LLM_VISION=anthropic:claude-sonnet-5-5
 *
 * Format: <provider-hint>:<model-id>  (provider-hint is cosmetic; model-id is what matters)
 * Fallback: if the role env is unset, the OPENAI_MODEL / LM Studio path is used.
 *
 * Quick win: set OPENAI_BASE_URL=https://api.runware.ai/v1 and OPENAI_MODEL to any
 * Runware model ID, and the existing model.ts path routes through Runware unchanged.
 */

export type LlmRole = 'writer' | 'judge' | 'planner' | 'vision'

export type ResolvedRole = {
  modelId: string
  /** max output tokens for this role (sized to Instagram's small outputs) */
  maxOutputTokens: number
}

/** Per-role output token caps sized to Instagram content (see Part D of the plan). */
const ROLE_MAX_OUTPUT: Record<LlmRole, number> = {
  writer: 900,   // caption ≤2200 chars ≈ 550 tok; plan 700; allow headroom
  judge: 600,
  planner: 700,
  vision: 400,
}

const DEFAULTS: Record<LlmRole, string> = {
  writer: 'claude-sonnet-5-5',
  judge: 'gemini-3.8-flash',
  planner: 'gemini-3.8-flash',
  vision: 'claude-sonnet-5-5',
}

export function resolveRole(role: LlmRole): ResolvedRole {
  const envKey = `LLM_${role.toUpperCase()}`
  const raw = process.env[envKey]
  let modelId: string

  if (raw) {
    // Strip the optional provider-hint prefix: "anthropic:claude-sonnet-5-5" → "claude-sonnet-5-5"
    modelId = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw
  } else if (process.env.OPENAI_MODEL) {
    // Fall back to the existing OPENAI_MODEL env
    modelId = process.env.OPENAI_MODEL
  } else {
    modelId = DEFAULTS[role]
  }

  return { modelId, maxOutputTokens: ROLE_MAX_OUTPUT[role] }
}

/** True if the base URL for LLM calls points to Runware. */
export function isRunwareBase(baseUrl?: string): boolean {
  const url = baseUrl ?? process.env.OPENAI_BASE_URL ?? ''
  return url.includes('runware.ai')
}
