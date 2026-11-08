/**
 * Model capability and pricing table.
 * All prices are per-million tokens (USD).
 * Models are keyed by their Runware / vendor identifier.
 */

export type ModelCapability = {
  /** Human-readable label */
  label: string
  /** Provider this model is accessed through */
  provider: 'runware' | 'openai' | 'anthropic' | 'local'
  /** Runware pass-through endpoint to use */
  endpoint: 'chat' | 'responses' | 'messages'
  /** Whether the model supports native tool/function calling */
  tools: boolean
  /** Whether the model supports JSON schema output natively */
  jsonSchema: boolean
  /** Whether to omit temperature (reasoning models) */
  lockedTemperature: boolean
  /** Per-million input token price in USD */
  priceInPer1M: number
  /** Per-million output token price in USD */
  priceOutPer1M: number
  /** Max output tokens this model supports */
  maxOutput: number
}

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // ── Claude via Runware Messages pass-through ──────────────────────────────
  'claude-sonnet-5-5': {
    label: 'Claude Sonnet 5.5',
    provider: 'runware',
    endpoint: 'messages',
    tools: true,
    jsonSchema: false,
    lockedTemperature: false,
    priceInPer1M: 2,
    priceOutPer1M: 10,
    maxOutput: 8192,
  },
  'claude-opus-5-5': {
    label: 'Claude Opus 5.5',
    provider: 'runware',
    endpoint: 'messages',
    tools: true,
    jsonSchema: false,
    lockedTemperature: false,
    priceInPer1M: 8,
    priceOutPer1M: 40,
    maxOutput: 8192,
  },
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    provider: 'runware',
    endpoint: 'messages',
    tools: true,
    jsonSchema: false,
    lockedTemperature: false,
    priceInPer1M: 0.5,
    priceOutPer1M: 2.5,
    maxOutput: 8192,
  },
  // ── GPT via Runware Responses pass-through ────────────────────────────────
  'gpt-6-luna': {
    label: 'GPT-6 Luna',
    provider: 'runware',
    endpoint: 'responses',
    tools: true,
    jsonSchema: true,
    lockedTemperature: true,
    priceInPer1M: 3,
    priceOutPer1M: 15,
    maxOutput: 4096,
  },
  'gpt-4o-mini': {
    label: 'GPT-4o Mini',
    provider: 'runware',
    endpoint: 'responses',
    tools: true,
    jsonSchema: true,
    lockedTemperature: false,
    priceInPer1M: 0.15,
    priceOutPer1M: 0.6,
    maxOutput: 4096,
  },
  // ── Gemini via Runware Chat Completions ───────────────────────────────────
  'gemini-3.8-flash': {
    label: 'Gemini 3.8 Flash',
    provider: 'runware',
    endpoint: 'chat',
    tools: true,
    jsonSchema: false,
    lockedTemperature: false,
    priceInPer1M: 0.75,
    priceOutPer1M: 3.75,
    maxOutput: 4096,
  },
  // ── GLM via Runware Chat Completions ──────────────────────────────────────
  'glm-5.3-flash': {
    label: 'GLM-5.3 Flash',
    provider: 'runware',
    endpoint: 'chat',
    tools: true,
    jsonSchema: false,
    lockedTemperature: false,
    priceInPer1M: 0.15,
    priceOutPer1M: 0.5,
    maxOutput: 4096,
  },
  // ── Local (LM Studio / Ollama) ────────────────────────────────────────────
  local: {
    label: 'Local model',
    provider: 'local',
    endpoint: 'chat',
    tools: false,
    jsonSchema: false,
    lockedTemperature: false,
    priceInPer1M: 0,
    priceOutPer1M: 0,
    maxOutput: 4096,
  },
}

/** Compute cost in USD from token usage and model. Returns 0 for unknown models. */
export function computeCostUsd(
  modelId: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const cap = MODEL_CAPABILITIES[modelId]
  if (!cap) return 0
  return (tokensIn / 1_000_000) * cap.priceInPer1M + (tokensOut / 1_000_000) * cap.priceOutPer1M
}
