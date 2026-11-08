import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { Idea, Post, PostFormat, PostSlide, CanvasDoc } from '@instagram-agent/shared'
import {
  statusLabel,
  statusToneFor,
} from '@instagram-agent/shared'
import {
  approvePost,
  approveMedia,
  getPost,
  listIterations,
  patchPost,
  requestChanges,
  listInstagramConnections,
  getPostReview,
  listPostVersions,
  diffPostVersions,
  listJobs,
  getJob,
  getRun,
  getPostInstagramInsights,
  getPostInstagramComments,
  agentRun,
  generateMedia,
  restartPost,
  studioAction,
  estimateCost,
  getIdea,
  updateIdea,
  type Iteration,
  type PostReviewData,
  type InstagramConnection,
  type PostVersionRow,
  type JobRow,
} from '../api'
import { InstagramPostPreview } from '../components/InstagramPostPreview'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'
import { resolveNextStep } from '../lib/post-studio-actions'
import { usePoll } from '../lib/use-poll'

// Status stepper definition
const STEPPER_STEPS = [
  { key: 'draft',          label: 'Draft' },
  { key: 'pending_approval', label: 'Needs OK' },
  { key: 'approved',       label: 'Copy ✓' },
  { key: 'media_ready',    label: 'Media ✓' },
  { key: 'staged',         label: 'Scheduled' },
  { key: 'published',      label: 'Live' },
]

const STATUS_ORDER: Record<string, number> = {
  draft: 0,
  changes_requested: 1,
  needs_revision: 1,
  pending_approval: 1,
  approved: 2,
  media_generating: 2,
  media_ready: 3,
  staged: 4,
  pending_upload: 4,
  publishing: 4,
  published: 5,
  failed: -1,
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

type Tab = 'copy' | 'notes' | 'history' | 'performance'

type RequestChangesTarget = 'hook' | 'caption' | 'visual' | 'hashtags'

const TARGET_LABELS: Record<RequestChangesTarget, string> = {
  hook: 'Hook',
  caption: 'Caption',
  visual: 'Visual',
  hashtags: 'Hashtags',
}

const QUICK_CHIPS: Record<RequestChangesTarget, string[]> = {
  hook: ['Too generic', 'Not on-brand', 'Try a question format', 'More specific'],
  caption: ['Too long', 'Needs stronger CTA', 'Tone off', 'Missing context'],
  visual: ['Wrong palette', 'Too busy', 'Needs brand colors', 'Better composition'],
  hashtags: ['Too generic', 'Mix niche + broad', 'Remove spam tags', 'Add location tags'],
}

function StatusStepper({ status }: { status: string }) {
  const currentIdx = STATUS_ORDER[status] ?? 0
  const isFailed = status === 'failed'

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-4 py-3 border-b border-border">
      {STEPPER_STEPS.map((step, i) => {
        const done = i < currentIdx
        const active = i === currentIdx && !isFailed
        return (
          <div key={step.key} className="flex items-center gap-1 shrink-0">
            <div
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                done && 'bg-primary/10 text-primary',
                active && 'bg-primary text-primary-foreground',
                !done && !active && 'text-muted-foreground'
              )}
            >
              {done && <span className="text-[10px]">✓</span>}
              {step.label}
            </div>
            {i < STEPPER_STEPS.length - 1 && (
              <div
                className={cn(
                  'w-4 h-px shrink-0',
                  done ? 'bg-primary/40' : 'bg-border'
                )}
              />
            )}
          </div>
        )
      })}
      {isFailed && (
        <span className="ml-2 px-2.5 py-1 rounded-full text-xs font-medium bg-destructive/10 text-destructive shrink-0">
          Failed
        </span>
      )}
    </div>
  )
}

function HookAlternates({
  post,
  onSwap,
  extra = [],
}: {
  post: Post
  onSwap: (hook: string) => void
  extra?: string[]
}) {
  let alts: string[] = []
  try {
    const v = JSON.parse(post.hook_alternates || '[]')
    if (Array.isArray(v)) alts = v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  } catch {
    /* ignore */
  }
  alts = [...extra.filter(Boolean), ...alts]
  if (alts.length === 0) return null

  return (
    <div className="mt-3">
      <p className="text-[11px] text-muted-foreground mb-1.5 font-medium">Alt hooks</p>
      <div className="flex flex-col gap-1">
        {alts.map((alt, i) => (
          <button
            key={i}
            onClick={() => onSwap(alt)}
            className="text-left text-xs px-2.5 py-1.5 rounded border border-dashed border-border hover:border-primary/60 hover:bg-accent transition-colors"
          >
            {alt}
          </button>
        ))}
      </div>
    </div>
  )
}

function ResearchBadge({
  mode,
  sources,
}: {
  mode?: 'web' | 'model' | 'none'
  sources: string[]
}) {
  if (mode === 'web' && sources.length > 0) {
    return (
      <span className="inline-flex items-center rounded-full border border-green-600/40 bg-green-600/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
        {sources.length} source{sources.length > 1 ? 's' : ''}
      </span>
    )
  }
  if (mode === 'model') {
    return (
      <span
        title="No live sources — model knowledge only"
        className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-500"
      >
        Unsourced
      </span>
    )
  }
  return null
}

function RubricScorecard({ review }: { review: PostReviewData }) {
  const pct = review.overall_score != null ? Math.round(review.overall_score * 100) : null
  return (
    <div className="border border-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Brand rubric</span>
        {pct != null && (
          <span
            className={cn(
              'text-xs font-bold',
              review.passed ? 'text-green-600 dark:text-green-400' : 'text-orange-500'
            )}
          >
            {pct}% {review.passed ? '✓' : ''}
          </span>
        )}
      </div>
      {review.scores && review.scores.length > 0 && (
        <div className="space-y-1">
          {review.scores.map((s) => (
            <div key={s.criterion_id} className="flex items-start gap-2 text-[11px]">
              <span
                className={cn(
                  'shrink-0 font-medium tabular-nums',
                  s.passed ? 'text-green-600 dark:text-green-400' : 'text-orange-500'
                )}
              >
                {Math.round(s.score * 100)}
              </span>
              <span className="text-muted-foreground">{s.note}</span>
            </div>
          ))}
        </div>
      )}
      {review.items && review.items.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {review.items.map((item, i) => (
            <div key={i} className="text-[11px] text-muted-foreground">
              <span
                className={cn(
                  'font-medium',
                  item.severity === 'critical' && 'text-destructive',
                  item.severity === 'warning' && 'text-orange-500'
                )}
              >
                [{item.target}]
              </span>{' '}
              {item.problem} → {item.fix}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RequestChangesModal({
  onSubmit,
  onClose,
  busy,
}: {
  onSubmit: (comment: string, target: RequestChangesTarget) => void
  onClose: () => void
  busy: boolean
}) {
  const [target, setTarget] = useState<RequestChangesTarget>('caption')
  const [chips, setChips] = useState<string[]>([])
  const [text, setText] = useState('')

  const composedComment = useMemo(() => {
    const parts: string[] = []
    if (chips.length > 0) parts.push(chips.join(', '))
    if (text.trim()) parts.push(text.trim())
    return parts.join('. ')
  }, [chips, text])

  function toggleChip(chip: string) {
    setChips((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip]
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div className="bg-background border border-border rounded-xl shadow-xl w-full max-w-md p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Request changes</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Target picker */}
        <div className="flex gap-1.5 flex-wrap">
          {(Object.keys(TARGET_LABELS) as RequestChangesTarget[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTarget(t); setChips([]) }}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                target === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:border-primary/60'
              )}
            >
              {TARGET_LABELS[t]}
            </button>
          ))}
        </div>

        {/* Quick chips */}
        <div className="flex gap-1.5 flex-wrap">
          {QUICK_CHIPS[target].map((chip) => (
            <button
              key={chip}
              onClick={() => toggleChip(chip)}
              className={cn(
                'px-2 py-0.5 rounded text-[11px] border transition-colors',
                chips.includes(chip)
                  ? 'bg-accent border-primary/60 text-foreground'
                  : 'border-border text-muted-foreground hover:border-border/80'
              )}
            >
              {chip}
            </button>
          ))}
        </div>

        {/* Free-form text */}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Describe what needs to change in the ${TARGET_LABELS[target].toLowerCase()}…`}
          rows={3}
          className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        />

        {/* Preview */}
        {composedComment && (
          <p className="text-[11px] text-muted-foreground italic truncate">
            → {composedComment}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => composedComment && onSubmit(composedComment, target)}
            disabled={busy || !composedComment}
          >
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function PostScreenById({ id }: { id: number }) {
  const navigate = useNavigate()

  const [post, setPost] = useState<Post | null>(null)
  const [slides, setSlides] = useState<PostSlide[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [connections, setConnections] = useState<InstagramConnection[]>([])
  const [review, setReview] = useState<PostReviewData | null>(null)
  const [iterations, setIterations] = useState<Iteration[]>([])
  const [versions, setVersions] = useState<PostVersionRow[]>([])
  const [versionDiff, setVersionDiff] = useState<Record<string, { from: unknown; to: unknown }> | null>(null)
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [tab, setTab] = useState<Tab>('copy')
  const [busy, setBusy] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [idea, setIdea] = useState<Idea | null>(null)
  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const [activeJobId, setActiveJobId] = useState<number | null>(null)
  const [extraAlternates, setExtraAlternates] = useState<string[]>([])
  const [agentCost, setAgentCost] = useState<number | null>(null)
  const [mediaCost, setMediaCost] = useState<number | null>(null)
  const [perfMetrics, setPerfMetrics] = useState<Record<string, number> | null>(null)
  const [perfNote, setPerfNote] = useState<string | null>(null)
  const [perfComments, setPerfComments] = useState<
    Array<{ id: string; text?: string; username?: string }>
  >([])
  const [perfBusy, setPerfBusy] = useState(false)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [frameH, setFrameH] = useState(420)

  useEffect(() => {
    void listInstagramConnections()
      .then((r) => setConnections(r.connections ?? []))
      .catch(() => {})
  }, [])

  const reload = useCallback(async () => {
    const [postRes, reviewRes, itersRes, versRes, jobsRes] = await Promise.all([
      getPost(id),
      getPostReview(id).catch(() => ({ review: null })),
      listIterations(id).catch(() => ({ iterations: [], revisions: 0, max_revisions: 5 })),
      listPostVersions(id).catch(() => ({ versions: [], proposed: [] })),
      listJobs({ post_id: id, limit: 5 }).catch(() => ({ jobs: [] })),
    ])
    setPost(postRes.post)
    setSlides(postRes.slides || [])
    setReview(reviewRes.review)
    setIterations(itersRes.iterations)
    setVersions(versRes.versions || [])
    setJobs(jobsRes.jobs || [])
    const vers = versRes.versions || []
    if (vers.length >= 2) {
      const diff = await diffPostVersions(id, vers[1].version, vers[0].version).catch(() => null)
      setVersionDiff(diff?.changed ?? null)
    } else {
      setVersionDiff(null)
    }
    if (postRes.post.idea_id) {
      const ideaRes = await getIdea(postRes.post.idea_id).catch(() => null)
      setIdea(ideaRes?.idea ?? null)
    } else {
      setIdea(null)
    }
    const liveJobs = (jobsRes.jobs || []).filter(
      (j) => j.status === 'pending' || j.status === 'running',
    )
    const mediaJob = liveJobs.find((j) => j.kind === 'generate_media')
    const agentJob = liveJobs.find((j) => j.kind === 'agent_run')
    if (mediaJob) setActiveJobId(mediaJob.id)
    if (agentJob?.run_id) setActiveRunId(Number(agentJob.run_id))
  }, [id])

  useEffect(() => {
    void reload().catch((e) => toast.error(e instanceof Error ? e.message : 'Load failed'))
  }, [reload])

  useEffect(() => {
    void estimateCost({ kind: 'agent_run' })
      .then((r) => setAgentCost(r.estimate))
      .catch(() => setAgentCost(null))
  }, [])

  useEffect(() => {
    if (!post) return
    const kind = post.format === 'reel' ? 'generate_reel' : 'generate_image'
    void estimateCost({ kind })
      .then((r) => setMediaCost(r.estimate))
      .catch(() => setMediaCost(null))
  }, [post?.format, post])

  const runPollFn = useMemo(
    () => (activeRunId != null ? () => getRun(activeRunId) : null),
    [activeRunId],
  )
  const { value: runPoll } = usePoll(
    runPollFn,
    (d) => d.run.status !== 'running' && d.run.status !== 'pending',
    (d) => {
      setActiveRunId(null)
      if (d.run.status === 'failed') toast.error(d.run.error || 'Run failed')
      else toast.success('Draft ready')
      void reload()
    },
  )

  const jobPollFn = useMemo(
    () => (activeJobId != null ? () => getJob(activeJobId) : null),
    [activeJobId],
  )
  usePoll(
    jobPollFn,
    (j) => j.job.status === 'done' || j.job.status === 'failed',
    (j) => {
      setActiveJobId(null)
      if (j.job.status === 'failed') {
        const err = j.job.error || 'Job failed'
        toast.error(
          err.includes('needs_budget_approval')
            ? 'Over budget — raise the cap in Settings'
            : err,
        )
      } else toast.success('Visual ready')
      void reload()
    },
  )

  const polling = activeRunId != null || activeJobId != null

  useEffect(() => {
    if (tab !== 'performance' || !post || post.status !== 'published') return
    setPerfBusy(true)
    void Promise.all([
      getPostInstagramInsights(id).catch((e) => {
        toast.error(e instanceof Error ? e.message : 'Insights failed')
        return null
      }),
      getPostInstagramComments(id).catch(() => null),
    ])
      .then(([insights, comments]) => {
        if (insights) {
          setPerfMetrics(insights.metrics || {})
          setPerfNote(insights.note ?? null)
        }
        if (comments) setPerfComments(comments.comments || [])
      })
      .finally(() => setPerfBusy(false))
  }, [tab, post?.status, id, post])

  const format = (post?.format || 'feed') as PostFormat
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

  async function handleApproveCopy() {
    if (!post) return
    setBusy(true)
    try {
      const res = await approvePost(id)
      setPost(res.post)
      toast.success('Approved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleApproveMedia() {
    if (!post) return
    setBusy(true)
    try {
      const res = await approveMedia(id, {
        stage_reel: format === 'reel' || undefined,
      })
      setPost(res.post)
      if (res.slides) setSlides(res.slides)
      toast.success('Media approved')
      void reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Approve media failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleRequestChanges(comment: string, target: RequestChangesTarget) {
    setBusy(true)
    try {
      const res = await requestChanges(id, comment, { target, rerun: true })
      setPost(res.post)
      setComposerOpen(false)
      if (res.run_id) setActiveRunId(res.run_id)
      if (res.note) toast.message(res.note)
      if (res.rerun_error) toast.message(res.rerun_error)
      else if (!res.run_id) toast.success('Changes requested')
      void reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleWriteDraft() {
    setBusy(true)
    try {
      const res = await agentRun(id)
      if (res.run_id) setActiveRunId(res.run_id)
      toast.message(res.note || 'Writing…')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Write draft failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleTryHooks() {
    setBusy(true)
    try {
      const res = await studioAction(id, 'alternate-hooks')
      const hooks = (res as { hooks?: string[] }).hooks || []
      setExtraAlternates((prev) => [...hooks, ...prev])
      toast.success(`${hooks.length} new hooks`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try hooks failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleGenerateVisual() {
    setBusy(true)
    try {
      const res = await generateMedia(id)
      if (res.job_id) setActiveJobId(res.job_id)
      else void reload()
      toast.message(res.note || 'Generating visual…')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generate visual failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleSwapHook(hook: string) {
    if (!post) return
    setBusy(true)
    try {
      const res = await patchPost(id, { hook })
      setPost(res.post)
      toast.success('Hook updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Patch failed')
    } finally {
      setBusy(false)
    }
  }

  if (!post) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading…
      </div>
    )
  }

  const statusTone = statusToneFor(post.status)
  const nextStep = resolveNextStep(post, slides)
  const actionsDisabled = busy || polling
  const costSuffix = (n: number | null) =>
    n != null ? ` · ~$${n.toFixed(2)}` : ''
  const lastRunStep = (() => {
    const events = runPoll?.events || []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev?.type === 'step') {
        const payload = ev.payload as { step?: string } | undefined
        if (payload?.step) return payload.step
      }
    }
    return null
  })()

  const agentOutput: {
    notes?: string
    research?: string
    research_mode?: 'web' | 'model' | 'none'
    research_sources?: string[]
  } | null = (() => {
    if (!post.agent_output) return null
    try {
      return JSON.parse(post.agent_output) as typeof agentOutput
    } catch {
      return null
    }
  })()

  const researchMode = agentOutput?.research_mode
  const researchSources = agentOutput?.research_sources ?? []

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border shrink-0">
        <button
          onClick={() => void navigate({ to: '/inbox' })}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back
        </button>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium truncate">{post.topic || `Post #${post.id}`}</span>
        </div>
        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full font-medium',
            statusTone === 'positive' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
            statusTone === 'pending' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            statusTone === 'negative' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
            (statusTone === 'info' || statusTone === 'draft' || statusTone === 'neutral') && 'bg-muted text-muted-foreground'
          )}
        >
          {statusLabel(post.status)}
        </span>
        {nextStep.info && (
          <span className="text-[11px] text-muted-foreground">{nextStep.info}</span>
        )}
      </div>

      {/* Status stepper */}
      <StatusStepper status={post.status} />

      {(activeRunId != null || activeJobId != null) && (
        <div
          className="border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
          data-testid={activeRunId != null ? 'run-progress' : 'job-progress'}
        >
          {activeRunId != null
            ? `Writing…${lastRunStep ? ` · ${lastRunStep}` : ''}`
            : 'Generating visual…'}
        </div>
      )}

      {/* Main two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — Preview */}
        <div className="flex flex-col items-center justify-start p-4 gap-3 border-r border-border w-[340px] shrink-0 overflow-y-auto">
          <div className="w-full" ref={frameRef}>
            <InstagramPostPreview
              post={post}
              format={format}
              slides={slides}
              activeIdx={activeIdx}
              onActiveIdx={setActiveIdx}
              doc={doc}
              displayUrl={displayUrl}
              username={username}
              frameH={frameH}
              onFrameRef={(el) => {
                if (el) setFrameH(el.getBoundingClientRect().width * (format === 'reel' ? 16/9 : 5/4))
              }}
            />
          </div>
          {post.error && (
            <div className="w-full text-[11px] text-destructive bg-destructive/10 rounded p-2 border border-destructive/20">
              {post.error}
            </div>
          )}
        </div>

        {/* Right — Tabs */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          {idea && (
            <div className="border-b border-border px-4 py-3 space-y-2 shrink-0" data-testid="idea-panel">
              {idea.angle && (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Angle:</span> {idea.angle}
                </p>
              )}
              {idea.why && (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Why:</span> {idea.why}
                </p>
              )}
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Hook sketches</p>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="chosen_hook"
                    checked={idea.chosen_hook == null}
                    disabled={
                      actionsDisabled ||
                      (post.status !== 'draft' && post.status !== 'changes_requested')
                    }
                    onChange={() =>
                      void updateIdea(idea.id, { chosen_hook: null })
                        .then((r) => setIdea(r.idea))
                        .catch((e: Error) => toast.error(e.message))
                    }
                  />
                  Let the writer choose
                </label>
                {idea.hooks.map((h) => (
                  <label key={h} className="flex items-center gap-2 text-xs">
                    <input
                      type="radio"
                      name="chosen_hook"
                      checked={idea.chosen_hook === h}
                      disabled={
                        actionsDisabled ||
                        (post.status !== 'draft' && post.status !== 'changes_requested')
                      }
                      onChange={() =>
                        void updateIdea(idea.id, { chosen_hook: h })
                          .then((r) => setIdea(r.idea))
                          .catch((e: Error) => toast.error(e.message))
                      }
                    />
                    {h}
                  </label>
                ))}
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Direction for the writer
                </label>
                <textarea
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                  rows={2}
                  defaultValue={idea.direction || ''}
                  disabled={
                    actionsDisabled ||
                    (post.status !== 'draft' && post.status !== 'changes_requested')
                  }
                  onBlur={(e) => {
                    const direction = e.target.value
                    if (direction === (idea.direction || '')) return
                    void updateIdea(idea.id, { direction })
                      .then((r) => setIdea(r.idea))
                      .catch((err: Error) => toast.error(err.message))
                  }}
                />
              </div>
            </div>
          )}
          {/* Tab bar */}
          <div className="flex border-b border-border shrink-0">
            {([
              'copy',
              'notes',
              'history',
              ...(post.status === 'published' ? (['performance'] as const) : []),
            ] as Tab[]).map((t) => (
              <button
                key={t}
                data-testid={t === 'performance' ? 'tab-performance' : undefined}
                onClick={() => setTab(t)}
                className={cn(
                  'px-4 py-2.5 text-xs font-medium border-b-2 transition-colors capitalize',
                  tab === t
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t === 'notes'
                  ? 'Agent notes'
                  : t === 'history'
                    ? 'History'
                    : t === 'performance'
                      ? 'Performance'
                      : 'Copy'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {tab === 'copy' && (
              <>
                {/* Hook */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Hook</p>
                    <ResearchBadge mode={researchMode} sources={researchSources} />
                  </div>
                  <p className="text-sm">{post.hook || <span className="text-muted-foreground italic">No hook</span>}</p>
                  <HookAlternates post={post} onSwap={handleSwapHook} extra={extraAlternates} />
                </div>

                {/* Caption */}
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Caption</p>
                  <p className="text-sm whitespace-pre-wrap">{post.caption || <span className="text-muted-foreground italic">No caption</span>}</p>
                </div>

                {/* Hashtags */}
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Hashtags</p>
                  <p className="text-sm text-muted-foreground break-words">{post.hashtags || '—'}</p>
                </div>

                {/* Rubric */}
                {review && <RubricScorecard review={review} />}
              </>
            )}

            {tab === 'notes' && (
              <>
                {review && <RubricScorecard review={review} />}
                {agentOutput?.notes && (
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Agent notes</p>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{agentOutput.notes}</p>
                  </div>
                )}
                {agentOutput?.research && (
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Research</p>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{agentOutput.research}</p>
                  </div>
                )}
                {researchMode && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Sources</p>
                      <ResearchBadge mode={researchMode} sources={researchSources} />
                    </div>
                    {researchSources.length > 0 ? (
                      <ul className="space-y-1">
                        {researchSources.map((s, i) => (
                          <li key={i} className="text-xs text-muted-foreground break-words">{s}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">
                        {researchMode === 'model' ? 'Written from model knowledge, no live sources.' : 'No sources recorded.'}
                      </p>
                    )}
                  </div>
                )}
                {!review && !agentOutput && (
                  <p className="text-sm text-muted-foreground italic">No agent notes yet.</p>
                )}
              </>
            )}

            {tab === 'history' && (
              <>
                {jobs.some((j) => j.status === 'pending' || j.status === 'running') && (
                  <div className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                    Job in progress:{' '}
                    {jobs
                      .filter((j) => j.status === 'pending' || j.status === 'running')
                      .map((j) => `${j.kind} (#${j.id}, ${j.status})`)
                      .join(' · ')}
                  </div>
                )}
                {jobs.some((j) => j.status === 'failed' && j.error?.includes('needs_budget_approval')) && (
                  <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    Budget cap reached — needs budget approval before this paid job can run.
                  </div>
                )}
                {versions.length > 0 && (
                  <div className="mb-4 space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Versions
                    </p>
                    <ul className="space-y-1 text-sm">
                      {versions.slice(0, 8).map((v) => (
                        <li key={v.id} className="flex justify-between gap-2 text-muted-foreground">
                          <span>
                            v{v.version}
                            {v.actor_name ? ` · ${v.actor_name}` : ''}
                            {v.actor_kind ? ` (${v.actor_kind})` : ''}
                          </span>
                          <span className="text-[11px]">
                            {new Date(v.created_at).toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {versionDiff && Object.keys(versionDiff).length > 0 && (
                      <div className="mt-2 rounded-md border border-border p-2">
                        <p className="mb-1 text-xs font-medium">Latest diff</p>
                        <ul className="space-y-1 text-[11px] text-muted-foreground">
                          {Object.entries(versionDiff)
                            .slice(0, 12)
                            .map(([key, ch]) => (
                              <li key={key}>
                                <span className="font-medium text-foreground">{key}</span>:{' '}
                                {JSON.stringify(ch.from)} → {JSON.stringify(ch.to)}
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                {iterations.length === 0 && versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No revision history yet.</p>
                ) : iterations.length > 0 ? (
                  <div className="space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Change requests
                    </p>
                    {iterations.map((iter) => (
                      <div key={iter.id} className="border border-border rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium">{iter.author}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {new Date(iter.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">{iter.comment}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}

            {tab === 'performance' && post.status === 'published' && (
              <div className="space-y-4" data-testid="performance-panel">
                <p className="text-[11px] text-muted-foreground">
                  Data delayed up to 48h · Instagram reporting can still adjust.
                </p>
                {perfBusy && (
                  <p className="text-sm text-muted-foreground">Loading performance…</p>
                )}
                {perfMetrics && (
                  <ul className="grid grid-cols-2 gap-2 text-sm">
                    {(
                      [
                        ['reach', 'Reach'],
                        ['views', 'Views'],
                        ['saved', 'Saves'],
                        ['shares', 'Shares'],
                        ['comments', 'Comments'],
                        ['likes', 'Likes'],
                      ] as const
                    ).map(([key, label]) => (
                      <li
                        key={key}
                        className="rounded-md border border-border px-3 py-2"
                      >
                        <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
                        <p className="font-semibold tabular-nums">
                          {perfMetrics[key] != null ? perfMetrics[key].toLocaleString() : '—'}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {perfNote && (
                  <p className="text-[11px] text-muted-foreground">{perfNote}</p>
                )}
                {post.instagram_permalink && (
                  <a
                    href={post.instagram_permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-primary underline"
                  >
                    Open on Instagram
                  </a>
                )}
                {perfComments.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      Recent comments
                    </p>
                    <ul className="space-y-2">
                      {perfComments.slice(0, 8).map((c) => (
                        <li key={c.id} className="text-sm text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {c.username || 'user'}
                          </span>
                          : {c.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action bar */}
          {(nextStep.primary || nextStep.secondary.length > 0) && (
            <div className="border-t border-border p-3 flex flex-wrap gap-2 justify-end shrink-0">
              {nextStep.secondary.map((a) => (
                <Button
                  key={a.kind}
                  variant="outline"
                  size="sm"
                  title={a.title}
                  data-testid={
                    a.kind === 'revise_with_notes'
                      ? 'revise-with-notes'
                      : a.kind === 'try_hooks'
                        ? 'try-hooks'
                        : a.kind === 'open_studio'
                          ? 'open-studio'
                          : a.kind === 'regenerate_visual'
                            ? 'regenerate-visual'
                            : a.kind === 'restart_draft'
                              ? 'restart-draft'
                              : undefined
                  }
                  disabled={actionsDisabled || a.disabled}
                  onClick={() => {
                    if (a.kind === 'revise_with_notes') setComposerOpen(true)
                    else if (a.kind === 'try_hooks') void handleTryHooks()
                    else if (a.kind === 'open_studio') {
                      void navigate({ to: '/studio/$postId', params: { postId: String(id) } })
                    } else if (a.kind === 'regenerate_visual') void handleGenerateVisual()
                    else if (a.kind === 'restart_draft') {
                      void restartPost(id, { clear: false })
                        .then(() => reload())
                        .catch((e: Error) => toast.error(e.message))
                    }
                  }}
                >
                  {a.label}
                  {a.kind === 'regenerate_visual' ? costSuffix(mediaCost) : ''}
                </Button>
              ))}
              {nextStep.primary && (
                <Button
                  size="sm"
                  title={nextStep.primary.title}
                  data-testid={
                    nextStep.primary.kind === 'approve_copy'
                      ? 'approve-copy'
                      : nextStep.primary.kind === 'approve_visual'
                        ? 'approve-media'
                        : nextStep.primary.kind === 'write_draft'
                          ? 'write-draft'
                          : nextStep.primary.kind === 'rewrite_draft'
                            ? 'rewrite-draft'
                            : nextStep.primary.kind === 'generate_visual'
                              ? 'generate-visual'
                              : undefined
                  }
                  disabled={actionsDisabled || nextStep.primary.disabled}
                  onClick={() => {
                    const k = nextStep.primary!.kind
                    if (k === 'approve_copy') void handleApproveCopy()
                    else if (k === 'approve_visual') void handleApproveMedia()
                    else if (k === 'write_draft' || k === 'rewrite_draft') void handleWriteDraft()
                    else if (k === 'generate_visual') void handleGenerateVisual()
                  }}
                >
                  {nextStep.primary.label}
                  {nextStep.primary.kind === 'write_draft' ||
                  nextStep.primary.kind === 'rewrite_draft'
                    ? costSuffix(agentCost)
                    : nextStep.primary.kind === 'generate_visual'
                      ? costSuffix(mediaCost)
                      : ''}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Request changes modal */}
      {composerOpen && (
        <RequestChangesModal
          onSubmit={(comment, target) => void handleRequestChanges(comment, target)}
          onClose={() => setComposerOpen(false)}
          busy={busy}
        />
      )}
    </div>
  )
}

/** Route entry point — reads postId from URL params. */
export function PostScreen({ inlinePostId }: { inlinePostId?: number } = {}) {
  if (inlinePostId != null) {
    return <PostScreenById id={inlinePostId} />
  }
  return <PostScreenRoute />
}

function PostScreenRoute() {
  const { postId } = useParams({ from: '/shell/posts/$postId' })
  return <PostScreenById id={Number(postId)} />
}
