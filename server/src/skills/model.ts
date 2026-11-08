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

/** Escape raw newlines/tabs inside JSON string literals (common LLM mistake). */
function escapeControlsInJsonStrings(raw: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) {
      out += ch
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      out += ch
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out += ch
      continue
    }
    if (inString) {
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
    }
    out += ch
  }
  return out
}

function repairJsonText(raw: string): string {
  let s = raw
  // Normalize smart quotes that break JSON property names / values
  s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2018\u2019]/g, "'")
  // Strip JS-style trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1')
  // Escape bare control chars inside strings; strip others outside
  s = escapeControlsInJsonStrings(s)
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
  return s
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
  const slice = candidate.slice(start, end + 1)
  const attempts = [slice, repairJsonText(slice), repairJsonText(escapeControlsInJsonStrings(slice))]
  let lastErr: unknown
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`JSON parse failed near: ${slice.slice(Math.max(0, 700), 850)}`)
}

type ZodDefish = ZodTypeAny & {
  description?: string
  shape?: Record<string, ZodTypeAny>
  _def?: {
    typeName?: string
    innerType?: ZodTypeAny
    schema?: ZodTypeAny
    values?: string[]
    exactLength?: { value?: number }
    minLength?: { value?: number }
    maxLength?: { value?: number }
    type?: ZodTypeAny
  }
}

function unwrapZod(schema: ZodTypeAny): ZodDefish {
  let cur = schema as ZodDefish
  for (let i = 0; i < 8; i++) {
    const t = cur._def?.typeName
    if (t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault') {
      cur = (cur._def?.innerType ?? cur) as ZodDefish
      continue
    }
    if (t === 'ZodEffects') {
      cur = (cur._def?.schema ?? cur) as ZodDefish
      continue
    }
    break
  }
  return cur
}

/** Compact field hints for local models (avoid dumping huge JSON Schema blobs). */
export function compactZodHint(schema: ZodTypeAny, name = 'object', indent = 0): string {
  const pad = '  '.repeat(indent)
  const innerPad = '  '.repeat(indent + 1)
  const root = unwrapZod(schema)

  if (root._def?.typeName !== 'ZodObject' && !(root instanceof z.ZodObject)) {
    return `JSON object named "${name}"`
  }

  const shape = (root.shape ?? (root as z.ZodObject<z.ZodRawShape>).shape) as Record<
    string,
    ZodTypeAny
  >

  const lines = Object.entries(shape).map(([key, field]) => {
    const zodField = field as ZodDefish
    const desc = zodField.description ? ` — ${zodField.description}` : ''
    const unwrapped = unwrapZod(zodField)
    const t = unwrapped._def?.typeName
    let type = 'any'

    if (t === 'ZodString') type = 'string'
    else if (t === 'ZodNumber') type = 'number'
    else if (t === 'ZodBoolean') type = 'boolean'
    else if (t === 'ZodEnum') type = `enum(${(unwrapped._def?.values || []).join('|')})`
    else if (t === 'ZodObject') {
      // Nested object: expand one level so array-of-object schemas (idea_batch) get real keys.
      type = compactZodHint(unwrapped, key, indent + 1)
    } else if (t === 'ZodArray') {
      const exact = unwrapped._def?.exactLength?.value
      const min = unwrapped._def?.minLength?.value
      const max = unwrapped._def?.maxLength?.value
      const lenHint =
        exact != null
          ? `[${exact}]`
          : min != null && max != null
            ? `[${min}-${max}]`
            : min != null
              ? `[${min}+]`
              : '[]'
      const el = unwrapZod((unwrapped._def?.type ?? z.any()) as ZodTypeAny)
      if (el._def?.typeName === 'ZodObject') {
        type = `${compactZodHint(el, key, indent + 1)}${lenHint}`
      } else if (el._def?.typeName === 'ZodString') {
        type = `string${lenHint}`
      } else if (el._def?.typeName === 'ZodEnum') {
        type = `enum(${(el._def?.values || []).join('|')})${lenHint}`
      } else {
        type = `item${lenHint}`
      }
    }

    // Nested compactZodHint already includes braces; keep key on same indent.
    if (type.startsWith('{')) {
      return `${innerPad}"${key}": ${type}${desc}`
    }
    return `${innerPad}"${key}": ${type}${desc}`
  })

  return `{\n${lines.join(',\n')}\n${pad}}`
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
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const suffix =
            attempt === 1
              ? ''
              : attempt === 2
                ? `\n\nPrevious reply was invalid (${(lastError as Error).message}). Return ONLY the JSON object.`
                : `\n\nStill invalid (${(lastError as Error).message}). Return minified JSON only: one line, double quotes, no raw newlines inside strings, no trailing commas.`
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
