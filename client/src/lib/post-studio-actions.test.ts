import { describe, it, expect } from 'vitest'
import type { Post, PostSlide } from '@instagram-agent/shared'
import { resolveNextStep } from './post-studio-actions'

function post(over: Partial<Post> = {}): Post {
  return {
    id: 1,
    account_id: null,
    status: 'draft',
    topic: 't',
    hook: null,
    hook_alternates: null,
    caption: null,
    hashtags: null,
    format: 'feed',
    background_style: null,
    image_prompt: null,
    stock_search_query: null,
    reel_prompt: null,
    image_url: null,
    source_image_url: null,
    reel_url: null,
    reel_quality: null,
    media_type: null,
    media_provider: null,
    canvas_json: null,
    scene_json: null,
    prompt_vars: null,
    angle: null,
    brand_profile_id: 1,
    brand_overrides: null,
    scheduled_at: null,
    pillar: null,
    instagram_media_id: null,
    instagram_creation_id: null,
    instagram_permalink: null,
    instagram_shortcode: null,
    instagram_published_at: null,
    instagram_children_ids: null,
    approved_by: null,
    approved_at: null,
    revisions: 0,
    revision_comments: null,
    agent_output: null,
    error: null,
    created_at: '',
    updated_at: null,
    ...over,
  }
}

describe('resolveNextStep', () => {
  it('maps draft without hook to write_draft', () => {
    const s = resolveNextStep(post({ status: 'draft', hook: null }), [])
    expect(s.primary?.kind).toBe('write_draft')
  })

  it('maps pending_approval to approve_copy + revise/try', () => {
    const s = resolveNextStep(post({ status: 'pending_approval', hook: 'H' }), [])
    expect(s.primary?.kind).toBe('approve_copy')
    expect(s.secondary.map((a) => a.kind)).toEqual(['revise_with_notes', 'try_hooks'])
  })

  it('disables approve_copy for carousel without slides', () => {
    const s = resolveNextStep(post({ status: 'pending_approval', format: 'carousel' }), [])
    expect(s.primary?.disabled).toBe(true)
  })

  it('maps media_ready to approve_visual', () => {
    const slides = [{ id: 1 } as PostSlide]
    const s = resolveNextStep(post({ status: 'media_ready' }), slides)
    expect(s.primary?.kind).toBe('approve_visual')
  })

  it('maps needs_revision to restart only', () => {
    const s = resolveNextStep(post({ status: 'needs_revision' }), [])
    expect(s.primary).toBeNull()
    expect(s.secondary[0]?.kind).toBe('restart_draft')
    expect(s.info).toMatch(/revision/i)
  })
})
