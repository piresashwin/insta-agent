/**
 * Full-page Post Studio — two perspectives: Post content | Media editor.
 * On-image text lives only in generation prompts (model-baked).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrandOverrides,
  BrandProfile,
  Post,
  PostFormat,
  PostSlide,
  PromptVars,
  CanvasDoc,
} from '@instagram-agent/shared'
import {
  agentRun,
  approveMedia,
  approvePost,
  deletePost,
  generateMedia,
  getPost,
  getPromptPreview,
  listBrandProfiles,
  patchPost,
  patchPostSlide,
  patchPromptPreview,
  publishPostToInstagram,
  requestChanges,
  restartPost,
  type InstagramConnection,
} from '../api'
import {
  canShowRegenerateInMenu,
  defaultStudioPerspective,
  resolveStudioPrimary,
  showOverflowMenu,
} from '../lib/post-studio-actions'
import { STATUS_TONE } from './PostDialog'
import { InstagramPostPreview } from './InstagramPostPreview'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { cn } from '../lib/utils'

type Props = {
  postId: number
  connections: InstagramConnection[]
  onClose: () => void
  onError: (msg: string | null) => void
  onPostUpdated?: (post: Post) => void
}

type Perspective = 'content' | 'media'

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </span>
  )
}

/**
 * Convert a UTC ISO string from the server to a value suitable for
 * <input type="datetime-local">, which uses the user's local time zone.
 */
function toLocalDatetimeInputValue(utcIso: string): string {
  const d = new Date(utcIso)
  if (isNaN(d.getTime())) return ''
  // Format as YYYY-MM-DDTHH:MM in local time.
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  )
}

/**
 * Convert the string value from <input type="datetime-local"> (local time)
 * back to a UTC ISO string for the server.
 */
function fromLocalDatetimeInputValue(localValue: string): string {
  // new Date(localValue) interprets the value as local time, which is correct.
  return new Date(localValue).toISOString()
}

function emptyDoc(format: PostFormat): CanvasDoc {
  return {
    version: 1,
    format,
    background: { fit: 'cover', focusX: 0.5, focusY: 0.5 },
    scrim: 'none',
    layers: [],
    safeZone: true,
  }
}

/** Advisory vision-QA result (only present when VISION_QA_MODEL is configured server-side). */
function MediaQaBadge({ raw }: { raw?: string | null }) {
  if (!raw) return null
  let qa: { text_ok?: boolean; issues?: string[]; checked_at?: string } | null = null
  try {
    qa = JSON.parse(raw)
  } catch {
    return null
  }
  if (!qa) return null
  const ok = Boolean(qa.text_ok)
  return (
    <div
      className={`max-w-sm border px-3 py-2 text-[11px] ${
        ok ? 'border-border text-muted-foreground' : 'border-destructive/50 text-destructive'
      }`}
      role="status"
    >
      <div className="font-semibold">
        {ok ? 'Text check passed' : 'Text check: review on-image lettering'}
      </div>
      {!ok && qa.issues?.length ? (
        <ul className="mt-1 list-disc pl-4">
          {qa.issues.slice(0, 5).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function PostStudio({
  postId,
  connections,
  onClose,
  onError,
  onPostUpdated,
}: Props) {
  const [post, setPost] = useState<Post | null>(null)
  const [slides, setSlides] = useState<PostSlide[]>([])
  const [vars, setVars] = useState<PromptVars | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const [provider, setProvider] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [changeComment, setChangeComment] = useState('')
  const [brands, setBrands] = useState<BrandProfile[]>([])
  const [brandEditId, setBrandEditId] = useState<number | ''>('')
  const [pillarEdit, setPillarEdit] = useState('')
  const [overrideDraft, setOverrideDraft] = useState<BrandOverrides>({})
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [perspective, setPerspective] = useState<Perspective>('content')
  const perspectiveTouchedRef = useRef(false)
  const promptDirtyRef = useRef(false)
  const contentDirtyRef = useRef(false)

  // Post content drafts
  const [topicEdit, setTopicEdit] = useState('')
  const [angleEdit, setAngleEdit] = useState('')
  const [hookEdit, setHookEdit] = useState('')
  const [captionEdit, setCaptionEdit] = useState('')
  const [hashtagsEdit, setHashtagsEdit] = useState('')

  // Media editor prompt drafts
  const [feedPromptEdit, setFeedPromptEdit] = useState('')
  const [reelPromptEdit, setReelPromptEdit] = useState('')
  const [slidePromptEdits, setSlidePromptEdits] = useState<Record<number, string>>({})

  const syncContentDrafts = useCallback((p: Post, force = false) => {
    if (contentDirtyRef.current && !force) return
    setTopicEdit(p.topic || '')
    setAngleEdit(p.angle || '')
    setHookEdit(p.hook || '')
    setCaptionEdit(p.caption || '')
    setHashtagsEdit(p.hashtags || '')
  }, [])

  const syncPromptDrafts = useCallback((p: Post, nextSlides: PostSlide[], force = false) => {
    if (promptDirtyRef.current && !force) return
    setFeedPromptEdit(p.image_prompt || '')
    setReelPromptEdit(p.reel_prompt || '')
    const map: Record<number, string> = {}
    for (const s of nextSlides) {
      map[s.id] = s.image_prompt || ''
    }
    setSlidePromptEdits(map)
  }, [])

  const markPromptDirty = useCallback(() => {
    promptDirtyRef.current = true
  }, [])

  const markContentDirty = useCallback(() => {
    contentDirtyRef.current = true
  }, [])

  const reload = useCallback(async (opts?: { forceDrafts?: boolean }) => {
    const force = opts?.forceDrafts === true
    // First fetch seeds the studio cache; actual data comes from post-preview fetch below.
    await getPost(postId)
    // Seeds empty generation prompts server-side when missing
    const preview = await getPromptPreview(postId)
    setVars(preview.vars)
    // Re-fetch post after preview may have written image_prompt / reel_prompt
    const after = await getPost(postId)
    const nextPost = after.post
    const nextSlides = after.slides || []
    setPost(nextPost)
    setSlides(nextSlides)
    setBrandEditId(nextPost.brand_profile_id ?? '')
    setPillarEdit(nextPost.pillar || '')
    syncContentDrafts(nextPost, force)
    syncPromptDrafts(nextPost, nextSlides, force)
    try {
      setOverrideDraft(
        nextPost.brand_overrides
          ? (JSON.parse(nextPost.brand_overrides) as BrandOverrides)
          : {}
      )
    } catch {
      setOverrideDraft({})
    }
    if (!perspectiveTouchedRef.current) {
      setPerspective(defaultStudioPerspective(nextPost.status))
    }
    onPostUpdated?.(nextPost)
  }, [postId, onPostUpdated, syncContentDrafts, syncPromptDrafts])

  useEffect(() => {
    promptDirtyRef.current = false
    contentDirtyRef.current = false
    perspectiveTouchedRef.current = false
    void reload({ forceDrafts: true }).catch((e) =>
      onError(e instanceof Error ? e.message : 'Studio load failed')
    )
  }, [postId]) // eslint-disable-line react-hooks/exhaustive-deps -- load once per post

  useEffect(() => {
    void listBrandProfiles()
      .then(({ brands: list }) => setBrands(list))
      .catch(() => setBrands([]))
  }, [])

  const format = (post?.format || vars?.format || 'feed') as PostFormat
  const username =
    connections.find((c) => c.account_id === post?.account_id)?.ig_username || null

  const doc: CanvasDoc = useMemo(() => emptyDoc(format), [format])

  const displayUrl = useMemo(() => {
    const s = slides[activeIdx]
    return (
      s?.staged_url ||
      s?.source_image_url ||
      (format === 'reel' ? post?.reel_url : null) ||
      post?.image_url ||
      post?.source_image_url ||
      null
    )
  }, [slides, activeIdx, format, post])

  const primary = useMemo(() => {
    if (!post) return null
    return resolveStudioPrimary({ post, slides, busy })
  }, [post, slides, busy])

  async function applyPost(
    updated: Post,
    nextSlides?: PostSlide[],
    opts?: { forceDrafts?: boolean }
  ) {
    const force = opts?.forceDrafts === true
    setPost(updated)
    syncContentDrafts(updated, force)
    if (nextSlides) {
      setSlides(nextSlides)
      syncPromptDrafts(updated, nextSlides, force)
    } else {
      syncPromptDrafts(updated, slides, force)
    }
    if (!perspectiveTouchedRef.current) {
      setPerspective(defaultStudioPerspective(updated.status))
    }
    onPostUpdated?.(updated)
  }

  async function pollAfterAgent() {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const detail = await getPost(postId)
      setPost(detail.post)
      if (
        detail.post.status === 'pending_approval' ||
        detail.post.status === 'failed' ||
        detail.post.status === 'changes_requested'
      ) {
        // Agent finished — refresh drafts from server (new prompts)
        promptDirtyRef.current = false
        contentDirtyRef.current = false
        await reload({ forceDrafts: true })
        break
      }
    }
  }

  async function handleGenerateAgent() {
    setBusy(true)
    onError(null)
    setMenuOpen(false)
    try {
      await agentRun(postId)
      await pollAfterAgent()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Agent run failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleRegenerate() {
    if (!window.confirm('Regenerate this post? The current draft and media will be replaced.')) return
    setBusy(true)
    onError(null)
    setMenuOpen(false)
    try {
      await restartPost(postId, { clear: true })
      await agentRun(postId)
      await pollAfterAgent()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Regenerate failed')
      await reload().catch(() => null)
    } finally {
      setBusy(false)
    }
  }

  async function handleRestart() {
    setBusy(true)
    onError(null)
    setMenuOpen(false)
    try {
      const { post: updated } = await restartPost(postId, { clear: true })
      await applyPost(updated, [])
      await reload()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Restart failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleApproveCopy() {
    setBusy(true)
    onError(null)
    try {
      // Auto-save unsaved edits before approving so they aren't lost (Phase 0 hotfix)
      if (contentDirtyRef.current) {
        await saveContent()
      }
      const { post: updated } = await approvePost(postId)
      await applyPost(updated)
      perspectiveTouchedRef.current = true
      setPerspective('media')
      // Seed generation prompts if missing so the editor is editable immediately
      if (!promptDirtyRef.current) {
        await reload({ forceDrafts: true })
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleRequestChanges() {
    setBusy(true)
    onError(null)
    try {
      // Auto-save unsaved copy edits before requesting changes (Phase 0 hotfix)
      if (contentDirtyRef.current) {
        await saveContent()
      }
      const { post: updated } = await requestChanges(
        postId,
        changeComment.trim() || 'Please revise'
      )
      setChangeComment('')
      await applyPost(updated)
      perspectiveTouchedRef.current = true
      setPerspective('content')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Request changes failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        'Delete this post? Topic, draft copy, slides, and media references will be removed.'
      )
    ) {
      return
    }
    setBusy(true)
    onError(null)
    setMenuOpen(false)
    try {
      await deletePost(postId)
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Delete failed')
      setBusy(false)
    }
  }

  async function handleGenerateMedia(quality?: 'draft' | 'final') {
    setBusy(true)
    onError(null)
    try {
      // Persist current prompt edits before generate (edits are SoT)
      await saveGenerationPrompts()
      promptDirtyRef.current = false
      const result = await generateMedia(postId, {
        provider: provider || undefined,
        quality: format === 'reel' ? quality || 'draft' : undefined,
      })
      await applyPost(result.post, result.slides, { forceDrafts: true })
      try {
        const preview = await getPromptPreview(postId)
        setVars(preview.vars)
      } catch {
        /* ignore */
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Generate media failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleApproveReel() {
    setBusy(true)
    onError(null)
    try {
      const { post: updated, slides: next } = await approveMedia(postId, {
        stage_reel: true,
      })
      await applyPost(updated, next)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Approve reel failed')
    } finally {
      setBusy(false)
    }
  }

  async function handlePublish() {
    setBusy(true)
    onError(null)
    try {
      const { post: updated } = await publishPostToInstagram(postId)
      await applyPost(updated)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Publish failed')
      await reload().catch(() => null)
    } finally {
      setBusy(false)
    }
  }

  async function saveContent() {
    setBusy(true)
    onError(null)
    try {
      const { post: updated } = await patchPost(postId, {
        topic: topicEdit.trim() || null,
        angle: angleEdit.trim() || null,
        hook: hookEdit.trim() || null,
        caption: captionEdit.trim() || null,
        hashtags: hashtagsEdit.trim() || null,
      })
      contentDirtyRef.current = false
      await applyPost(updated, undefined, { forceDrafts: true })
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save content failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveBrandMeta() {
    setBusy(true)
    onError(null)
    try {
      const { post: updated } = await patchPost(postId, {
        brand_profile_id: brandEditId === '' ? null : brandEditId,
        pillar: pillarEdit.trim() || null,
        brand_overrides: Object.keys(overrideDraft).length
          ? JSON.stringify(overrideDraft)
          : null,
      })
      await applyPost(updated)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save brand failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveGenerationPrompts() {
    if (format === 'reel') {
      const { post: updated } = await patchPost(postId, {
        reel_prompt: reelPromptEdit,
      })
      setPost(updated)
      setReelPromptEdit(updated.reel_prompt || '')
      promptDirtyRef.current = false
      return
    }
    if (format === 'carousel') {
      for (const s of slides) {
        const next = slidePromptEdits[s.id]
        if (next === undefined) continue
        if ((s.image_prompt || '') === next) continue
        await patchPostSlide(postId, s.id, { image_prompt: next })
      }
      if (slides[0]) {
        const cover = slidePromptEdits[slides[0].id] ?? slides[0].image_prompt ?? ''
        const { post: updated } = await patchPost(postId, {
          image_prompt: cover,
        })
        setPost(updated)
      }
      const detail = await getPost(postId)
      setSlides(detail.slides || [])
      promptDirtyRef.current = false
      syncPromptDrafts(detail.post, detail.slides || [], true)
      return
    }
    const { post: updated } = await patchPost(postId, {
      image_prompt: feedPromptEdit,
    })
    setPost(updated)
    setFeedPromptEdit(updated.image_prompt || '')
    promptDirtyRef.current = false
  }

  async function handleSavePrompts() {
    setBusy(true)
    onError(null)
    try {
      await saveGenerationPrompts()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save prompt failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleResetPrompts() {
    setBusy(true)
    onError(null)
    try {
      const preview = await patchPromptPreview(postId, null, { reset: true })
      setVars(preview.vars)
      promptDirtyRef.current = false
      await reload({ forceDrafts: true })
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Reset prompts failed')
    } finally {
      setBusy(false)
    }
  }

  function runPrimary() {
    if (!primary) return
    switch (primary.kind) {
      case 'generate_agent':
        void handleGenerateAgent()
        break
      case 'regenerate':
        void handleRegenerate()
        break
      case 'restart':
        void handleRestart()
        break
      case 'approve_copy':
        void handleApproveCopy()
        break
      case 'generate_media':
        void handleGenerateMedia()
        break
      case 'runware_final':
        void handleGenerateMedia('final')
        break
      case 'approve_reel':
        void handleApproveReel()
        break
      case 'publish':
      case 'retry_publish':
        void handlePublish()
        break
      default:
        break
    }
  }

  if (!post) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        Loading studio…
      </div>
    )
  }

  const tone = STATUS_TONE[post.status] || STATUS_TONE.draft

  return (
    <div className="dash-in flex min-h-[calc(100vh-7rem)] flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-rule/40 pb-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rule">
            Post Studio
          </p>
          <h1 className="mt-0.5 truncate text-xl font-semibold tracking-tight text-foreground">
            {post.topic || post.hook || `Post #${post.id}`}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge className={tone.className}>{tone.label}</Badge>
            <Badge className="bg-muted text-muted-foreground uppercase tracking-wide">
              {format}
            </Badge>
            {format === 'reel' && post.reel_quality && (
              <Badge className="bg-muted text-muted-foreground uppercase tracking-wide">
                {post.reel_quality === 'final' ? '1080×1920 final' : '720×1280 draft'}
              </Badge>
            )}
            <span className="font-mono text-[10px] text-muted-foreground">#{post.id}</span>
            {post.angle ? (
              <span className="truncate text-[11px] text-muted-foreground">· {post.angle}</span>
            ) : null}
          </div>
        </div>

        <div className="relative flex shrink-0 flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
            Back
          </Button>
          {post.status === 'pending_approval' && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void handleRequestChanges()}
            >
              Request changes
            </Button>
          )}
          {primary && (
            <Button
              size="sm"
              variant={primary.variant}
              disabled={primary.disabled}
              title={primary.title}
              onClick={runPrimary}
            >
              {primary.label}
            </Button>
          )}
          {showOverflowMenu(post.status) && (
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
                  {canShowRegenerateInMenu(post.status) && (
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => void handleRegenerate()}
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
                        onClick={() => void handleGenerateAgent()}
                      >
                        Run without clearing
                      </button>
                    )}
                  {post.status === 'needs_revision' && (
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => void handleRestart()}
                    >
                      Restart to draft
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-red-50"
                    onClick={() => void handleDelete()}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex gap-1 border-b border-rule/30 pb-0">
        {(
          [
            ['content', 'Post content'],
            ['media', 'Media editor'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cn(
              'border-b-2 px-3 py-2 text-[12px] font-semibold tracking-wide transition-colors',
              perspective === id
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
            onClick={() => {
              perspectiveTouchedRef.current = true
              setPerspective(id)
              if (id === 'media' && !promptDirtyRef.current) {
                const empty =
                  format === 'reel'
                    ? !reelPromptEdit.trim()
                    : format === 'carousel'
                      ? slides.length === 0 ||
                        slides.every((s) => !(slidePromptEdits[s.id] || s.image_prompt || '').trim())
                      : !feedPromptEdit.trim()
                if (empty) {
                  void reload({ forceDrafts: true }).catch((e) =>
                    onError(e instanceof Error ? e.message : 'Load prompts failed')
                  )
                }
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {perspective === 'content' ? (
        <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <aside className="space-y-3 border border-border bg-card p-3">
            <div>
              <FieldLabel>Topic</FieldLabel>
              <Input
                className="h-8 text-xs"
                value={topicEdit}
                disabled={busy}
                onChange={(e) => {
                  markContentDirty()
                  setTopicEdit(e.target.value)
                }}
              />
            </div>
            <div>
              <FieldLabel>Angle</FieldLabel>
              <Input
                className="h-8 text-xs"
                value={angleEdit}
                disabled={busy}
                onChange={(e) => {
                  markContentDirty()
                  setAngleEdit(e.target.value)
                }}
              />
            </div>
            <div>
              <FieldLabel>Hook</FieldLabel>
              <textarea
                className="min-h-[56px] w-full rounded-sm border border-input bg-card px-2 py-1.5 text-xs"
                value={hookEdit}
                disabled={busy}
                onChange={(e) => {
                  markContentDirty()
                  setHookEdit(e.target.value)
                }}
              />
            </div>
            <div>
              <FieldLabel>Caption</FieldLabel>
              <textarea
                className="min-h-[88px] w-full rounded-sm border border-input bg-card px-2 py-1.5 text-xs"
                value={captionEdit}
                disabled={busy}
                onChange={(e) => {
                  markContentDirty()
                  setCaptionEdit(e.target.value)
                }}
              />
            </div>
            <div>
              <FieldLabel>Hashtags</FieldLabel>
              <textarea
                className="min-h-[52px] w-full rounded-sm border border-input bg-card px-2 py-1.5 text-xs"
                value={hashtagsEdit}
                disabled={busy}
                onChange={(e) => {
                  markContentDirty()
                  setHashtagsEdit(e.target.value)
                }}
              />
            </div>
            <div>
              <FieldLabel>Format</FieldLabel>
              <select
                className="h-8 w-full rounded-sm border border-input bg-card px-2 text-sm"
                value={format}
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.value as PostFormat
                  void patchPost(postId, { format: f }).then(({ post: p }) => {
                    setPost(p)
                    void getPromptPreview(postId).then((preview) => setVars(preview.vars))
                  })
                }}
              >
                <option value="feed">Feed</option>
                <option value="reel">Reel</option>
                <option value="carousel">Carousel</option>
              </select>
            </div>
            <div>
              <FieldLabel>Schedule</FieldLabel>
              <Input
                type="datetime-local"
                className="h-8 font-mono text-xs"
                value={
                  post.scheduled_at
                    ? toLocalDatetimeInputValue(post.scheduled_at)
                    : ''
                }
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value
                    ? fromLocalDatetimeInputValue(e.target.value)
                    : null
                  void patchPost(postId, { scheduled_at: v }).then(({ post: p }) => setPost(p))
                }}
              />
            </div>
            <div>
              <FieldLabel>Brand</FieldLabel>
              <select
                className="h-8 w-full rounded-sm border border-input bg-card px-2 text-sm"
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
            </div>
            <div>
              <FieldLabel>Pillar</FieldLabel>
              <Input
                className="h-8 text-xs"
                value={pillarEdit}
                disabled={busy}
                onChange={(e) => setPillarEdit(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="text-[10px] font-semibold uppercase tracking-[0.06em] text-rule hover:underline"
              onClick={() => setOverrideOpen((o) => !o)}
            >
              {overrideOpen ? 'Hide overrides' : 'Overrides'}
            </button>
            {overrideOpen && (
              <div className="space-y-1.5">
                <Input
                  className="h-8 text-xs"
                  placeholder="Tone"
                  value={overrideDraft.tone || ''}
                  disabled={busy}
                  onChange={(e) =>
                    setOverrideDraft((d) => ({ ...d, tone: e.target.value || undefined }))
                  }
                />
                <Input
                  className="h-8 text-xs"
                  placeholder="Visual extra"
                  value={overrideDraft.visual_extra || ''}
                  disabled={busy}
                  onChange={(e) =>
                    setOverrideDraft((d) => ({
                      ...d,
                      visual_extra: e.target.value || undefined,
                    }))
                  }
                />
              </div>
            )}
            {(post.status === 'pending_approval' || post.status === 'changes_requested') && (
              <div>
                <FieldLabel>Revision note</FieldLabel>
                <textarea
                  className="min-h-[64px] w-full rounded-sm border border-input bg-card px-2 py-1.5 text-xs"
                  value={changeComment}
                  disabled={busy}
                  placeholder="What should change?"
                  onChange={(e) => setChangeComment(e.target.value)}
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => void saveContent()}
              >
                Save content
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => void saveBrandMeta()}
              >
                Save brand meta
              </Button>
            </div>
          </aside>

          <section className="flex flex-col items-center justify-start gap-4 border border-border bg-muted/20 p-4">
            <InstagramPostPreview
              post={{
                ...post,
                hook: hookEdit,
                caption: captionEdit,
                hashtags: hashtagsEdit,
              }}
              format={format}
              slides={slides}
              activeIdx={activeIdx}
              onActiveIdx={setActiveIdx}
              doc={doc}
              displayUrl={displayUrl}
              username={username}
              frameH={520}
              showOverlays={false}
            />
            <p className="max-w-sm text-center text-[11px] text-muted-foreground">
              Caption preview. On-image lettering is authored in Media editor prompts.
            </p>
          </section>
        </div>
      ) : (
        <div className="grid flex-1 gap-4 lg:grid-cols-[200px_minmax(0,1fr)_340px]">
          <aside className="space-y-3 border border-border bg-card p-3">
            <div>
              <FieldLabel>Provider</FieldLabel>
              <select
                className="h-8 w-full rounded-sm border border-input bg-card px-2 text-sm"
                value={provider}
                disabled={busy}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="">Auto</option>
                <option value="openai">OpenAI image</option>
                <option value="runware">Runware (reel)</option>
              </select>
            </div>
            {format === 'carousel' && slides.length > 0 && (
              <div>
                <FieldLabel>Slides</FieldLabel>
                <ul className="space-y-1">
                  {slides.map((s, i) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className={cn(
                          'w-full rounded-sm px-2 py-1.5 text-left text-xs',
                          i === activeIdx ? 'bg-muted font-medium' : 'hover:bg-muted/60'
                        )}
                        onClick={() => setActiveIdx(i)}
                      >
                        Slide {i + 1}
                        {s.staged_url || s.source_image_url ? ' · media' : ''}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {format === 'reel' && (
              <p className="text-[11px] text-muted-foreground">
                {post.reel_quality === 'final'
                  ? 'Final 1080×1920 (9:16)'
                  : 'Draft 720×1280 — generate final (1080×1920) before publish'}
              </p>
            )}
          </aside>

          <section className="flex flex-col items-center justify-start gap-4 border border-border bg-muted/20 p-4">
            <InstagramPostPreview
              post={post}
              format={format}
              slides={slides}
              activeIdx={activeIdx}
              onActiveIdx={setActiveIdx}
              doc={doc}
              displayUrl={displayUrl}
              username={username}
              frameH={520}
              showOverlays={false}
            />
            <p className="max-w-sm text-center text-[11px] text-muted-foreground">
              Media only — typography is baked by the model from the prompt.
            </p>
            <MediaQaBadge raw={post.media_qa} />
          </section>

          <aside className="flex flex-col gap-3 border border-border bg-card p-3">
            <div>
              <h2 className="text-[13px] font-semibold">Generation prompt</h2>
              <p className="text-[11px] text-muted-foreground">
                Edit freely, then Save or Generate — this text is the source of truth for
                on-image lettering.
              </p>
            </div>

            <div className="max-h-[52vh] flex-1 space-y-2 overflow-y-auto pr-1">
              {format === 'feed' && (
                <label className="block">
                  <FieldLabel>Feed prompt</FieldLabel>
                  <textarea
                    className="min-h-[280px] w-full rounded-sm border border-input bg-card px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground"
                    value={feedPromptEdit}
                    disabled={busy}
                    spellCheck
                    onChange={(e) => {
                      markPromptDirty()
                      setFeedPromptEdit(e.target.value)
                    }}
                  />
                </label>
              )}
              {format === 'reel' && (
                <label className="block">
                  <FieldLabel>Reel prompt</FieldLabel>
                  <textarea
                    className="min-h-[280px] w-full rounded-sm border border-input bg-card px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground"
                    value={reelPromptEdit}
                    disabled={busy}
                    spellCheck
                    onChange={(e) => {
                      markPromptDirty()
                      setReelPromptEdit(e.target.value)
                    }}
                  />
                </label>
              )}
              {format === 'carousel' && slides.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  No slides yet — Approve copy / run agent first, or Reset from template.
                </p>
              )}
              {format === 'carousel' &&
                slides.map((s, i) => (
                  <label key={s.id} className="block">
                    <FieldLabel>
                      Slide {i + 1} prompt
                      {i === activeIdx ? ' (active)' : ''}
                    </FieldLabel>
                    <textarea
                      className="min-h-[160px] w-full rounded-sm border border-input bg-card px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground"
                      value={slidePromptEdits[s.id] ?? s.image_prompt ?? ''}
                      disabled={busy}
                      spellCheck
                      onFocus={() => setActiveIdx(i)}
                      onChange={(e) => {
                        markPromptDirty()
                        setSlidePromptEdits((prev) => ({
                          ...prev,
                          [s.id]: e.target.value,
                        }))
                      }}
                    />
                  </label>
                ))}
            </div>

            <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void handleSavePrompts()}
              >
                Save prompt
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void handleResetPrompts()}
              >
                Reset from template
              </Button>
              <Button
                size="sm"
                disabled={
                  busy ||
                  !['approved', 'media_ready', 'staged', 'media_generating'].includes(
                    post.status
                  )
                }
                onClick={() => void handleGenerateMedia()}
                className={cn(
                  !['approved', 'media_ready', 'staged', 'media_generating'].includes(
                    post.status
                  ) && 'opacity-60'
                )}
              >
                {busy ? 'Working…' : 'Generate media'}
              </Button>
              {!['approved', 'media_ready', 'staged', 'media_generating'].includes(
                post.status
              ) && (
                <p className="text-[10px] text-muted-foreground">
                  Approve copy first, then Generate produces model-baked media.
                </p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
