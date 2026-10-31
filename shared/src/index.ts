/** Shared API / domain DTOs for client + server. */

export type PostStatus =
  | 'draft'
  | 'pending_approval'
  | 'changes_requested'
  | 'needs_revision'
  | 'approved'
  | 'media_generating'
  | 'media_ready'
  | 'staged'
  | 'pending_upload'
  | 'publishing'
  | 'published'
  | 'failed'

export type PostFormat = 'feed' | 'reel' | 'carousel'

export type CanvasLayer = {
  id: string
  type: 'hook' | 'text'
  text: string
  x: number
  y: number
  w: number
  fontSize: number
  align: 'left' | 'center' | 'right'
  color: string
  weight: 400 | 600 | 700
  shadow?: boolean
}

export type CanvasScrim = 'none' | 'bottom' | 'full'

export type CanvasDoc = {
  version: 1
  format: PostFormat
  background: { fit: 'cover' | 'contain'; focusX: number; focusY: number }
  /** Dark overlay so light text stays readable. */
  scrim?: CanvasScrim
  layers: CanvasLayer[]
  safeZone: boolean
}

/** Operator-chosen visual direction — steers Pexels / image_prompt keywords. */
export type BackgroundStyle =
  | 'flat_lay'
  | 'lifestyle'
  | 'outdoor_nature'
  | 'cozy_indoor'
  | 'studio_minimal'
  | 'urban'
  | 'workspace'
  | 'abstract_texture'

export const BACKGROUND_STYLES: Array<{
  id: BackgroundStyle
  label: string
  keywords: string
}> = [
  { id: 'flat_lay', label: 'Flat lay', keywords: 'flat lay overhead tabletop' },
  { id: 'lifestyle', label: 'Lifestyle', keywords: 'lifestyle candid natural light' },
  { id: 'outdoor_nature', label: 'Outdoor / nature', keywords: 'outdoor nature landscape greenery' },
  { id: 'cozy_indoor', label: 'Cozy indoor', keywords: 'cozy indoor warm home' },
  { id: 'studio_minimal', label: 'Studio minimal', keywords: 'studio minimal clean background' },
  { id: 'urban', label: 'Urban', keywords: 'urban city street architecture' },
  { id: 'workspace', label: 'Workspace', keywords: 'desk workspace laptop coffee' },
  { id: 'abstract_texture', label: 'Abstract texture', keywords: 'abstract texture pattern soft' },
]

export type PostSlide = {
  id: number
  post_id: number
  position: number
  source_image_url: string | null
  canvas_json: string | null
  staged_url: string | null
  created_at: string
  updated_at: string | null
}

export type BrandPillar = {
  name: string
  notes?: string
}

/** Sparse per-post patch merged over brand_profile at resolve time. */
export type BrandOverrides = {
  audience?: string
  tone?: string
  voice_note?: string
  hashtag_extra?: string
  visual_extra?: string
  image_prompt_extra?: string
  background_style?: BackgroundStyle | string
}

export type BrandProfile = {
  id: number
  name: string
  niche: string | null
  audience: string | null
  goals: string | null
  /** JSON array of BrandPillar or string[] */
  pillars: string | null
  posts_per_week: number
  /** JSON string[] e.g. ["mon","wed","fri"] */
  preferred_days: string | null
  voice: string | null
  examples: string | null
  visual: string | null
  default_background_style: BackgroundStyle | string | null
  default_format: PostFormat | string | null
  guide_md: string | null
  created_at: string
  updated_at: string | null
}

export type CalendarProposal = {
  date: string
  topic: string
  pillar: string | null
  format: PostFormat | string
  angle: string | null
  background_style?: BackgroundStyle | string | null
}

export type Post = {
  id: number
  account_id: string | null
  status: PostStatus
  topic: string | null
  hook: string | null
  hook_alternates: string | null
  caption: string | null
  hashtags: string | null
  format: PostFormat | string | null
  background_style: BackgroundStyle | string | null
  image_prompt: string | null
  stock_search_query: string | null
  reel_prompt: string | null
  image_url: string | null
  source_image_url: string | null
  reel_url: string | null
  media_type: string | null
  media_provider: string | null
  canvas_json: string | null
  brand_profile_id: number | null
  brand_overrides: string | null
  scheduled_at: string | null
  pillar: string | null
  instagram_media_id: string | null
  approved_by: string | null
  approved_at: string | null
  revisions: number
  revision_comments: string | null
  agent_output: string | null
  error: string | null
  created_at: string
  updated_at: string | null
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'needs_human'

export type Run = {
  id: number
  post_id: number | null
  goal: string
  kind: string
  status: RunStatus | string
  model: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export type RunEvent = {
  id: number
  run_id: number
  seq: number
  type: string
  payload: Record<string, unknown>
  created_at: string
}

export type InstagramConnection = {
  id: number
  account_id: string
  status: string
  updated_at: string | null
  ig_username?: string | null
  page_id?: string | null
  last_error?: string | null
  token_expires_at?: string | null
  has_token?: boolean
  default_brand_profile_id?: number | null
}

export type Actor = {
  id: string
  name: string
}

export type ApproveBody = {
  actor: Actor
}

export type RequestChangesBody = {
  author: Actor
  comment: string
}

export type CreatePostBody = {
  topic?: string
  account_id?: string
  background_style?: BackgroundStyle | string
  format?: PostFormat | string
  brand_profile_id?: number
  scheduled_at?: string
  pillar?: string
}

export type AgentRunResponse = {
  post: Post
  run_id: number
  note?: string
}

export type PostsListResponse = {
  posts: Post[]
}

export type PostResponse = {
  post: Post
  slides?: PostSlide[]
}

export type RunsListResponse = {
  runs: Run[]
}

export type RunDetailResponse = {
  run: Run
  events: RunEvent[]
}

export type InstagramListResponse = {
  connections: InstagramConnection[]
}

/** Export pixel sizes per format (carousel uses feed size per slide). */
export const FORMAT_EXPORT: Record<
  PostFormat,
  { width: number; height: number; aspect: string }
> = {
  feed: { width: 1080, height: 1350, aspect: '4 / 5' },
  reel: { width: 1080, height: 1920, aspect: '9 / 16' },
  carousel: { width: 1080, height: 1350, aspect: '4 / 5' },
}

export function defaultCanvasDoc(format: PostFormat, hook?: string | null): CanvasDoc {
  return {
    version: 1,
    format,
    background: { fit: 'cover', focusX: 0.5, focusY: 0.5 },
    scrim: 'bottom',
    layers: [
      {
        id: 'hook',
        type: 'hook',
        text: (hook || '').trim() || 'Your hook',
        x: 0.08,
        y: 0.72,
        w: 0.84,
        fontSize: 0.045,
        align: 'center',
        color: '#ffffff',
        weight: 700,
        shadow: true,
      },
    ],
    safeZone: true,
  }
}
