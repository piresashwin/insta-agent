/**
 * Deterministic checks for the eval harness.
 *
 * Reuses the production rules — lintDraft (server/src/agent/lint.ts) and the IG
 * limits (server/src/instagram-rules.ts) — so evals and the live pipeline judge
 * by the same mechanical standard. The brand-aware checks (banned words, emoji
 * policy, duplicate hooks) read from BrandContextV2 and are additive.
 */
import { lintDraft } from '../src/agent/lint'
import { findBait } from '../src/instagram-rules'
import type { PipelineDraft } from '../src/generation/pipeline'
import type { BrandContextV2 } from '../src/generation/brand-context'
import { trigrams, jaccard } from '../src/generation/similarity'

export interface CheckResult {
  id: string
  passed: boolean
  detail?: string
}

// Covers most common emoji ranges — enough to enforce an emoji policy.
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F000}-\u{1F02F}]/u

function countEmoji(text: string): number {
  const m = text.match(new RegExp(EMOJI_RE, 'gu'))
  return m ? m.length : 0
}

/** All deterministic checks for one draft against one brand context. */
export function runChecks(draft: PipelineDraft, ctx: BrandContextV2): CheckResult[] {
  const results: CheckResult[] = []
  const caption = draft.caption || ''

  // 1. Mechanical IG lint (first line, hashtags, bait, carousel/reel structure).
  const lintFailures = lintDraft({
    format: draft.format,
    hook_on_image: draft.hookOnImage,
    caption: draft.caption,
    hashtags: draft.hashtags,
    first_line: draft.firstLine,
    cta: draft.cta,
    slides: draft.slides,
    beats: draft.beats,
  })
  results.push({
    id: 'ig_lint',
    passed: lintFailures.length === 0,
    detail: lintFailures.length ? lintFailures.join(' | ') : undefined,
  })

  // 2. CTA present (engagement bait is already caught by lint; this is the
  //    inverse — there must be *some* call to action).
  const cta = (draft.cta || '').trim()
  results.push({
    id: 'cta_present',
    passed: cta.length > 0 || /\b(save|share|comment|follow|tap|read|try|start|join|learn)\b/i.test(caption),
    detail: cta.length ? undefined : 'No explicit CTA field or verb in caption',
  })

  // 3. Banned words from the brand voice rules.
  const banned = (ctx.voiceRules.banned_words ?? []).map((w) => w.toLowerCase()).filter(Boolean)
  const hay = `${draft.hook} ${caption} ${draft.hookOnImage}`.toLowerCase()
  const hits = banned.filter((w) => hay.includes(w))
  results.push({
    id: 'banned_words',
    passed: hits.length === 0,
    detail: hits.length ? `Used banned word(s): ${hits.join(', ')}` : undefined,
  })

  // 4. Emoji policy.
  const policy = ctx.voiceRules.emoji_policy
  if (policy) {
    const n = countEmoji(`${draft.hook} ${caption}`)
    const limit = policy === 'none' ? 0 : policy === 'sparing' ? 3 : Infinity
    results.push({
      id: 'emoji_policy',
      passed: n <= limit,
      detail: n > limit ? `${n} emoji exceeds "${policy}" policy (limit ${limit})` : undefined,
    })
  }

  // 5. Duplicate hook — trigram Jaccard > 0.6 against any recent hook.
  const hookGrams = trigrams(draft.hook || '')
  let maxSim = 0
  let nearest = ''
  for (const h of ctx.recentHooks) {
    const sim = jaccard(hookGrams, trigrams(h))
    if (sim > maxSim) {
      maxSim = sim
      nearest = h
    }
  }
  results.push({
    id: 'duplicate_hook',
    passed: maxSim <= 0.6,
    detail: maxSim > 0.6 ? `Hook ${(maxSim * 100).toFixed(0)}% similar to recent: "${nearest}"` : undefined,
  })

  return results
}

/** Case-insensitive search for forbidden terms (used for cross-brand leak detection). */
export function findForbiddenTerms(draft: PipelineDraft, forbidden: string[]): string[] {
  const hay = [
    draft.hook,
    draft.hookOnImage,
    draft.caption,
    draft.hashtags,
    ...(draft.slides?.map((s) => s.text) ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return forbidden.filter((term) => hay.includes(term.toLowerCase()))
}

export { findBait }
