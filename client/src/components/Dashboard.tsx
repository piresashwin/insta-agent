import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Separator } from './ui/separator'
import { FormField, NavTab, PageShell, Section } from './layout'
import type { BackgroundStyle, BrandOverrides, BrandProfile, PostSlide } from '@instagram-agent/shared'
import { BACKGROUND_STYLES } from '../lib/background-styles'
import { BrandProfilesPanel } from './BrandProfiles'
import { CalendarWeekPanel } from './CalendarWeek'
import {
  type ApiPost,
  type InstagramConn,
  type Iteration,
  type PostStatus,
  type RunEvent,
  type RunRow,
  addPostSlide,
  agentRun,
  approveMedia,
  approvePost,
  connectInstagramWithToken,
  createInstagramConnection,
  createPost,
  deleteInstagramConnection,
  disconnectInstagramOAuth,
  fetchPostMedia,
  getInstagramAuthConfig,
  getPost,
  publishPostToInstagram,
  getRun,
  instagramOAuthStartUrl,
  listBrandProfiles,
  listInstagramConnections,
  listIterations,
  listPosts,
  listPostSlides,
  listRuns,
  mockConnectInstagram,
  patchPost,
  patchPostSlide,
  redactPayload,
  removePostSlide,
  updateInstagramConnection,
  requestChanges,
  restartPost,
  runEventsStreamUrl,
} from '../api'
import { PostCanvasEditor } from './PostCanvasEditor'
import { cn } from '../lib/utils'

const statusTone: Record<
  PostStatus,
  { label: string; className: string }
> = {
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

function text(value: string | null | undefined, fallback = '—') {
  const t = (value || '').trim()
  return t || fallback
}

function Mark() {
  return (
    <span
      aria-hidden
      className="relative flex h-6 w-6 items-center justify-center rounded-[3px] border border-rule/50 bg-rule/10"
    >
      <span className="absolute h-3 w-px bg-rule" />
      <span className="absolute w-3 h-px bg-rule" />
    </span>
  )
}

export default function Dashboard() {
  const [posts, setPosts] = useState<ApiPost[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [connections, setConnections] = useState<InstagramConn[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ApiPost | null>(null)
  const [editingSlides, setEditingSlides] = useState<PostSlide[]>([])
  const [activeTab, setActiveTab] = useState<
    'calendar' | 'queue' | 'brands' | 'runs' | 'connect'
  >('calendar')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTopic, setNewTopic] = useState('')
  const [newBgStyle, setNewBgStyle] = useState<BackgroundStyle | ''>('lifestyle')
  const [showNew, setShowNew] = useState(false)
  const [stockQueryEdit, setStockQueryEdit] = useState('')
  const [imagePromptEdit, setImagePromptEdit] = useState('')
  const [brands, setBrands] = useState<BrandProfile[]>([])
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideDraft, setOverrideDraft] = useState<BrandOverrides>({})
  const [scheduleEdit, setScheduleEdit] = useState('')
  const [pillarEdit, setPillarEdit] = useState('')
  const [brandEditId, setBrandEditId] = useState<number | ''>('')
  const [scheduleFilter, setScheduleFilter] = useState<'all' | 'scheduled' | 'unscheduled'>(
    'all'
  )
  const [changeComment, setChangeComment] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [runEvents, setRunEvents] = useState<RunEvent[]>([])
  const [runDetailLoading, setRunDetailLoading] = useState(false)
  const [liveRunMeta, setLiveRunMeta] = useState<{
    status?: string
    model?: string | null
    live?: boolean
  }>({})
  const [iterations, setIterations] = useState<Iteration[]>([])
  const [maxRevisions, setMaxRevisions] = useState(3)
  const [statusFilter, setStatusFilter] = useState<PostStatus | ''>('')
  const [igForm, setIgForm] = useState({
    account_id: '',
    app_id: '',
    client_secret: '',
    redirect_uri: '',
  })
  const [pasteTokenById, setPasteTokenById] = useState<Record<number, string>>({})
  const [oauthBanner, setOauthBanner] = useState<string | null>(null)
  const [oauthNote, setOauthNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    const [{ posts: nextPosts }, { runs: nextRuns }, { connections: nextConns }, brandsRes] =
      await Promise.all([
        listPosts(statusFilter || undefined),
        listRuns(20),
        listInstagramConnections(),
        listBrandProfiles().catch(() => ({ brands: [] as BrandProfile[] })),
      ])
    setPosts(nextPosts)
    setRuns(nextRuns)
    setConnections(nextConns)
    setBrands(brandsRes.brands)
  }, [statusFilter])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        await refresh()
        try {
          const cfg = await getInstagramAuthConfig()
          if (!cancelled) {
            setOauthNote(cfg.note)
            if (cfg.redirect_uri) {
              setIgForm((f) => (f.redirect_uri ? f : { ...f, redirect_uri: cfg.redirect_uri! }))
            }
          }
        } catch {
          if (!cancelled) {
            setOauthNote(
              'Instagram Login browser OAuth needs a stable HTTPS callback. For local dev, paste a token from Meta App Dashboard → Generate token.'
            )
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // OAuth callback lands on CLIENT_ORIGIN?tab=connect&oauth=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const tab = params.get('tab')
    const oauth = params.get('oauth')
    const message = params.get('message')
    const username = params.get('username')
    if (tab === 'connect') setActiveTab('connect')
    if (oauth === 'connected' || oauth === 'mock_connected') {
      setOauthBanner(
        `Connected${username ? `: @${username}` : ''}. Token encrypted at rest.`
      )
      setError(null)
    } else if (oauth === 'error') {
      setOauthBanner(null)
      setError(message || 'Instagram OAuth failed')
      setActiveTab('connect')
    }
    if (oauth || tab) {
      window.history.replaceState({}, '', window.location.pathname)
      void refresh()
    }
  }, [refresh])

  const pendingCount = posts.filter((p) => p.status === 'pending_approval').length
  const approvedCount = posts.filter((p) => p.status === 'approved').length
  const publishedCount = posts.filter((p) => p.status === 'published').length
  const visiblePosts = posts.filter((p) => {
    if (scheduleFilter === 'scheduled') return !!p.scheduled_at
    if (scheduleFilter === 'unscheduled') return !p.scheduled_at
    return true
  })

  function syncPostMeta(post: ApiPost) {
    setStockQueryEdit(post.stock_search_query || '')
    setImagePromptEdit(post.image_prompt || '')
    setBrandEditId(post.brand_profile_id ?? '')
    setScheduleEdit(post.scheduled_at ? post.scheduled_at.slice(0, 16) : '')
    setPillarEdit(post.pillar || '')
    try {
      setOverrideDraft(
        post.brand_overrides ? (JSON.parse(post.brand_overrides) as BrandOverrides) : {}
      )
    } catch {
      setOverrideDraft({})
    }
  }

  async function openPost(post: ApiPost) {
    setEditing(post)
    syncPostMeta(post)
    setOverrideOpen(false)
    setOpen(true)
    try {
      const detail = await getPost(post.id)
      setEditing(detail.post)
      syncPostMeta(detail.post)
      setEditingSlides(detail.slides || [])
    } catch {
      try {
        const { slides } = await listPostSlides(post.id)
        setEditingSlides(slides)
      } catch {
        setEditingSlides([])
      }
    }
  }

  async function savePostBrandMeta() {
    if (!editing) return
    setBusy(true)
    setError(null)
    try {
      const { post } = await patchPost(editing.id, {
        brand_profile_id: brandEditId === '' ? null : brandEditId,
        scheduled_at: scheduleEdit ? new Date(scheduleEdit).toISOString() : null,
        pillar: pillarEdit.trim() || null,
        brand_overrides: Object.keys(overrideDraft).length
          ? JSON.stringify(overrideDraft)
          : null,
      })
      setEditing(post)
      syncPostMeta(post)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleCreatePost(runImmediately: boolean) {
    const topic = newTopic.trim()
    if (!topic) return
    setBusy(true)
    setError(null)
    try {
      const { post } = await createPost(topic, {
        background_style: newBgStyle || undefined,
      })
      setShowNew(false)
      setNewTopic('')
      if (runImmediately) {
        const { post: updated, run_id } = await agentRun(post.id)
        await refresh()
        setEditing(updated)
        setStockQueryEdit(updated.stock_search_query || '')
        setOpen(true)
        if (run_id) {
          setActiveTab('runs')
          setSelectedRunId(run_id)
        }
      } else {
        await refresh()
        setEditing(post)
        setStockQueryEdit('')
        setOpen(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleAgentRun(postId: number) {
    setBusy(true)
    setError(null)
    try {
      // 202 + run_id immediately — SSE tails pipeline steps live.
      const { post, run_id } = await agentRun(postId)
      await refresh()
      setEditing(post)
      if (run_id) {
        setActiveTab('runs')
        setSelectedRunId(run_id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Agent run failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleApprove(postId: number) {
    setBusy(true)
    setError(null)
    try {
      const { post } = await approvePost(postId)
      await refresh()
      setEditing(post)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleRequestChanges(postId: number) {
    setBusy(true)
    setError(null)
    try {
      const { post } = await requestChanges(
        postId,
        changeComment.trim() || 'Please revise'
      )
      setChangeComment('')
      await refresh()
      setEditing(post)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request changes failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleRestart(postId: number) {
    setBusy(true)
    setError(null)
    try {
      const { post } = await restartPost(postId)
      await refresh()
      setEditing(post)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restart failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleFetchMedia(
    postId: number,
    provider: 'pexels' | 'openai',
    slideId?: number
  ) {
    setBusy(true)
    setError(null)
    try {
      if (provider === 'openai') {
        const prompt = imagePromptEdit.trim() || undefined
        if (prompt && prompt !== (editing?.image_prompt || '')) {
          await patchPost(postId, { image_prompt: prompt })
        }
        const { post, media, slides } = await fetchPostMedia(postId, {
          provider: 'openai',
          slide_id: slideId,
          prompt,
        })
        await refresh()
        setEditing(post)
        setImagePromptEdit(post.image_prompt || prompt || '')
        if (slides) setEditingSlides(slides)
        else {
          const listed = await listPostSlides(postId)
          setEditingSlides(listed.slides)
        }
        console.info('[media]', media?.provider, media?.model, media?.url)
      } else {
        const query = stockQueryEdit.trim() || undefined
        if (query && query !== (editing?.stock_search_query || '')) {
          await patchPost(postId, { stock_search_query: query })
        }
        const { post, media, slides } = await fetchPostMedia(postId, {
          provider: 'pexels',
          slide_id: slideId,
          query,
        })
        await refresh()
        setEditing(post)
        setStockQueryEdit(post.stock_search_query || query || '')
        if (slides) setEditingSlides(slides)
        else {
          const listed = await listPostSlides(postId)
          setEditingSlides(listed.slides)
        }
        console.info('[media]', media?.provider, media?.query, media?.url)
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : provider === 'openai'
            ? 'AI image generation failed'
            : 'Pexels fetch failed'
      )
    } finally {
      setBusy(false)
    }
  }

  async function handlePublishInstagram(postId: number) {
    setBusy(true)
    setError(null)
    try {
      const { post, note } = await publishPostToInstagram(postId)
      await refresh()
      setEditing(post)
      if (note) setOauthBanner(note)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Instagram publish failed')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateInstagram(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createInstagramConnection({
        account_id: igForm.account_id.trim(),
        app_id: igForm.app_id.trim(),
        client_secret: igForm.client_secret.trim(),
        redirect_uri: igForm.redirect_uri.trim(),
      })
      setIgForm((f) => ({ ...f, account_id: '', app_id: '', client_secret: '' }))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save account')
    } finally {
      setBusy(false)
    }
  }

  async function handleIgDisconnect(id: number) {
    setBusy(true)
    setError(null)
    setOauthBanner(null)
    try {
      await disconnectInstagramOAuth(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    } finally {
      setBusy(false)
    }
  }

  async function handleIgDelete(id: number) {
    setBusy(true)
    setError(null)
    try {
      await deleteInstagramConnection(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete account')
    } finally {
      setBusy(false)
    }
  }

  async function handleMockConnect(id: number) {
    setBusy(true)
    setError(null)
    try {
      await mockConnectInstagram(id)
      setOauthBanner('Mock connected (INSTAGRAM_OAUTH_MOCK=true). Not a real Meta token.')
      await refresh()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Mock connect failed — set INSTAGRAM_OAUTH_MOCK=true on the server'
      )
    } finally {
      setBusy(false)
    }
  }

  async function handlePasteToken(id: number) {
    const access_token = (pasteTokenById[id] || '').trim()
    if (!access_token) {
      setError('Paste an Instagram user access token first')
      return
    }
    setBusy(true)
    setError(null)
    setOauthBanner(null)
    try {
      const { connection } = await connectInstagramWithToken(id, access_token)
      setPasteTokenById((m) => ({ ...m, [id]: '' }))
      setOauthBanner(
        `Connected${connection.ig_username ? `: @${connection.ig_username}` : ''} via pasted token (encrypted at rest).`
      )
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token connect failed')
    } finally {
      setBusy(false)
    }
  }

  async function loadIterations(postId: number) {
    try {
      const data = await listIterations(postId)
      setIterations(data.iterations)
      setMaxRevisions(data.max_revisions)
    } catch {
      setIterations([])
    }
  }

  useEffect(() => {
    if (!editing?.id || !open) {
      setIterations([])
      return
    }
    void loadIterations(editing.id)
  }, [editing?.id, open, editing?.revisions])

  // Lesson 10 — live timeline via SSE (poll fallback).
  useEffect(() => {
    if (selectedRunId == null) {
      setRunEvents([])
      setLiveRunMeta({})
      return
    }

    let cancelled = false
    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let afterSeq = 0

    const mergeEvents = (incoming: RunEvent[]) => {
      if (!incoming.length) return
      setRunEvents((prev) => {
        const bySeq = new Map(prev.map((e) => [e.seq, e]))
        for (const e of incoming) bySeq.set(e.seq, e)
        const next = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
        afterSeq = next.reduce((m, e) => Math.max(m, e.seq), afterSeq)
        return next
      })
    }

    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const startPollFallback = () => {
      if (pollTimer || cancelled) return
      setLiveRunMeta((m) => ({ ...m, live: false }))
      pollTimer = setInterval(() => {
        void (async () => {
          try {
            const { run, events } = await getRun(selectedRunId)
            if (cancelled) return
            setLiveRunMeta({ status: run.status, model: run.model, live: false })
            mergeEvents(events)
            if (run.status !== 'running') {
              stopPoll()
              void refresh()
            }
          } catch {
            /* keep trying briefly */
          }
        })()
      }, 1000)
    }

    ;(async () => {
      try {
        setRunDetailLoading(true)
        const { run, events } = await getRun(selectedRunId)
        if (cancelled) return
        setLiveRunMeta({ status: run.status, model: run.model, live: run.status === 'running' })
        mergeEvents(events)
        setRunDetailLoading(false)

        if (run.status !== 'running') return

        es = new EventSource(runEventsStreamUrl(selectedRunId, afterSeq))
        es.addEventListener('run_meta', (msg) => {
          try {
            const data = JSON.parse((msg as MessageEvent).data) as {
              status?: string
              model?: string | null
            }
            setLiveRunMeta((m) => ({
              ...m,
              status: data.status || m.status,
              model: data.model ?? m.model,
              live: true,
            }))
          } catch {
            /* ignore */
          }
        })
        es.addEventListener('run_event', (msg) => {
          try {
            const ev = JSON.parse((msg as MessageEvent).data) as RunEvent
            mergeEvents([ev])
          } catch {
            /* ignore */
          }
        })
        es.addEventListener('run_done', (msg) => {
          try {
            const data = JSON.parse((msg as MessageEvent).data) as {
              status?: string
            }
            setLiveRunMeta((m) => ({ ...m, status: data.status || m.status, live: false }))
          } catch {
            setLiveRunMeta((m) => ({ ...m, live: false }))
          }
          es?.close()
          void refresh()
        })
        es.onerror = () => {
          es?.close()
          es = null
          if (!cancelled) startPollFallback()
        }
      } catch (e) {
        if (!cancelled) {
          setRunDetailLoading(false)
          setError(e instanceof Error ? e.message : 'Failed to load run')
          startPollFallback()
        }
      }
    })()

    return () => {
      cancelled = true
      es?.close()
      stopPoll()
    }
  }, [selectedRunId, refresh])

  return (
    <PageShell
      brand={
        <>
          <Mark />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold tracking-tight">
              Content Agent
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              Instagram drafts · press check
            </div>
          </div>
        </>
      }
      nav={
        <>
          <NavTab active={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')}>
            Calendar
          </NavTab>
          <NavTab active={activeTab === 'queue'} onClick={() => setActiveTab('queue')}>
            Post queue
          </NavTab>
          <NavTab active={activeTab === 'brands'} onClick={() => setActiveTab('brands')}>
            Brands
          </NavTab>
          <NavTab active={activeTab === 'runs'} onClick={() => setActiveTab('runs')}>
            Agent runs
          </NavTab>
          <NavTab active={activeTab === 'connect'} onClick={() => setActiveTab('connect')}>
            Accounts
          </NavTab>
        </>
      }
      actions={
        <>
          {pendingCount > 0 && !statusFilter && (
            <span className="hidden items-center gap-1.5 rounded-sm border border-pending/25 bg-pending-soft px-2 py-1 text-[11px] font-semibold text-pending sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-pending" />
              {pendingCount} need OK
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={loading || busy}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setShowNew(true)}>
            New post
          </Button>
        </>
      }
    >
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-red-50 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {busy && (
        <div className="rounded-md border border-rule/30 bg-rule/5 px-3 py-2 text-sm text-foreground">
          Generating… agent runs can take 30–60s while LM Studio works.
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : activeTab === 'calendar' ? (
        <CalendarWeekPanel
          onOpenPost={(p) => void openPost(p)}
          onError={setError}
        />
      ) : activeTab === 'brands' ? (
        <BrandProfilesPanel onError={setError} />
      ) : activeTab === 'queue' ? (
        <div className="dash-in space-y-6">
          <div className="grid grid-cols-3 gap-3 border border-border bg-card px-4 py-3 sm:gap-8">
            <Metric label="In queue" value={posts.length} />
            <Metric label="Passed" value={approvedCount} tone="ok" />
            <Metric label="Needs OK" value={pendingCount} tone="pending" />
          </div>
          {publishedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {publishedCount} published · publish pipeline still stubbed
            </p>
          )}

          <Section title="Post queue">
            <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-3">
              {(
                [
                  ['', 'All'],
                  ['draft', 'Draft'],
                  ['pending_approval', 'Needs OK'],
                  ['changes_requested', 'Revise'],
                  ['needs_revision', 'Cap hit'],
                  ['approved', 'Passed'],
                  ['media_ready', 'Compose'],
                  ['staged', 'Staged'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  disabled={loading}
                  onClick={() => setStatusFilter(value)}
                  className={cn(
                    'rounded-sm px-2 py-1 text-[11px] font-semibold transition-colors',
                    statusFilter === value
                      ? 'bg-foreground text-background'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="mx-1 text-border">|</span>
              {(
                [
                  ['all', 'Any date'],
                  ['scheduled', 'Scheduled'],
                  ['unscheduled', 'Unscheduled'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={loading}
                  onClick={() => setScheduleFilter(value)}
                  className={cn(
                    'rounded-sm px-2 py-1 text-[11px] font-semibold transition-colors',
                    scheduleFilter === value
                      ? 'bg-rule/15 text-rule'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {visiblePosts.length === 0 ? (
              <Empty
                title={statusFilter ? 'Nothing in this filter' : 'No drafts on the sheet'}
                body={
                  statusFilter
                    ? 'Try All, or Refresh after the agent / approve actions.'
                    : 'Start with a topic. The agent fills hook, caption, hashtags, and media prompts for your OK. Refresh reloads from SQLite.'
                }
                action={
                  statusFilter ? (
                    <Button size="sm" variant="outline" onClick={() => setStatusFilter('')}>
                      Clear filter
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setShowNew(true)}>
                      New post
                    </Button>
                  )
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">#</TableHead>
                    <TableHead>Topic</TableHead>
                    <TableHead>Hook</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Revs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visiblePosts.map((post) => {
                    const tone = statusTone[post.status]
                    return (
                      <TableRow
                        key={post.id}
                        className="cursor-pointer"
                        onClick={() => void openPost(post)}
                      >
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {post.id}
                        </TableCell>
                        <TableCell className="max-w-[220px] font-medium">
                          <span className="line-clamp-1">{text(post.topic, 'Untitled')}</span>
                        </TableCell>
                        <TableCell className="max-w-[360px]">
                          <span className="line-clamp-1 text-muted-foreground">
                            {text(post.hook)}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-[10px] text-muted-foreground">
                          {post.scheduled_at
                            ? post.scheduled_at.slice(0, 16).replace('T', ' ')
                            : '—'}
                        </TableCell>
                        <TableCell>
                          <Badge className={tone.className}>{tone.label}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {post.revisions > 0 ? post.revisions : '—'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>
      ) : activeTab === 'runs' ? (
        <div className="dash-in grid gap-4 lg:grid-cols-5">
          <Section title="Recent runs" className="lg:col-span-2">
            {runs.length === 0 ? (
              <Empty
                title="No runs yet"
                body="Run the agent on a draft to open a durable timeline of decisions and observations."
              />
            ) : (
              <ul className="divide-y divide-border">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      className={cn(
                        'w-full px-4 py-3 text-left transition-colors hover:bg-muted/50',
                        selectedRunId === run.id && 'bg-rule/5'
                      )}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold">
                          Run {run.id}
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            · {run.kind}
                          </span>
                        </span>
                        <Badge
                          className={
                            run.status === 'succeeded'
                              ? 'bg-ok-soft text-ok'
                              : run.status === 'failed'
                                ? 'bg-red-50 text-destructive'
                                : 'bg-muted text-muted-foreground'
                          }
                        >
                          {run.status}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                        {run.goal}
                      </p>
                      <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                        post {run.post_id ?? '—'} · {run.started_at}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section
            title={selectedRunId ? `Activity · run ${selectedRunId}` : 'Activity'}
            className="lg:col-span-3"
          >
            {!selectedRunId ? (
              <Empty
                title="Select a run"
                body="Live steps stream over SSE while status is running."
              />
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                  <span>
                    model{' '}
                    <span className="font-mono text-foreground">
                      {liveRunMeta.model || '—'}
                    </span>
                  </span>
                  <span>·</span>
                  <span>
                    status{' '}
                    <span className="font-mono text-foreground">
                      {liveRunMeta.status || '—'}
                    </span>
                  </span>
                  {liveRunMeta.live && (
                    <span className="inline-flex items-center gap-1 font-semibold text-pending">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-pending" />
                      live
                    </span>
                  )}
                </div>
                {runDetailLoading && runEvents.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground">Loading events…</p>
                ) : runEvents.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground">
                    Waiting for first event…
                  </p>
                ) : (
                  <div className="max-h-[28rem] space-y-2 overflow-y-auto p-3 font-mono text-[11px]">
                    {runEvents.map((e) => (
                      <div
                        key={`${e.run_id}-${e.seq}`}
                        className="rounded-sm border border-border bg-background px-2.5 py-2"
                      >
                        <div className="font-semibold text-foreground">
                          <span className="text-rule">#{e.seq}</span> {e.type}
                          {e.type === 'step' &&
                            typeof (e.payload as { step?: string }).step === 'string' && (
                              <span className="ml-1.5 font-normal text-muted-foreground">
                                · {(e.payload as { step: string }).step}
                                {(e.payload as { status?: string }).status
                                  ? ` (${(e.payload as { status: string }).status})`
                                  : ''}
                              </span>
                            )}
                        </div>
                        <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
                          {JSON.stringify(redactPayload(e.payload), null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Section>
        </div>
      ) : (
        <div className="dash-in grid max-w-3xl gap-6">
          <Card>
            <CardContent className="space-y-4 pt-4">
              <div>
                <h2 className="text-sm font-semibold">Add Meta app credentials</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Saving App ID is <span className="font-medium text-foreground">configured</span>,
                  not connected. Browser OAuth needs a <strong>stable HTTPS</strong> callback Meta
                  accepts — quick tunnels often fail. For local: paste a token from Meta →
                  Instagram → API setup → <strong>Generate token</strong>.
                </p>
              </div>
              <Separator />
              {oauthNote && (
                <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {oauthNote}
                </p>
              )}
              {oauthBanner && (
                <div className="rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-sm text-ok">
                  {oauthBanner}
                </div>
              )}
              <form className="space-y-3" onSubmit={(e) => void handleCreateInstagram(e)}>
                <FormField label="Label (optional)">
                  <Input
                    value={igForm.account_id}
                    onChange={(e) => setIgForm((f) => ({ ...f, account_id: e.target.value }))}
                    placeholder="Leave blank — connect fills IG user id"
                    disabled={busy}
                  />
                </FormField>
                <FormField label="Instagram App ID">
                  <Input
                    value={igForm.app_id}
                    onChange={(e) => setIgForm((f) => ({ ...f, app_id: e.target.value }))}
                    placeholder="App ID"
                    required
                    disabled={busy}
                  />
                </FormField>
                <FormField label="App secret">
                  <Input
                    type="password"
                    value={igForm.client_secret}
                    onChange={(e) =>
                      setIgForm((f) => ({ ...f, client_secret: e.target.value }))
                    }
                    placeholder="••••••••"
                    required
                    disabled={busy}
                    autoComplete="off"
                  />
                </FormField>
                <FormField label="HTTPS redirect URI (browser OAuth only)">
                  <Input
                    value={igForm.redirect_uri}
                    onChange={(e) =>
                      setIgForm((f) => ({ ...f, redirect_uri: e.target.value }))
                    }
                    placeholder="https://your-domain/api/auth/instagram/callback"
                    disabled={busy}
                  />
                </FormField>
                <div className="flex justify-end pt-1">
                  <Button type="submit" size="sm" disabled={busy}>
                    Save credentials
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 pt-4">
              <div>
                <h2 className="text-sm font-semibold">Accounts</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Prefer <strong>Paste token</strong> locally. Browser OAuth only when you have a
                  real HTTPS callback Meta allows.
                </p>
              </div>
              <Separator />
              {connections.length === 0 ? (
                <Empty
                  title="No accounts stored"
                  body="Save Meta credentials above, then Connect with OAuth."
                />
              ) : (
                connections.map((c) => (
                  <div
                    key={c.id}
                    className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {c.ig_username ? `@${c.ig_username}` : c.account_id}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          id {c.account_id}
                          {c.page_id ? ` · page ${c.page_id}` : ''}
                          {c.updated_at ? ` · ${c.updated_at}` : ''}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            Default brand
                          </span>
                          <select
                            className="h-8 rounded-sm border border-border bg-card px-2 text-xs"
                            value={c.default_brand_profile_id ?? ''}
                            disabled={busy}
                            onChange={(e) => {
                              const v = e.target.value
                              void (async () => {
                                setBusy(true)
                                try {
                                  const { connection } = await updateInstagramConnection(c.id, {
                                    default_brand_profile_id: v ? Number(v) : null,
                                  })
                                  setConnections((prev) =>
                                    prev.map((x) => (x.id === c.id ? connection : x))
                                  )
                                } catch (err) {
                                  setError(
                                    err instanceof Error ? err.message : 'Failed to set brand'
                                  )
                                } finally {
                                  setBusy(false)
                                }
                              })()
                            }}
                          >
                            <option value="">None</option>
                            {brands.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <Badge
                        className={
                          c.status === 'connected'
                            ? 'bg-ok-soft text-ok'
                            : c.status === 'error' || c.status === 'disconnected'
                              ? 'bg-red-50 text-destructive'
                              : 'bg-muted text-muted-foreground'
                        }
                      >
                        {c.status}
                      </Badge>
                    </div>
                    {c.last_error && (
                      <p className="rounded-sm border border-destructive/25 bg-red-50 px-2 py-1.5 text-xs text-destructive">
                        {c.last_error}
                      </p>
                    )}
                    {c.status !== 'connected' && (
                      <div className="space-y-2">
                        <FormField label="Paste Instagram user access token">
                          <Input
                            type="password"
                            value={pasteTokenById[c.id] || ''}
                            onChange={(e) =>
                              setPasteTokenById((m) => ({ ...m, [c.id]: e.target.value }))
                            }
                            placeholder="From Meta → Generate token"
                            disabled={busy}
                            autoComplete="off"
                          />
                        </FormField>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void handlePasteToken(c.id)}
                        >
                          Connect with pasted token
                        </Button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {c.status !== 'connected' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            window.location.href = instagramOAuthStartUrl(c.id)
                          }}
                          title="Needs HTTPS redirect URI registered in Meta"
                        >
                          Browser OAuth
                        </Button>
                      )}
                      {c.status === 'connected' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void handleIgDisconnect(c.id)}
                        >
                          Disconnect
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleMockConnect(c.id)}
                        title="Requires INSTAGRAM_OAUTH_MOCK=true on server"
                      >
                        Mock connect
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleIgDelete(c.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New post</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Topic becomes the seed for the content pipeline.
            </p>
          </DialogHeader>
          <FormField label="Topic">
            <Input
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="5-minute morning routine"
              disabled={busy}
              autoFocus
            />
          </FormField>
          <FormField label="Background style">
            <p className="mb-2 text-xs text-muted-foreground">
              Steers Pexels keywords when the agent drafts media prompts.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {BACKGROUND_STYLES.map((s) => (
                <Button
                  key={s.id}
                  type="button"
                  size="sm"
                  variant={newBgStyle === s.id ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => setNewBgStyle(s.id)}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </FormField>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => handleCreatePost(false)}
            >
              Create draft
            </Button>
            <Button
              size="sm"
              disabled={busy || !newTopic.trim()}
              onClick={() => handleCreatePost(true)}
            >
              Create + run agent
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Post {editing?.id}</DialogTitle>
            {editing && (
              <Badge className={statusTone[editing.status].className}>
                {statusTone[editing.status].label}
              </Badge>
            )}
          </DialogHeader>
          {error && editing && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-red-50 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          {editing && (
            <div className="space-y-4">
              <div className="border border-border bg-muted/20">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-rule">
                    Plate meta
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setOverrideOpen((o) => !o)}
                    >
                      {overrideOpen ? 'Hide overrides' : 'Overrides'}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void savePostBrandMeta()}>
                      Save
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 p-3 sm:grid-cols-3">
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
                  <div className="space-y-2 border-t border-border px-3 py-3">
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
                  </div>
                )}
              </div>
              <FormField label="Topic">
                <Input value={text(editing.topic, '')} readOnly />
              </FormField>
              <FormField label="Hook">
                <p className="text-sm leading-relaxed">{text(editing.hook)}</p>
              </FormField>
              <FormField label="Caption">
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {text(editing.caption)}
                </p>
              </FormField>
              <FormField label="Hashtags">
                <div className="flex flex-wrap gap-1.5">
                  {text(editing.hashtags, '')
                    .split(/\s+/)
                    .filter(Boolean)
                    .map((tag) => (
                      <Badge key={tag} className="bg-muted text-muted-foreground">
                        {tag}
                      </Badge>
                    ))}
                  {!editing.hashtags?.trim() && (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </div>
              </FormField>
              <FormField label="Format">
                <Badge className="bg-muted text-muted-foreground uppercase">
                  {text(editing.format, 'feed')}
                </Badge>
              </FormField>
              <FormField label="Background style">
                {(editing.status === 'draft' ||
                  editing.status === 'changes_requested' ||
                  editing.status === 'pending_approval' ||
                  editing.status === 'approved') && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {BACKGROUND_STYLES.map((s) => (
                      <Button
                        key={s.id}
                        type="button"
                        size="sm"
                        variant={editing.background_style === s.id ? 'default' : 'outline'}
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            setBusy(true)
                            try {
                              const { post } = await patchPost(editing.id, {
                                background_style: s.id,
                              })
                              setEditing(post)
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Update failed')
                            } finally {
                              setBusy(false)
                            }
                          })()
                        }}
                      >
                        {s.label}
                      </Button>
                    ))}
                  </div>
                )}
                {!(
                  editing.status === 'draft' ||
                  editing.status === 'changes_requested' ||
                  editing.status === 'pending_approval' ||
                  editing.status === 'approved'
                ) && (
                  <Badge className="bg-muted text-muted-foreground">
                    {text(editing.background_style, '—')}
                  </Badge>
                )}
              </FormField>
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
                  className="min-h-[72px] w-full rounded-sm border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus-visible:border-rule"
                  value={imagePromptEdit}
                  disabled={busy}
                  onChange={(e) => setImagePromptEdit(e.target.value)}
                  placeholder="Describe the image to generate…"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Uses IMAGE_OPENAI_* — separate from LM Studio chat keys.
                </p>
              </FormField>
              <FormField label="Reel prompt">
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {text(editing.reel_prompt)}
                </p>
              </FormField>

              {(editing.status === 'pending_approval' ||
                editing.status === 'changes_requested') && (
                <FormField label="Change request">
                  <Input
                    value={changeComment}
                    onChange={(e) => setChangeComment(e.target.value)}
                    placeholder="What should the agent revise?"
                    disabled={busy}
                  />
                </FormField>
              )}

              <FormField
                label={`Revision history (${iterations.length}/${maxRevisions})`}
              >
                {iterations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No change requests yet.</p>
                ) : (
                  <ul className="max-h-40 space-y-2 overflow-y-auto border-t border-border pt-2">
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
              </FormField>

              <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                {(editing.status === 'draft' ||
                  editing.status === 'changes_requested') && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => handleAgentRun(editing.id)}
                  >
                    Run agent
                  </Button>
                )}
                {editing.status === 'pending_approval' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleRequestChanges(editing.id)}
                    >
                      Request changes
                    </Button>
                    <Button
                      variant="pending"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleApprove(editing.id)}
                    >
                      Approve
                    </Button>
                  </>
                )}
                {editing.status === 'needs_revision' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => handleRestart(editing.id)}
                  >
                    Restart to draft
                  </Button>
                )}
                {(editing.status === 'approved' ||
                  editing.status === 'media_generating' ||
                  editing.status === 'media_ready' ||
                  editing.status === 'staged') && (
                  <>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleFetchMedia(editing.id, 'openai')}
                      title={
                        editing.format === 'carousel'
                          ? 'Fills every carousel slide (per-slide briefs when available)'
                          : undefined
                      }
                    >
                      {editing.format === 'carousel'
                        ? editing.status === 'approved' || editing.status === 'media_generating'
                          ? 'Generate all slides (AI)'
                          : 'Regenerate all slides (AI)'
                        : editing.status === 'approved' || editing.status === 'media_generating'
                          ? 'Generate with AI'
                          : 'Regenerate with AI'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleFetchMedia(editing.id, 'pexels')}
                      title={
                        editing.format === 'carousel'
                          ? 'Fills every carousel slide from Pexels'
                          : undefined
                      }
                    >
                      {editing.format === 'carousel'
                        ? editing.status === 'approved' || editing.status === 'media_generating'
                          ? 'Generate all slides (Pexels)'
                          : 'Regenerate all slides (Pexels)'
                        : editing.status === 'approved' || editing.status === 'media_generating'
                          ? 'Generate with Pexels'
                          : 'Regenerate with Pexels'}
                    </Button>
                  </>
                )}
                {editing.status === 'staged' && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void handlePublishInstagram(editing.id)}
                  >
                    Publish to Instagram
                  </Button>
                )}
                {editing.status === 'published' && editing.instagram_media_id && (
                  <p className="w-full text-xs text-ok">
                    Published · media id {editing.instagram_media_id}
                  </p>
                )}
                {editing.status === 'failed' && editing.error && (
                  <div className="w-full space-y-2">
                    <p className="text-xs text-destructive">{editing.error}</p>
                    {editing.image_url && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handlePublishInstagram(editing.id)}
                        title="Retries from staged when R2 URL present"
                      >
                        Retry publish
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {(editing.status === 'media_ready' || editing.status === 'staged') && (
                <PostCanvasEditor
                  post={editing}
                  slides={editingSlides}
                  busy={busy}
                  onSaveSlideCanvas={async (slideId, canvasJson) => {
                    await patchPostSlide(editing.id, slideId, { canvas_json: canvasJson })
                  }}
                  onSavePostCanvas={async (canvasJson) => {
                    await patchPost(editing.id, { canvas_json: canvasJson })
                  }}
                  onAddSlide={async () => {
                    setBusy(true)
                    try {
                      const { slides } = await addPostSlide(editing.id)
                      setEditingSlides(slides)
                    } finally {
                      setBusy(false)
                    }
                  }}
                  onRemoveSlide={async (slideId) => {
                    setBusy(true)
                    try {
                      const { slides } = await removePostSlide(editing.id, slideId)
                      setEditingSlides(slides)
                    } finally {
                      setBusy(false)
                    }
                  }}
                  onFetchPexelsForSlide={async (slideId) => {
                    await handleFetchMedia(editing.id, 'pexels', slideId)
                  }}
                  onFetchAiForSlide={async (slideId) => {
                    await handleFetchMedia(editing.id, 'openai', slideId)
                  }}
                  onApproveMedia={async (payload) => {
                    setBusy(true)
                    setError(null)
                    try {
                      const { post, slides, note } = await approveMedia(editing.id, payload)
                      await refresh()
                      setEditing(post)
                      if (slides) setEditingSlides(slides)
                      if (note) setOauthBanner(note)
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Approve media failed')
                      throw e
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'ok' | 'pending'
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 font-mono text-2xl font-semibold tabular-nums tracking-tight',
          tone === 'ok' && 'text-ok',
          tone === 'pending' && 'text-pending',
          !tone && 'text-foreground'
        )}
      >
        {value}
      </div>
    </div>
  )
}

function Empty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-8">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  )
}
