/**
 * File-based LLM response cache for evals.
 *
 * Keyed on a hash of { model, system, prompt, schemaName } so reruns of the
 * same fixture cost nothing. Enabled by setting EVAL_CACHE_DIR; generateObject
 * (adapter.ts) checks for a cache hit before any network call. A no-op in
 * normal operation — nothing reads or writes unless EVAL_CACHE_DIR is set.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export function cacheDir(): string | null {
  return process.env.EVAL_CACHE_DIR || null
}

export function cacheKey(parts: {
  model: string
  system: string
  prompt: string
  schemaName?: string
}): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 32)
}

export function readCache(key: string): unknown | undefined {
  const dir = cacheDir()
  if (!dir) return undefined
  const file = path.join(dir, `${key}.json`)
  try {
    if (!fs.existsSync(file)) return undefined
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

export function writeCache(key: string, data: unknown): void {
  const dir = cacheDir()
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(data, null, 2))
  } catch {
    // caching is best-effort
  }
}
