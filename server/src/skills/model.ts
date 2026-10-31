// Shared LangChain model factory for the content skills.
// OpenAI-compatible chat completions (LM Studio, OpenAI, vLLM, …). Skills never
// import a vendor SDK directly — they only call createModel() / createStructuredModel().
import { ChatOpenAI } from '@langchain/openai'
import { z, type ZodTypeAny } from 'zod'

type CreateModelOpts = {
  model?: string
  temperature?: number
  timeout?: number
  maxTokens?: number
}

type StructuredOpts = {
  name?: string
  model?: string
  temperature?: number
}

/** Newer OpenAI chat models reject `max_tokens` — require `max_completion_tokens`. */
function usesMaxCompletionTokens(modelName: string, baseUrl: string): boolean {
  if (/api\.openai\.com/i.test(baseUrl)) return true
  return /\b(gpt-5|gpt-6|o1|o3|o4|luna)\b/i.test(modelName)
}

/**
 * Some OpenAI reasoning / Luna models only allow the default temperature (1).
 * Sending 0.5/0.7 returns 400 — omit the param and let the API use its default.
 */
function locksTemperatureToDefault(modelName: string, baseUrl: string): boolean {
  if (!usesMaxCompletionTokens(modelName, baseUrl)) return false
  return /\b(gpt-5|gpt-6|o1|o3|o4|luna)\b/i.test(modelName)
}

function createModel({ model, temperature = 0.7, timeout = 60_000, maxTokens }: CreateModelOpts = {}) {
  const missing: string[] = []
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY')
  if (!process.env.OPENAI_MODEL && !model) missing.push('OPENAI_MODEL')
  if (missing.length) {
    throw new Error(
      `Missing required env for chat model: ${missing.join(', ')}. ` +
        'Set OPENAI_BASE_URL (default http://127.0.0.1:1234/v1), OPENAI_API_KEY, and OPENAI_MODEL.'
    )
  }

  // Completion budget must cover reasoning_tokens + visible content.
  // Models like bonsai-27b can spend the entire budget on reasoning and return
  // empty content if max_tokens is too low (finish_reason=length).
  // Override with OPENAI_MAX_TOKENS.
  const resolvedMaxTokens = maxTokens ?? Number(process.env.OPENAI_MAX_TOKENS || 4096)
  const modelName = model || process.env.OPENAI_MODEL || ''
  const baseURL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:1234/v1'
  const completionTokens = usesMaxCompletionTokens(modelName, baseURL)
  const lockedTemp = locksTemperatureToDefault(modelName, baseURL)

  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: modelName,
    // Luna / gpt-5+ often only allow default temperature (1).
    temperature: lockedTemp ? 1 : temperature,
    timeout,
    maxRetries: 0,
    // LM Studio / older OpenAI-compatible: max_tokens.
    // OpenAI gpt-5/6/luna/o-series: max_completion_tokens only.
    ...(completionTokens
      ? {
          modelKwargs: { max_completion_tokens: resolvedMaxTokens },
        }
      : { maxTokens: resolvedMaxTokens }),
    configuration: {
      baseURL,
    },
  })
}

function messageText(result: { content?: unknown } | null | undefined): string {
  const content = result?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text || ''))
      .join('')
  }
  return String(content ?? '')
}

function extractJsonObject(
  text: string,
  meta: { reasoningTokens?: unknown; finishReason?: unknown } = {}
) {
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    const reasoning = meta.reasoningTokens
    const finish = meta.finishReason
    const hint =
      reasoning || finish === 'length'
        ? ' Reasoning models often fill max_tokens with reasoning_content and leave content empty — raise OPENAI_MAX_TOKENS (try 4096+).'
        : ''
    throw new Error('Model returned empty content; cannot parse structured JSON.' + hint)
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : trimmed).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in model reply: ${candidate.slice(0, 200)}`)
  }
  return JSON.parse(candidate.slice(start, end + 1))
}

/** Compact field hints for local models (avoid dumping huge JSON Schema blobs). */
function compactZodHint(schema: ZodTypeAny, name = 'object'): string {
  if (!(schema instanceof z.ZodObject)) {
    return `JSON object named "${name}"`
  }
  const lines = Object.entries(schema.shape).map(([key, field]) => {
    const zodField = field as ZodTypeAny & {
      description?: string
      _def?: {
        typeName?: string
        innerType?: ZodTypeAny
        values?: string[]
        exactLength?: { value?: number }
        minLength?: { value?: number }
        type?: ZodTypeAny & { _def?: { typeName?: string } }
      }
    }
    const desc = zodField.description ? ` — ${zodField.description}` : ''
    let type = 'any'
    let inner: typeof zodField = zodField
    if (inner._def?.typeName === 'ZodOptional') inner = inner._def.innerType as typeof zodField
    const t = inner._def?.typeName
    if (t === 'ZodString') type = 'string'
    else if (t === 'ZodNumber') type = 'number'
    else if (t === 'ZodBoolean') type = 'boolean'
    else if (t === 'ZodEnum') type = `enum(${(inner._def?.values || []).join('|')})`
    else if (t === 'ZodArray') {
      // Zod stores .length(n) as { value: n }, not a bare number
      const exact = inner._def?.exactLength?.value
      const min = inner._def?.minLength?.value
      const len = exact ?? min
      const elType = inner._def?.type?._def?.typeName === 'ZodString' ? 'string' : 'item'
      type = len != null ? `${elType}[${len}]` : `${elType}[]`
    }
    return `  "${key}": ${type}${desc}`
  })
  return `{\n${lines.join(',\n')}\n}`
}

/**
 * LM Studio–friendly structured output (default):
 * plain chat + compact schema hint + Zod parse (one retry).
 *
 * Why not LangChain defaults on LM Studio?
 * - functionCalling → tool_choice object → 400
 * - jsonMode → response_format json_object → 400
 * - jsonSchema → often empty content on local models
 *
 * STRUCTURED_OUTPUT_METHOD=jsonSchema|jsonMode|functionCalling uses native path.
 */
function createStructuredModel<T extends ZodTypeAny>(schema: T, { name, model, temperature }: StructuredOpts = {}) {
  const method = process.env.STRUCTURED_OUTPUT_METHOD || 'promptJson'
  const schemaName = name || 'structured_output'
  const structuredTimeout = Number(process.env.STRUCTURED_OUTPUT_TIMEOUT_MS || 180_000)

  if (method !== 'promptJson') {
    return createModel({ model, temperature, timeout: structuredTimeout }).withStructuredOutput(
      schema,
      { name: schemaName, method: method as 'jsonSchema' | 'jsonMode' | 'functionCalling' }
    )
  }

  // Structured calls need headroom for reasoning + JSON body
  const structuredMax = Number(
    process.env.STRUCTURED_OUTPUT_MAX_TOKENS || process.env.OPENAI_MAX_TOKENS || 4096
  )
  const llm = createModel({
    model,
    temperature,
    timeout: structuredTimeout,
    maxTokens: structuredMax,
  })
  const hint = compactZodHint(schema, schemaName)

  return {
    async invoke(prompt: string): Promise<z.infer<T>> {
      const fullPrompt = `${prompt}

Return ONLY a valid JSON object (no markdown fences, no commentary) with exactly these fields:
${hint}`

      let lastError: unknown
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const suffix =
            attempt === 1
              ? ''
              : `\n\nPrevious reply was invalid (${(lastError as Error).message}). Return ONLY the JSON object.`
          const result = await llm.invoke(fullPrompt + suffix)
          const raw = messageText(result)
          const parsed = extractJsonObject(raw, {
            finishReason: result?.response_metadata?.finish_reason,
            reasoningTokens:
              result?.response_metadata?.usage?.completion_tokens_details?.reasoning_tokens ??
              result?.usage_metadata?.output_token_details?.reasoning,
          })
          return schema.parse(parsed)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError
    },
  }
}

export { createModel, createStructuredModel }
