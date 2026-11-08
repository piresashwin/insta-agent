/**
 * Optional vision QA — checks that model-baked on-image text matches the expected copy.
 * Enabled only when VISION_QA_MODEL is set (local LM Studio models often lack vision).
 * Advisory: stores posts.media_qa for the operator; never blocks the pipeline.
 *
 * Env: VISION_QA_MODEL (required), VISION_QA_BASE_URL (default OPENAI_BASE_URL),
 *      VISION_QA_API_KEY (default OPENAI_API_KEY).
 */
import type { MediaQa, Post } from '@instagram-agent/shared'
import { getPost, updatePostFields } from '../orchestrator'
import { parsePromptVars, extractBrandHandle } from '../prompts/format-templates'
import { listSlides } from '../slides'
import { readLocalAssetBytes } from './r2'
import { resolveBrandContext } from '../brand'

export function visionQaConfigured(): boolean {
  return !!process.env.VISION_QA_MODEL?.trim()
}

type Target = { label: string; url: string; expected: string[] }

/** Expected on-image lines per image (feed: hook; carousel: each slide; reel cover: first cue). */
function targetsForPost(post: Post): Target[] {
  const vars = parsePromptVars(post.prompt_vars)
  let handle: string | null = null
  try {
    handle = extractBrandHandle(resolveBrandContext(post).visualBrief)
  } catch {
    handle = null
  }
  const withHandle = (lines: string[]) => (handle ? [...lines, handle] : lines)
  if (vars?.format === 'carousel') {
    return listSlides(post.id)
      .filter((s) => s.source_image_url)
      .map((s) => {
        const text = vars.slides[s.position]?.on_image_text || s.text || ''
        const chrome = s.position === 0 || s.position === vars.slides.length - 1
        return {
          label: `slide ${s.position + 1}`,
          url: s.source_image_url!,
          expected: chrome ? withHandle([text].filter(Boolean)) : [text].filter(Boolean),
        }
      })
  }
  if (vars?.format === 'reel') {
    const first = vars.timed_cues?.[0]?.text
    return post.image_url && first ? [{ label: 'reel cover', url: post.image_url, expected: [first] }] : []
  }
  const url = post.source_image_url || post.image_url
  const hook = vars?.format === 'feed' ? vars.hook_on_image : ''
  return url && hook ? [{ label: 'feed', url, expected: withHandle([hook]) }] : []
}

async function imageDataUrl(url: string): Promise<string | null> {
  let bytes = readLocalAssetBytes(url)
  if (!bytes) {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      bytes = Buffer.from(await res.arrayBuffer())
    } catch {
      return null
    }
  }
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  return `data:${isPng ? 'image/png' : 'image/jpeg'};base64,${bytes.toString('base64')}`
}

async function checkOne(t: Target): Promise<{ ok: boolean; seen: string; issues: string[] }> {
  const dataUrl = await imageDataUrl(t.url)
  if (!dataUrl) return { ok: false, seen: '', issues: [`${t.label}: could not load image`] }
  const base = (process.env.VISION_QA_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const key = process.env.VISION_QA_API_KEY || process.env.OPENAI_API_KEY || ''
  const prompt = `Read ALL text painted in this Instagram image exactly as it appears (spelling included).
Expected text lines: ${t.expected.map((e) => `"${e}"`).join(', ')}.
Return ONLY JSON: {"seen":"<all text you can read>","text_ok":<true if every expected line appears with correct spelling and nothing is cut off by the frame edge, and there is no extra invented text>,"issues":["<each misspelling / missing word / clipped or extra text>"]}`
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: process.env.VISION_QA_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`vision QA HTTP ${res.status}`)
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = json.choices?.[0]?.message?.content || ''
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return { ok: false, seen: raw.slice(0, 200), issues: [`${t.label}: unreadable QA response`] }
  const parsed = JSON.parse(m[0]) as { seen?: string; text_ok?: boolean; issues?: string[] }
  return {
    ok: Boolean(parsed.text_ok),
    seen: String(parsed.seen || ''),
    issues: (parsed.issues || []).map((i) => `${t.label}: ${i}`),
  }
}

/** Run QA for a post and persist posts.media_qa. Returns null when disabled / nothing to check. */
export async function runVisionQaForPost(postId: number | string): Promise<MediaQa | null> {
  if (!visionQaConfigured()) return null
  const post = getPost(postId)
  if (!post) return null
  const targets = targetsForPost(post)
  if (!targets.length) return null
  const issues: string[] = []
  const seen: string[] = []
  let ok = true
  for (const t of targets) {
    try {
      const r = await checkOne(t)
      ok = ok && r.ok
      issues.push(...r.issues)
      if (r.seen) seen.push(`${t.label}: ${r.seen}`)
    } catch (err) {
      ok = false
      issues.push(`${t.label}: ${(err as Error).message}`)
    }
  }
  const qa: MediaQa = {
    text_ok: ok,
    issues,
    expected: targets.flatMap((t) => t.expected),
    seen: seen.join(' | ').slice(0, 1000),
    model: process.env.VISION_QA_MODEL,
    checked_at: new Date().toISOString(),
  }
  updatePostFields(postId, { media_qa: JSON.stringify(qa) })
  return qa
}

/** Fire-and-forget wrapper for request handlers. */
export function queueVisionQa(postId: number | string): void {
  if (!visionQaConfigured()) return
  void runVisionQaForPost(postId).catch((err) =>
    console.error('[vision-qa] failed:', err instanceof Error ? err.message : err)
  )
}
