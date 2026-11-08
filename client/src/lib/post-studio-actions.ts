/**
 * Status → primary CTA rules for Post Studio.
 */
import type { Post, PostSlide } from '@instagram-agent/shared'

/** Copy approve gate for carousel: need ≥2 slides and some on-image copy. */
export function carouselApproveBlocked(post: Post, slides: PostSlide[]): boolean {
  if (post.format !== 'carousel') return false
  if (slides.length < 2) return true
  const anyText = slides.some((s) => !!s.text?.trim()) || !!post.hook?.trim()
  return !anyText
}

/** Media approve / stage gate: every slide needs a source or staged URL. */
export function carouselMediaBlocked(post: Post, slides: PostSlide[]): boolean {
  if (post.format !== 'carousel') return false
  if (slides.length < 2) return true
  return slides.some((s) => !s.source_image_url && !s.staged_url)
}

export type StudioPrimaryKind =
  | 'generate_agent'
  | 'regenerate'
  | 'restart'
  | 'approve_copy'
  | 'generate_media'
  | 'runware_final'
  | 'approve_reel'
  | 'publish'
  | 'retry_publish'

export type StudioPrimaryAction = {
  kind: StudioPrimaryKind
  label: string
  variant: 'default' | 'outline' | 'pending'
  disabled: boolean
  title?: string
}

export function resolveStudioPrimary(opts: {
  post: Post
  slides: PostSlide[]
  busy: boolean
}): StudioPrimaryAction | null {
  const { post, slides, busy } = opts
  const format = (post.format || 'feed').toLowerCase()

  if (post.status === 'draft' || post.status === 'changes_requested') {
    const hasHook = !!post.hook?.trim()
    return {
      kind: hasHook ? 'regenerate' : 'generate_agent',
      label: hasHook ? 'Regenerate' : 'Generate',
      variant: 'default',
      disabled: busy,
    }
  }

  if (post.status === 'needs_revision') {
    return {
      kind: 'restart',
      label: 'Restart to draft',
      variant: 'outline',
      disabled: busy,
    }
  }

  if (post.status === 'pending_approval') {
    const blocked = carouselApproveBlocked(post, slides)
    return {
      kind: 'approve_copy',
      label: 'Approve',
      variant: 'pending',
      disabled: busy || blocked,
      title: blocked ? 'Carousel needs ≥2 slides with copy' : undefined,
    }
  }

  if (post.status === 'approved' || post.status === 'media_generating') {
    return {
      kind: 'generate_media',
      label: format === 'carousel' ? 'Generate media (all slides)' : 'Generate media',
      variant: 'default',
      disabled: busy,
    }
  }

  if (post.status === 'media_ready') {
    if (format === 'reel' && post.reel_quality !== 'final') {
      return {
        kind: 'runware_final',
        label: 'Generate final (1080×1920)',
        variant: 'default',
        disabled: busy || !post.reel_url,
        title: !post.reel_url ? 'Generate a draft video first' : undefined,
      }
    }
    if (format === 'reel' && post.reel_url) {
      return {
        kind: 'approve_reel',
        label: 'Approve reel',
        variant: 'default',
        disabled: busy,
      }
    }
    return {
      kind: 'generate_media',
      label: 'Re-generate media',
      variant: 'default',
      disabled: busy || carouselMediaBlocked(post, slides),
      title: carouselMediaBlocked(post, slides)
        ? 'Carousel slides missing source media'
        : undefined,
    }
  }

  if (post.status === 'staged') {
    return {
      kind: 'publish',
      label: 'Publish to Instagram',
      variant: 'default',
      disabled: busy,
    }
  }

  if (post.status === 'failed') {
    return {
      kind: 'retry_publish',
      label: 'Retry publish',
      variant: 'outline',
      disabled: busy || !(post.reel_url || post.image_url),
    }
  }

  return null
}

export function showOverflowMenu(status: string): boolean {
  return status !== 'publishing' && status !== 'published'
}

export function canShowRegenerateInMenu(status: string): boolean {
  return (
    status === 'draft' ||
    status === 'changes_requested' ||
    status === 'pending_approval' ||
    status === 'approved' ||
    status === 'media_ready' ||
    status === 'staged' ||
    status === 'needs_revision' ||
    status === 'failed'
  )
}

export function defaultStudioPerspective(
  status: string
): 'content' | 'media' {
  if (
    status === 'approved' ||
    status === 'media_generating' ||
    status === 'media_ready' ||
    status === 'staged' ||
    status === 'publishing' ||
    status === 'published'
  ) {
    return 'media'
  }
  return 'content'
}

/** Craft-workspace next-step resolver (PostScreen / Plan / Calendar). */
export type NextActionKind =
  | 'write_draft'
  | 'rewrite_draft'
  | 'restart_draft'
  | 'approve_copy'
  | 'revise_with_notes'
  | 'try_hooks'
  | 'generate_visual'
  | 'regenerate_visual'
  | 'open_studio'
  | 'approve_visual'

export type NextAction = {
  kind: NextActionKind
  label: string
  disabled: boolean
  title?: string
}

export type NextStep = {
  stage: 'idea' | 'copy' | 'visuals' | 'ready' | 'live' | 'failed'
  primary: NextAction | null
  secondary: NextAction[]
  info?: string
}

export function resolveNextStep(post: Post, slides: PostSlide[]): NextStep {
  const status = post.status

  if (status === 'draft') {
    const hasHook = !!post.hook?.trim()
    return {
      stage: hasHook ? 'copy' : 'idea',
      primary: {
        kind: hasHook ? 'rewrite_draft' : 'write_draft',
        label: hasHook ? 'Rewrite draft' : 'Write draft',
        disabled: false,
      },
      secondary: [],
    }
  }

  if (status === 'changes_requested') {
    return {
      stage: 'copy',
      primary: { kind: 'rewrite_draft', label: 'Rewrite with notes', disabled: false },
      secondary: [],
    }
  }

  if (status === 'needs_revision') {
    return {
      stage: 'copy',
      primary: null,
      secondary: [{ kind: 'restart_draft', label: 'Restart to draft', disabled: false }],
      info: 'Revision limit reached',
    }
  }

  if (status === 'pending_approval') {
    const blocked = carouselApproveBlocked(post, slides)
    return {
      stage: 'copy',
      primary: {
        kind: 'approve_copy',
        label: 'Approve copy',
        disabled: blocked,
        title: blocked ? 'Carousel needs ≥2 slides with copy' : undefined,
      },
      secondary: [
        { kind: 'revise_with_notes', label: 'Revise with notes', disabled: false },
        { kind: 'try_hooks', label: 'Try new hooks', disabled: false },
      ],
    }
  }

  if (status === 'approved') {
    return {
      stage: 'visuals',
      primary: { kind: 'generate_visual', label: 'Generate visual', disabled: false },
      secondary: [{ kind: 'open_studio', label: 'Design in Studio', disabled: false }],
    }
  }

  if (status === 'media_generating') {
    return { stage: 'visuals', primary: null, secondary: [], info: 'Generating visual…' }
  }

  if (status === 'media_ready') {
    const mediaBlocked = carouselMediaBlocked(post, slides)
    return {
      stage: 'visuals',
      primary: {
        kind: 'approve_visual',
        label: 'Approve visuals',
        disabled: mediaBlocked,
        title: mediaBlocked ? 'Carousel slides missing source media' : undefined,
      },
      secondary: [
        { kind: 'regenerate_visual', label: 'Regenerate visual', disabled: false },
        { kind: 'open_studio', label: 'Design in Studio', disabled: false },
      ],
    }
  }

  if (status === 'staged' || status === 'pending_upload' || status === 'publishing') {
    return { stage: 'ready', primary: null, secondary: [], info: 'Scheduled' }
  }

  if (status === 'published') {
    return { stage: 'live', primary: null, secondary: [] }
  }

  if (status === 'failed') {
    return {
      stage: 'failed',
      primary: null,
      secondary: [],
      info: post.error ?? 'Failed',
    }
  }

  return { stage: 'idea', primary: null, secondary: [] }
}
