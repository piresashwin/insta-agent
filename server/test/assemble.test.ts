import { describe, expect, it } from 'vitest'
import {
  assembleDraftFromHistory,
  canAssembleDraft,
  canWriteCaption,
  hasPostReview,
  invalidateDownstream,
  lastOk,
} from '../src/agent/assemble'

const plan = (hook: string) => ({
  ok: true,
  tool: 'content_planning',
  data: {
    job: 'educate',
    audience: 'home baristas',
    audience_problem: 'sour espresso',
    hook,
    hook_on_image: hook,
    angle: 'grind size first',
    format: 'feed',
    tone: 'friendly',
    hashtag_theme: 'home espresso',
    alt_hooks: ['a', 'b', 'c'],
  },
})
const media = (prompt: string) => ({
  ok: true,
  tool: 'media_prompts',
  data: { image_prompt: prompt, stock_search_query: 'espresso grinder', media_type: 'image' },
})
const caption = (text: string) => ({
  ok: true,
  tool: 'caption_writing',
  data: { caption: text, hashtags: '#espresso', first_line: text, cta: 'Save this', alt_text: 'alt' },
})
const reviewObs = () => ({ ok: true, tool: 'post_review', data: { score: 5, approved: false, issues: ['weak hook'] } })

describe('stale invalidation', () => {
  it('re-plan marks media/caption/review stale so they must re-run', () => {
    const history: unknown[] = [plan('old hook'), media('old scene'), caption('old caption'), reviewObs()]
    expect(canAssembleDraft(history, 'feed')).toBe(true)
    expect(hasPostReview(history)).toBe(true)

    history.push(plan('new hook'))
    expect(invalidateDownstream(history, 'content_planning')).toBe(3)

    expect(lastOk(history, 'content_planning')?.hook).toBe('new hook')
    expect(lastOk(history, 'media_prompts')).toBeNull()
    expect(lastOk(history, 'caption_writing')).toBeNull()
    expect(hasPostReview(history)).toBe(false)
    expect(canWriteCaption(history, 'feed')).toBe(false)
    expect(canAssembleDraft(history, 'feed')).toBe(false)
  })

  it('re-brief keeps the plan but invalidates caption + review', () => {
    const history: unknown[] = [plan('hook'), media('scene 1'), caption('cap 1'), reviewObs(), media('scene 2')]
    expect(invalidateDownstream(history, 'media_prompts')).toBe(2)
    expect(lastOk(history, 'content_planning')?.hook).toBe('hook')
    expect(lastOk(history, 'media_prompts')?.image_prompt).toBe('scene 2')
    expect(canWriteCaption(history, 'feed')).toBe(true)
    expect(canAssembleDraft(history, 'feed')).toBe(false)
  })

  it('assembles only fresh observations, with neutral hashtag_theme fallback', () => {
    const p = plan('fresh hook')
    delete (p.data as Record<string, unknown>).hashtag_theme
    const history: unknown[] = [plan('old'), media('old'), caption('old'), p, media('new'), caption('new caption')]
    invalidateDownstream(history.slice(0, 3).concat([p]), 'content_planning')
    const draft = assembleDraftFromHistory(history, { preferredFormat: 'feed', topic: 'espresso' })
    expect(draft.hook).toBe('fresh hook')
    expect(draft.caption).toBe('new caption')
    expect(draft.image_prompt).toBe('new')
    expect(draft.hashtag_theme).toBe('espresso')
    expect(draft.alt_text).toBe('alt')
  })
})
