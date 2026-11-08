/**
 * Status-aware post dialog: Meta / Draft / Compose panels + sticky primary CTA.
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  BackgroundStyle,
  BrandOverrides,
  BrandProfile,
  PostSlide,
} from '@instagram-agent/shared'
import { BACKGROUND_STYLES } from '../lib/background-styles'
import type { ApiPost, InstagramConn, Iteration, PostStatus } from '../api'
import { patchPost, patchPostSlide } from '../api'
import { FormField } from './layout'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Link } from '@tanstack/react-router'
import { cn } from '../lib/utils'

export const STATUS_TONE: Record<PostStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
  pending_approval: {
    label: 'Needs OK',
    className: 'bg-pending-soft text-pending border border-pending/20',
  },
  changes_requested: {
    label: 'Revise',
    className: 'bg-warn-soft text-warn border border-warn/20',
  },
  needs_revision: {
    label: 'Cap hit',
    className: 'bg-warn-soft text-warn border border-warn/30',
  },
  approved: {
    label: 'Passed',
    className: 'bg-ok-soft text-ok border border-ok/20',
  },
  media_generating: { label: 'Media…', className: 'bg-muted text-muted-foreground' },
  media_ready: { label: 'Compose', className: 'bg-muted text-muted-foreground' },
  staged: {
    label: 'Staged',
    className: 'bg-ok-soft text-ok border border-ok/20',
  },
  pending_upload: { label: 'Upload', className: 'bg-muted text-muted-foreground' },
  publishing: { label: 'Publishing', className: 'bg-muted text-muted-foreground' },
  published: {
    label: 'Published',
    className: 'bg-ok-soft text-ok border border-ok/20',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-50 text-destructive border border-destructive/20',
  },
}

type Panel = 'meta' | 'draft' | 'compose'

/** Explicit type for the primary action button to avoid circular inference in useMemo. */
type PrimaryAction = {
  label: string
  onClick: () => void
  variant: 'default' | 'outline' | 'pending'
  disabled: boolean
  title?: string
} | null

function text(value: string | null | undefined, fallback = '—') {
  const t = (value || '').trim()
  return t || fallback
}

function defaultPanelForStatus(status: PostStatus, hasMedia = false): Panel {
  if (status === 'media_ready' || status === 'staged' || status === 'published') return 'compose'
  if (status === 'failed') return hasMedia ? 'compose' : 'draft'
  return 'draft'
}

function carouselApproveBlocked(post: ApiPost, slides: PostSlide[]): boolean {
  if (post.format !== 'carousel') return false
  if (slides.length < 2) return true
  return slides.some((s) => {
    if (s.text?.trim()) return false
    try {
      const doc = JSON.parse(s.canvas_json || '{}') as { layers?: Array<{ text?: string }> }
      return !doc.layers?.some((l) => l.text?.trim())
    } catch {
      return true
    }
  })
}

type Props = {
  post: ApiPost
  slides: PostSlide[]
  setSlides: React.Dispatch<React.SetStateAction<PostSlide[]>>
  busy: boolean
  error: string | null
  brands: BrandProfile[]
  connections: InstagramConn[]
  brandEditId: number | ''
  setBrandEditId: (v: number | '') => void
  scheduleEdit: string
  setScheduleEdit: (v: string) => void
  pillarEdit: string
  setPillarEdit: (v: string) => void
  overrideOpen: boolean
  setOverrideOpen: (v: boolean | ((o: boolean) => boolean)) => void
  overrideDraft: BrandOverrides
  setOverrideDraft: React.Dispatch<React.SetStateAction<BrandOverrides>>
  stockQueryEdit: string
  setStockQueryEdit: (v: string) => void
  imagePromptEdit: string
  setImagePromptEdit: (v: string) => void
  changeComment: string
  setChangeComment: (v: string) => void
  iterations: Iteration[]
  maxRevisions: number
  igInsights: Record<string, number> | null
  igComments: Array<{ id: string; text?: string; username?: string; timestamp?: string }>
  onSaveBrandMeta: () => Promise<void>
  onSetPost: (post: ApiPost) => void
  onSetError: (msg: string | null) => void
  onSetBusy: (v: boolean) => void
  onGenerate: () => void
  onRegenerate: () => void
  onDelete: () => void
  onApprove: () => void
  onRequestChanges: () => void
  onRestart: () => void
  onFetchMedia: (
    provider: 'pexels' | 'openai' | 'runware',
    slideId?: number,
    opts?: { quality?: 'draft' | 'final' }
  ) => Promise<void>
  onPublish: () => void
  onFetchInsights: () => void
  onFetchComments: () => void
  onAddSlide: () => Promise<void>
  onRemoveSlide: (slideId: number) => Promise<void>
  onApproveMedia: (payload: {
    canvas_json?: string
    stage_reel?: boolean
    slides?: Array<{ position: number; png_base64: string; canvas_json: string }>
  }) => Promise<void>
}

export function PostDialogBody({
  post,
  slides,
  setSlides,
  busy,
  error,
  brands,
  connections: _connections,
  brandEditId,
  setBrandEditId,
  scheduleEdit,
  setScheduleEdit,
  pillarEdit,
  setPillarEdit,
  overrideOpen,
  setOverrideOpen,
  overrideDraft,
  setOverrideDraft,
  stockQueryEdit,
  setStockQueryEdit,
  imagePromptEdit,
  setImagePromptEdit,
  changeComment,
  setChangeComment,
  iterations,
  maxRevisions,
  igInsights,
  igComments,
  onSaveBrandMeta,
  onSetPost,
  onSetError,
  onSetBusy,
  onGenerate,
  onRegenerate,
  onDelete,
  onApprove,
  onRequestChanges,
  onRestart,
  onFetchMedia,
  onPublish,
  onFetchInsights,
  onFetchComments,
  onAddSlide: _onAddSlide,
  onRemoveSlide: _onRemoveSlide,
  onApproveMedia,
}: Props) {
  void _onAddSlide
  void _onRemoveSlide
  void _connections
  const hasMedia = Boolean(
    post.reel_url || post.image_url || slides.some((s) => s.source_image_url)
  )
  const [panel, setPanel] = useState<Panel>(() =>
    defaultPanelForStatus(post.status, hasMedia)
  )
  const [reelPromptEdit, setReelPromptEdit] = useState(post.reel_prompt || '')
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    setPanel(
      defaultPanelForStatus(
        post.status,
        Boolean(post.reel_url || post.image_url || slides.some((s) => s.source_image_url))
      )
    )
    setMenuOpen(false)
    setReelPromptEdit(post.reel_prompt || '')
  }, [post.id, post.status, post.reel_prompt])

  const tone = STATUS_TONE[post.status]
  const title = text(post.topic, `Post ${post.id}`)
  const showMediaPrompts =
    post.status === 'approved' ||
    post.status === 'media_generating' ||
    post.status === 'media_ready' ||
    post.status === 'staged' ||
    post.status === 'published' ||
    post.status === 'failed'
  const canEditBg =
    post.status === 'draft' ||
    post.status === 'changes_requested' ||
    post.status === 'pending_approval' ||
    post.status === 'approved'

  const primary = useMemo((): PrimaryAction => {
    if (post.status === 'draft' || post.status === 'changes_requested') {
      return {
        label: post.hook?.trim() ? 'Regenerate' : 'Generate',
        onClick: () => (post.hook?.trim() ? onRegenerate() : onGenerate()),
        variant: 'default' as const,
        disabled: busy,
      }
    }
    if (post.status === 'needs_revision') {
      return {
        label: 'Restart to draft',
        onClick: onRestart,
        variant: 'outline' as const,
        disabled: busy,
      }
    }
    if (post.status === 'pending_approval') {
      return {
        label: 'Approve',
        onClick: onApprove,
        variant: 'pending' as const,
        disabled: busy || carouselApproveBlocked(post, slides),
        title: carouselApproveBlocked(post, slides)
          ? 'Carousel needs ≥2 slides with text'
          : undefined,
      }
    }
    if (post.status === 'approved' || post.status === 'media_generating') {
      if (post.format === 'reel') {
        return {
          label: 'Generate draft video',
          onClick: () => void onFetchMedia('runware', undefined, { quality: 'draft' }),
          variant: 'default' as const,
          disabled: busy,
        }
      }
      return {
        label: post.format === 'carousel' ? 'Generate all slides (AI)' : 'Generate with AI',
        onClick: () => void onFetchMedia('openai'),
        variant: 'default' as const,
        disabled: busy,
      }
    }
    if (post.status === 'media_ready') {
      if (post.format === 'reel' && post.reel_quality !== 'final') {
        return {
          label: 'Generate final (1080×1920)',
          onClick: () => void onFetchMedia('runware', undefined, { quality: 'final' }),
          variant: 'default' as const,
          disabled: busy || !post.reel_url,
          title: !post.reel_url ? 'Generate a draft video first' : undefined,
        }
      }
      if (post.format === 'reel' && post.reel_url) {
        return {
          label: 'Approve reel',
          onClick: () =>
            void onApproveMedia({ stage_reel: true, canvas_json: post.canvas_json || undefined }),
          variant: 'default' as const,
          disabled: busy,
        }
      }
      if (panel === 'compose') return null
      return {
        label: 'Open Compose',
        onClick: () => setPanel('compose'),
        variant: 'default' as const,
        disabled: busy,
      }
    }
    if (post.status === 'staged') {
      return {
        label: 'Publish to Instagram',
        onClick: onPublish,
        variant: 'default' as const,
        disabled: busy,
      }
    }
    if (post.status === 'failed') {
      return {
        label: 'Retry publish',
        onClick: onPublish,
        variant: 'outline' as const,
        disabled: busy || !(post.reel_url || post.image_url),
      }
    }
    return null
  }, [
    post,
    slides,
    busy,
    panel,
    onGenerate,
    onRegenerate,
    onApprove,
    onRestart,
    onFetchMedia,
    onPublish,
    onApproveMedia,
  ])

  return (
    <DialogContent className="flex max-h-[92vh] max-w-4xl flex-col overflow-hidden p-0">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-border bg-card px-5 pb-3 pr-12 pt-5 sm:px-6 sm:pr-14">
        <DialogHeader className="mb-0 space-y-2 border-0 pb-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <DialogTitle className="line-clamp-2 pr-2 text-left text-lg leading-snug">
                {title}
              </DialogTitle>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={tone.className}>{tone.label}</Badge>
                <Badge className="bg-muted text-muted-foreground uppercase tracking-wide">
                  {text(post.format, 'feed')}
                </Badge>
                {post.format === 'reel' && post.reel_quality && (
                  <Badge className="bg-muted text-muted-foreground uppercase tracking-wide">
                    {post.reel_quality === 'final' ? '1080×1920 final' : '720×1280 draft'}
                  </Badge>
                )}
                <span className="font-mono text-[10px] text-muted-foreground">#{post.id}</span>
              </div>
            </div>
            <div className="relative flex shrink-0 flex-wrap items-center gap-1.5">
              {post.status === 'pending_approval' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={onRequestChanges}
                >
                  Request changes
                </Button>
              )}
              {(post.status === 'approved' || post.status === 'media_generating') &&
                post.format !== 'reel' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void onFetchMedia('pexels')}
                >
                  {post.format === 'carousel' ? 'All slides (Pexels)' : 'Pexels'}
                </Button>
              )}
              {(post.status === 'media_ready' || post.status === 'staged') &&
                post.format === 'reel' &&
                post.reel_quality === 'final' &&
                panel !== 'compose' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setPanel('compose')}
                  >
                    Compose
                  </Button>
                )}
              {primary && (
                <Button
                  size="sm"
                  variant={primary.variant}
                  disabled={primary.disabled}
                  title={primary.title}
                  onClick={primary.onClick}
                >
                  {primary.label}
                </Button>
              )}
              {post.status !== 'publishing' && post.status !== 'published' && (
                <div className="relative">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    onClick={() => setMenuOpen((o) => !o)}
                  >
                    ⋯
                  </Button>
                  {menuOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 z-20 mt-1 min-w-[180px] border border-border bg-card py-1 shadow-[0_8px_24px_rgba(21,25,30,0.12)]"
                    >
                      {(post.status === 'draft' ||
                        post.status === 'changes_requested' ||
                        post.status === 'pending_approval' ||
                        post.status === 'approved' ||
                        post.status === 'media_ready' ||
                        post.status === 'staged' ||
                        post.status === 'needs_revision' ||
                        post.status === 'failed') && (
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                            onClick={() => {
                              setMenuOpen(false)
                              onRegenerate()
                            }}
                          >
                            Regenerate
                          </button>
                        )}
                      {(post.status === 'draft' || post.status === 'changes_requested') &&
                        !!post.hook?.trim() && (
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                            onClick={() => {
                              setMenuOpen(false)
                              onGenerate()
                            }}
                          >
                            Run without clearing
                          </button>
                        )}
                      {post.status === 'needs_revision' && (
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            setMenuOpen(false)
                            onRestart()
                          }}
                        >
                          Restart to draft
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-red-50"
                        onClick={() => {
                          setMenuOpen(false)
                          onDelete()
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>
      </div>

      {error && (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-red-50 px-5 py-2 text-sm text-destructive sm:px-6"
        >
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-[9.5rem] shrink-0 flex-col gap-0.5 border-r border-border bg-muted/20 px-2 py-3 sm:w-40">
          {(
            [
              ['meta', 'Schedule & brand'],
              ['draft', 'Draft'],
              ['compose', 'Compose'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPanel(id)}
              className={cn(
                'rounded-sm px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
                panel === id
                  ? 'bg-rule text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </aside>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
        {panel === 'meta' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-rule">
                Schedule & brand
              </span>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setOverrideOpen((o) => !o)}
                >
                  {overrideOpen ? 'Hide overrides' : 'Overrides'}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void onSaveBrandMeta()}>
                  Save
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="Brand">
                <select
                  className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                  value={brandEditId === '' ? '' : String(brandEditId)}
                  disabled={busy}
                  onChange={(e) =>
                    setBrandEditId(e.target.value ? Number(e.target.value) : '')
                  }
                >
                  <option value="">None</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Schedule">
                <Input
                  type="datetime-local"
                  value={scheduleEdit}
                  disabled={busy}
                  onChange={(e) => setScheduleEdit(e.target.value)}
                />
              </FormField>
              <FormField label="Pillar">
                <Input
                  value={pillarEdit}
                  disabled={busy}
                  onChange={(e) => setPillarEdit(e.target.value)}
                  placeholder="optional"
                />
              </FormField>
            </div>
            {overrideOpen && (
              <div className="space-y-2 border border-border bg-muted/20 p-3">
                <FormField label="Voice note">
                  <Input
                    value={overrideDraft.voice_note || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setOverrideDraft((d) => ({ ...d, voice_note: e.target.value }))
                    }
                  />
                </FormField>
                <FormField label="Extra image direction">
                  <Input
                    value={overrideDraft.image_prompt_extra || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setOverrideDraft((d) => ({
                        ...d,
                        image_prompt_extra: e.target.value,
                      }))
                    }
                  />
                </FormField>
                <FormField label="Hashtag extras">
                  <Input
                    value={overrideDraft.hashtag_extra || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setOverrideDraft((d) => ({ ...d, hashtag_extra: e.target.value }))
                    }
                  />
                </FormField>
                <FormField label="Background override">
                  <select
                    className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                    value={overrideDraft.background_style || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setOverrideDraft((d) => ({
                        ...d,
                        background_style: e.target.value || undefined,
                      }))
                    }
                  >
                    <option value="">(use post / brand default)</option>
                    {BACKGROUND_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Max carousel slides">
                  <Input
                    type="number"
                    min={2}
                    max={7}
                    value={
                      overrideDraft.max_slides ??
                      brands.find((b) => b.id === brandEditId)?.default_max_slides ??
                      5
                    }
                    disabled={busy}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      setOverrideDraft((d) => ({
                        ...d,
                        max_slides: Number.isFinite(n)
                          ? Math.min(7, Math.max(2, Math.round(n)))
                          : undefined,
                      }))
                    }}
                  />
                </FormField>
              </div>
            )}
          </div>
        )}

        {panel === 'draft' && (
          <div className="space-y-4">
            <FormField label="Topic">
              <Input value={text(post.topic, '')} readOnly />
            </FormField>
            <FormField label="Hook">
              <p className="text-sm leading-relaxed">{text(post.hook)}</p>
            </FormField>
            <FormField label="Caption">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {text(post.caption)}
              </p>
            </FormField>
            <FormField label="Hashtags">
              <div className="flex flex-wrap gap-1.5">
                {text(post.hashtags, '')
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((tag) => (
                    <Badge key={tag} className="bg-muted text-muted-foreground">
                      {tag}
                    </Badge>
                  ))}
                {!post.hashtags?.trim() && (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </div>
            </FormField>

            <FormField label="Format">
              <Badge className="bg-muted text-muted-foreground uppercase">
                {text(post.format, 'feed')}
              </Badge>
            </FormField>

            {(() => {
              let font: string | null = null
              try {
                const draft = post.agent_output
                  ? (JSON.parse(post.agent_output) as { font_family?: string })
                  : null
                font = draft?.font_family || null
              } catch {
                font = null
              }
              if (!font) {
                try {
                  const doc = post.canvas_json
                    ? (JSON.parse(post.canvas_json) as {
                        layers?: Array<{ fontFamily?: string }>
                      })
                    : null
                  font = doc?.layers?.[0]?.fontFamily || null
                } catch {
                  font = null
                }
              }
              if (!font) return null
              return (
                <FormField label="Suggested font">
                  <Badge className="bg-muted text-muted-foreground" style={{ fontFamily: font }}>
                    {font}
                  </Badge>
                </FormField>
              )
            })()}

            {post.format === 'carousel' && (
              <FormField label={`Carousel slides (${slides.length || 0})`}>
                {slides.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Generate to create a slide outline.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {slides.map((s, i) => {
                      let slideText = s.text?.trim() || ''
                      if (!slideText) {
                        try {
                          const doc = JSON.parse(s.canvas_json || '{}') as {
                            layers?: Array<{ text?: string; type?: string }>
                          }
                          slideText =
                            doc.layers?.find((l) => l.type === 'hook')?.text?.trim() ||
                            doc.layers?.[0]?.text?.trim() ||
                            ''
                        } catch {
                          /* ignore */
                        }
                      }
                      const topic = (post.topic || '').trim()
                      const isPlaceholder =
                        !post.agent_output ||
                        !slideText ||
                        /^(Cover|Point \d+|CTA|Slide \d+)$/i.test(slideText) ||
                        (topic.length > 40 &&
                          (slideText === topic ||
                            slideText.startsWith(topic.slice(0, 40)) ||
                            slideText.includes(' · ')))
                      const canEdit =
                        post.status === 'pending_approval' ||
                        post.status === 'approved' ||
                        post.status === 'media_ready' ||
                        post.status === 'draft' ||
                        post.status === 'changes_requested'
                      return (
                        <li
                          key={s.id}
                          className="flex gap-2 rounded-sm border border-border bg-muted/30 px-2 py-1.5"
                        >
                          <span className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-card text-[10px] font-semibold tabular-nums">
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1 space-y-1">
                            {canEdit ? (
                              <Input
                                value={isPlaceholder && slideText.length > 60 ? '' : slideText}
                                disabled={busy}
                                placeholder={
                                  i === 0
                                    ? 'Cover — short on-image hook'
                                    : `Slide ${i + 1} — short point or CTA`
                                }
                                onChange={(e) => {
                                  const v = e.target.value
                                  setSlides((prev) =>
                                    prev.map((x) => (x.id === s.id ? { ...x, text: v } : x))
                                  )
                                }}
                                onBlur={(e) => {
                                  const v = e.target.value.trim()
                                  void (async () => {
                                    try {
                                      let canvas = s.canvas_json
                                      try {
                                        const doc = JSON.parse(canvas || '{}') as {
                                          layers?: Array<{
                                            id?: string
                                            type?: string
                                            text?: string
                                          }>
                                        }
                                        if (doc.layers?.length) {
                                          doc.layers = doc.layers.map((l) =>
                                            l.type === 'hook' || l.id === 'hook'
                                              ? { ...l, text: v }
                                              : l
                                          )
                                          canvas = JSON.stringify(doc)
                                        }
                                      } catch {
                                        /* keep */
                                      }
                                      await patchPostSlide(post.id, s.id, {
                                        text: v,
                                        canvas_json: canvas || undefined,
                                      })
                                    } catch (err) {
                                      onSetError(
                                        err instanceof Error
                                          ? err.message
                                          : 'Failed to save slide text'
                                      )
                                    }
                                  })()
                                }}
                              />
                            ) : (
                              <p className="text-sm leading-snug">{slideText || '—'}</p>
                            )}
                            {isPlaceholder && (
                              <p className="text-[10px] text-muted-foreground">
                                Placeholder — Generate for real slide copy
                              </p>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </FormField>
            )}

            <FormField label="Background style">
              {canEditBg ? (
                <select
                  className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                  value={post.background_style || ''}
                  disabled={busy}
                  onChange={(e) => {
                    const id = e.target.value as BackgroundStyle | ''
                    if (!id) return
                    void (async () => {
                      onSetBusy(true)
                      try {
                        const { post: next } = await patchPost(post.id, {
                          background_style: id,
                        })
                        onSetPost(next)
                      } catch (err) {
                        onSetError(err instanceof Error ? err.message : 'Update failed')
                      } finally {
                        onSetBusy(false)
                      }
                    })()
                  }}
                >
                  <option value="">—</option>
                  {BACKGROUND_STYLES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge className="bg-muted text-muted-foreground">
                  {text(post.background_style, '—')}
                </Badge>
              )}
            </FormField>

            {showMediaPrompts && (
              <>
                <FormField label="Stock search (Pexels)">
                  <Input
                    className="font-mono text-sm"
                    value={stockQueryEdit}
                    disabled={busy}
                    onChange={(e) => setStockQueryEdit(e.target.value)}
                    placeholder="keywords for Pexels"
                  />
                </FormField>
                <FormField label="Image prompt (GPT Image)">
                  <textarea
                    className="min-h-[72px] w-full rounded-sm border border-border bg-card px-2 py-1.5 text-sm outline-none focus-visible:border-rule"
                    value={imagePromptEdit}
                    disabled={busy}
                    onChange={(e) => setImagePromptEdit(e.target.value)}
                    placeholder="Describe the image to generate…"
                  />
                </FormField>
                {post.format === 'reel' && (
                  <FormField label="Reel prompt (Runware)">
                    <textarea
                      className="min-h-[88px] w-full rounded-sm border border-border bg-card px-2 py-1.5 text-sm outline-none focus-visible:border-rule"
                      value={reelPromptEdit}
                      disabled={busy}
                      onChange={(e) => setReelPromptEdit(e.target.value)}
                      onBlur={() => {
                        const v = reelPromptEdit.trim()
                        if (v === (post.reel_prompt || '').trim()) return
                        void (async () => {
                          onSetBusy(true)
                          try {
                            const { post: next } = await patchPost(post.id, {
                              reel_prompt: v || null,
                            })
                            onSetPost(next)
                          } catch (err) {
                            onSetError(
                              err instanceof Error ? err.message : 'Failed to save reel prompt'
                            )
                          } finally {
                            onSetBusy(false)
                          }
                        })()
                      }}
                      placeholder="Motion brief for text-to-video (subject, camera move, mood)…"
                    />
                  </FormField>
                )}
              </>
            )}

            {(post.status === 'pending_approval' || post.status === 'changes_requested') && (
              <FormField label="Change request">
                <Input
                  value={changeComment}
                  onChange={(e) => setChangeComment(e.target.value)}
                  placeholder="What should the agent revise?"
                  disabled={busy}
                />
              </FormField>
            )}

            {iterations.length > 0 && (
              <div className="border border-border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left"
                  onClick={() => setHistoryOpen((o) => !o)}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    History ({iterations.length}/{maxRevisions})
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {historyOpen ? 'Hide' : 'Show'}
                  </span>
                </button>
                {historyOpen && (
                  <ul className="max-h-40 space-y-2 overflow-y-auto border-t border-border px-3 py-2">
                    {iterations.map((it) => (
                      <li key={it.id} className="text-sm">
                        <p className="leading-snug">{it.comment || '(no comment)'}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {it.author} · {it.created_at}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {panel === 'compose' && (
          <div className="space-y-4">
            {post.status === 'failed' && post.error && (
              <p className="text-sm text-destructive">{post.error}</p>
            )}
            {(post.status === 'media_ready' ||
              post.status === 'staged' ||
              post.status === 'published' ||
              (post.status === 'failed' && hasMedia)) && (
              <div className="space-y-3 rounded-sm border border-border bg-muted/20 p-4">
                <p className="text-sm text-muted-foreground">
                  Creative editing moved to Studio (Konva). Open the scene editor to adjust layers, brand kit, and render.
                </p>
                {(post.image_url || post.reel_url) && (
                  <div className="overflow-hidden rounded-md border border-border bg-black max-w-xs">
                    {post.reel_url ? (
                      <video src={post.reel_url} className="w-full" muted playsInline controls />
                    ) : (
                      <img src={post.image_url!} alt="" className="w-full object-cover" />
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Link
                    to="/studio/$postId"
                    params={{ postId: String(post.id) }}
                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    Open in Studio
                  </Link>
                  {!busy && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void onApproveMedia({})}
                    >
                      Approve media
                    </Button>
                  )}
                </div>
              </div>
            )}
            {post.status !== 'media_ready' &&
              post.status !== 'staged' &&
              post.status !== 'published' &&
              !(post.status === 'failed' && hasMedia) && (
                <p className="text-sm text-muted-foreground">
                  Compose unlocks after media is ready. Use Draft → Generate media first.
                </p>
              )}

            {post.status === 'published' && post.instagram_media_id && (
              <div className="space-y-2 rounded-sm border border-border bg-muted/30 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Instagram · analytics ids
                </p>
                <p className="font-mono text-[11px]">media_id · {post.instagram_media_id}</p>
                {post.instagram_permalink && (
                  <a
                    href={post.instagram_permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-xs text-rule underline"
                  >
                    Open on Instagram
                  </a>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button size="sm" variant="outline" disabled={busy} onClick={onFetchInsights}>
                    Fetch insights
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={onFetchComments}>
                    Fetch comments
                  </Button>
                </div>
                {igInsights && (
                  <dl className="grid grid-cols-2 gap-1 pt-1 text-[11px]">
                    {Object.entries(igInsights).map(([k, v]) => (
                      <div
                        key={k}
                        className="flex justify-between gap-2 border-b border-border/60 py-0.5"
                      >
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="font-mono tabular-nums">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {igComments.length > 0 && (
                  <ul className="max-h-36 space-y-1.5 overflow-y-auto pt-1 text-[11px]">
                    {igComments.map((c) => (
                      <li key={c.id} className="border-b border-border/50 pb-1">
                        <span className="font-semibold">@{c.username || 'user'}</span> {c.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </DialogContent>
  )
}
