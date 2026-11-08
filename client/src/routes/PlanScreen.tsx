import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Star, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Idea } from '@instagram-agent/shared'
import {
  listBrandProfiles,
  listIdeas,
  generateIdeas,
  createIdea,
  updateIdea,
  scheduleIdea,
  listCalendar,
  listInstagramConnections,
  estimateCost,
} from '../api'
import { mondayOf, isoDay, addDays } from '../lib/week'
import { cn } from '../lib/utils'

type Tab = 'board' | 'shortlist' | 'dismissed'

const TAB_LABEL: Record<Tab, string> = {
  board: 'Board',
  shortlist: 'Shortlist',
  dismissed: 'Dismissed',
}

function FormatGlyph({ format }: { format?: string }) {
  const f = (format || 'feed').toLowerCase()
  if (f === 'reel') {
    return (
      <svg width="8" height="14" viewBox="0 0 8 14" fill="none" className="shrink-0" aria-hidden>
        <rect x="0.5" y="0.5" width="7" height="13" rx="1" stroke="currentColor" strokeWidth="1" />
      </svg>
    )
  }
  if (f === 'carousel') {
    return (
      <svg width="14" height="12" viewBox="0 0 14 12" fill="none" className="shrink-0" aria-hidden>
        <rect x="0.5" y="2.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1" />
        <rect x="4.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1" fill="var(--surface)" />
      </svg>
    )
  }
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" className="shrink-0" aria-hidden>
      <rect x="0.5" y="0.5" width="9" height="11" rx="1" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

const fieldClass =
  'h-8 rounded-[var(--radius-control)] border bg-[var(--surface)] px-2 text-sm text-[var(--text)] placeholder:text-[var(--faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2'
const fieldStyle = { borderColor: 'var(--control)' } as const

const chromeBtnClass =
  'h-8 px-3 text-sm rounded-[var(--radius-control)] border transition-colors hover:bg-[var(--raised)] text-[var(--muted)] disabled:opacity-45'
const accentBtnClass =
  'h-8 px-3 text-sm rounded-[var(--radius-control)] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45'

export function PlanScreen() {
  const qc = useQueryClient()
  const [brandId, setBrandId] = useState<number | null>(null)
  const [accountId, setAccountId] = useState('')
  const [tab, setTab] = useState<Tab>('board')
  const [steer, setSteer] = useState('')
  const [pillar, setPillar] = useState('')
  const [format, setFormat] = useState('')
  const [count, setCount] = useState(8)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTopic, setManualTopic] = useState('')
  const [pendingRiffIds, setPendingRiffIds] = useState<Set<number>>(() => new Set())

  const brandsQ = useQuery({ queryKey: ['brands'], queryFn: listBrandProfiles })
  const brands = brandsQ.data?.brands ?? []
  const effectiveBrandId = brandId ?? brands[0]?.id ?? null
  const brand = brands.find((b) => b.id === effectiveBrandId) ?? null

  const connQ = useQuery({
    queryKey: ['instagram-connections'],
    queryFn: listInstagramConnections,
  })
  const connections = connQ.data?.connections ?? []

  const weekStart = useMemo(() => mondayOf(new Date()), [])
  const from = isoDay(weekStart)
  const to = isoDay(addDays(weekStart, 7))
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  )

  const ideasStatus = tab === 'board' ? 'board' : tab === 'shortlist' ? 'shortlisted' : 'dismissed'
  const ideasQ = useQuery({
    queryKey: ['ideas', effectiveBrandId, ideasStatus],
    queryFn: () => listIdeas(effectiveBrandId!, ideasStatus),
    enabled: effectiveBrandId != null,
  })
  const calQ = useQuery({
    queryKey: ['calendar', from, to, effectiveBrandId, accountId],
    queryFn: () =>
      listCalendar({
        from,
        to,
        brand_profile_id: effectiveBrandId ?? undefined,
        account_id: accountId || undefined,
      }),
    enabled: effectiveBrandId != null,
  })
  const estimateQ = useQuery({
    queryKey: ['estimate', 'ideas'],
    queryFn: () => estimateCost({ kind: 'ideas' }),
  })

  const boardCountQ = useQuery({
    queryKey: ['ideas', effectiveBrandId, 'board'],
    queryFn: () => listIdeas(effectiveBrandId!, 'board'),
    enabled: effectiveBrandId != null,
  })
  const shortlistCountQ = useQuery({
    queryKey: ['ideas', effectiveBrandId, 'shortlisted'],
    queryFn: () => listIdeas(effectiveBrandId!, 'shortlisted'),
    enabled: effectiveBrandId != null,
  })
  const dismissedCountQ = useQuery({
    queryKey: ['ideas', effectiveBrandId, 'dismissed'],
    queryFn: () => listIdeas(effectiveBrandId!, 'dismissed'),
    enabled: effectiveBrandId != null,
  })
  const tabCounts: Record<Tab, number> = {
    board: boardCountQ.data?.ideas.length ?? 0,
    shortlist: shortlistCountQ.data?.ideas.length ?? 0,
    dismissed: dismissedCountQ.data?.ideas.length ?? 0,
  }

  const ideas = ideasQ.data?.ideas ?? []
  const plannedCount = calQ.data?.posts.length ?? 0

  const topicById = useMemo(() => {
    const m = new Map<number, string>()
    for (const list of [
      ideas,
      boardCountQ.data?.ideas ?? [],
      shortlistCountQ.data?.ideas ?? [],
    ]) {
      for (const idea of list) m.set(idea.id, idea.topic)
    }
    return m
  }, [ideas, boardCountQ.data?.ideas, shortlistCountQ.data?.ideas])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['ideas'] })
    void qc.invalidateQueries({ queryKey: ['calendar'] })
    void qc.invalidateQueries({ queryKey: ['posts'] })
  }

  const generateMut = useMutation({
    mutationFn: () =>
      generateIdeas(effectiveBrandId!, {
        count,
        steer: steer.trim() || undefined,
        pillar: pillar || undefined,
        format: format || undefined,
      }),
    onSuccess: (r) => {
      invalidate()
      const msg =
        r.dropped > 0
          ? `${r.ideas.length} ideas (${r.dropped} skipped as repeats)`
          : `${r.ideas.length} ideas`
      if (r.ideas.length === 0 && r.dropped > 0) {
        toast.message('All ideas repeated past content — try a different steer')
      } else toast.success(msg)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const createMut = useMutation({
    mutationFn: () => createIdea(effectiveBrandId!, { topic: manualTopic.trim() }),
    onSuccess: () => {
      setManualTopic('')
      setManualOpen(false)
      invalidate()
      toast.success('Idea added')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const riffMut = useMutation({
    mutationFn: (ideaId: number) =>
      generateIdeas(effectiveBrandId!, { like_idea_id: ideaId }),
    onMutate: (ideaId) => {
      setPendingRiffIds((prev) => new Set(prev).add(ideaId))
    },
    onSuccess: (r) => {
      invalidate()
      toast.success(`${r.ideas.length} riffs`)
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: (_data, _err, ideaId) => {
      setPendingRiffIds((prev) => {
        const next = new Set(prev)
        next.delete(ideaId)
        return next
      })
    },
  })

  const batches = useMemo(() => {
    const map = new Map<string, Idea[]>()
    for (const idea of ideas) {
      const key =
        idea.source === 'manual'
          ? `manual:${idea.id}`
          : idea.batch_id || `solo:${idea.id}`
      const arr = map.get(key) || []
      arr.push(idea)
      map.set(key, arr)
    }
    return [...map.entries()]
  }, [ideas])

  const costLabel =
    estimateQ.data?.estimate != null
      ? ` · ~$${estimateQ.data.estimate.toFixed(2)}`
      : ''

  if (!effectiveBrandId) {
    return (
      <div className="p-8 text-sm text-[var(--muted)]" style={{ background: 'var(--ground)' }}>
        Create a brand first —{' '}
        <Link to="/setup" className="font-medium text-[var(--accent)] hover:underline">
          Setup
        </Link>
      </div>
    )
  }

  const postsPerWeek = brand?.posts_per_week
  const cadenceText =
    postsPerWeek != null
      ? `${plannedCount} of ${postsPerWeek} this week`
      : `${plannedCount} planned this week`

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--ground)' }}>
      {/* Header */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface)',
          minHeight: 52,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <span className="shrink-0 text-[13px] font-semibold text-[var(--text)]">Plan</span>

        {brands.length > 0 && (
          <select
            className={fieldClass}
            style={fieldStyle}
            value={effectiveBrandId}
            onChange={(e) => setBrandId(Number(e.target.value))}
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}

        {connections.length > 1 && (
          <select
            className={fieldClass}
            style={fieldStyle}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">Any account</option>
            {connections.map((c) => (
              <option key={c.id} value={c.account_id}>
                {c.ig_username ? `@${c.ig_username}` : c.account_id}
              </option>
            ))}
          </select>
        )}

        <div className="ml-auto">
          <Link
            to="/calendar"
            className={cn(chromeBtnClass, 'inline-flex items-center')}
            style={{ borderColor: 'var(--control)' }}
          >
            Calendar
          </Link>
        </div>
      </div>

      {/* Cadence — text only */}
      <div
        className="shrink-0 border-b px-4 py-2 text-[12px] text-[var(--muted)]"
        style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
      >
        <span className="tabular-nums">{cadenceText}</span>
        <span className="text-[var(--faint)]">
          {' '}
          · place days on{' '}
          <Link to="/calendar" className="text-[var(--accent)] hover:underline">
            Calendar
          </Link>
        </span>
      </div>

      {/* Board */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Compose */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
        >
          <input
            placeholder="Ideas about…"
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            className={cn(fieldClass, 'max-w-xs')}
            style={fieldStyle}
          />
          <input
            placeholder="Pillar"
            value={pillar}
            onChange={(e) => setPillar(e.target.value)}
            className={cn(fieldClass, 'w-28')}
            style={fieldStyle}
          />
          <select
            className={fieldClass}
            style={fieldStyle}
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="">Any format</option>
            <option value="feed">Feed</option>
            <option value="reel">Reel</option>
            <option value="carousel">Carousel</option>
          </select>
          <select
            className={fieldClass}
            style={fieldStyle}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          >
            {[4, 8, 12].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="generate-ideas"
            disabled={generateMut.isPending}
            className={accentBtnClass}
            style={{ background: 'var(--accent)' }}
            onClick={() => generateMut.mutate()}
          >
            {generateMut.isPending ? 'Generating…' : `Generate ideas${costLabel}`}
          </button>
          <button
            type="button"
            className={chromeBtnClass}
            style={{ borderColor: 'var(--control)' }}
            onClick={() => setManualOpen((v) => !v)}
          >
            {manualOpen ? 'Cancel' : 'My own idea'}
          </button>
        </div>

        {manualOpen && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
          >
            <input
              placeholder="Topic (required)"
              value={manualTopic}
              onChange={(e) => setManualTopic(e.target.value)}
              className={cn(fieldClass, 'max-w-md flex-1')}
              style={fieldStyle}
              autoFocus
            />
            <button
              type="button"
              disabled={!manualTopic.trim() || createMut.isPending}
              className={accentBtnClass}
              style={{ background: 'var(--accent)' }}
              onClick={() => createMut.mutate()}
            >
              {createMut.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>
        )}

        {/* Tabs */}
        <div
          className="flex shrink-0 items-center gap-0 border-b px-4"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)', height: 44 }}
        >
          {(['board', 'shortlist', 'dismissed'] as Tab[]).map((t) => {
            const active = tab === t
            const countN = tabCounts[t]
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="relative flex h-full items-center gap-1.5 px-3 text-sm transition-colors"
                style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}
              >
                {TAB_LABEL[t]}
                {countN > 0 && (
                  <span
                    className="rounded-full px-1.5 text-[11px] font-medium tabular-nums"
                    style={{
                      background: active ? 'var(--accent)' : 'var(--raised)',
                      color: active ? '#fff' : 'var(--muted)',
                    }}
                  >
                    {countN}
                  </span>
                )}
                {active && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-[2px]"
                    style={{ background: 'var(--accent)' }}
                  />
                )}
              </button>
            )
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {ideasQ.isLoading && (
            <div
              className="h-24 animate-pulse rounded-[var(--radius-card)]"
              style={{ background: 'var(--raised)' }}
            />
          )}
          {!ideasQ.isLoading && ideas.length === 0 && (
            <p className="text-sm text-[var(--muted)]">
              {tab === 'board'
                ? 'No ideas yet — generate a batch to start exploring.'
                : tab === 'shortlist'
                  ? 'Nothing shortlisted — star ideas on the board to keep them here.'
                  : 'No dismissed ideas.'}
            </p>
          )}

          <div className="space-y-6">
            {batches.map(([key, batch]) => {
              const head = batch[0]
              const label =
                head?.source === 'manual'
                  ? 'Your ideas'
                  : head?.steer?.trim() || 'Open brainstorm'
              return (
                <section key={key}>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                    {label}
                    {head?.created_at ? (
                      <span className="font-normal normal-case tracking-normal text-[var(--faint)]">
                        {' '}
                        · {new Date(head.created_at).toLocaleString()}
                      </span>
                    ) : null}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {batch.map((idea) => (
                      <IdeaCard
                        key={idea.id}
                        idea={idea}
                        days={days}
                        tab={tab}
                        accountId={accountId}
                        parentTopic={
                          idea.parent_idea_id != null
                            ? topicById.get(idea.parent_idea_id) ?? null
                            : null
                        }
                        riffPending={pendingRiffIds.has(idea.id)}
                        onChanged={invalidate}
                        onRiff={() => riffMut.mutate(idea.id)}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function IdeaCard({
  idea,
  days,
  tab,
  accountId,
  parentTopic,
  riffPending,
  onChanged,
  onRiff,
}: {
  idea: Idea
  days: Date[]
  tab: Tab
  accountId: string
  parentTopic: string | null
  riffPending: boolean
  onChanged: () => void
  onRiff: () => void
}) {
  const shortlisted = idea.status === 'shortlisted'

  return (
    <div
      className="rounded-[var(--radius-card)] border p-3 transition-colors hover:bg-[var(--raised)]"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      data-testid="idea-card"
    >
      <div className="mb-1 flex items-start gap-2">
        <span className="mt-0.5 text-[var(--muted)]">
          <FormatGlyph format={idea.format} />
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-[var(--text)]">
          {idea.topic}
        </p>
      </div>
      {idea.source === 'riff' && parentTopic && (
        <p className="mb-1 truncate text-[11px] text-[var(--faint)]">Riff of {parentTopic}</p>
      )}
      {idea.angle && (
        <p className="text-[12px] leading-snug text-[var(--muted)]">{idea.angle}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {idea.pillar && (
          <span
            className="rounded-[var(--radius-chip)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]"
            style={{ background: 'var(--raised)' }}
          >
            {idea.pillar}
          </span>
        )}
        <span
          className="rounded-[var(--radius-chip)] px-1.5 py-0.5 text-[11px] capitalize text-[var(--muted)]"
          style={{ background: 'var(--raised)' }}
        >
          {idea.format}
        </span>
      </div>
      {idea.hooks.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[12px] text-[var(--muted)]">
          {idea.hooks.map((h) => (
            <li key={h} className="truncate">
              {h}
            </li>
          ))}
        </ul>
      )}
      {idea.why && (
        <p className="mt-2 text-[11px] leading-snug text-[var(--faint)]">{idea.why}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        {tab !== 'dismissed' && (
          <button
            type="button"
            data-testid="shortlist-idea"
            title={shortlisted ? 'Remove from shortlist' : 'Shortlist'}
            aria-pressed={shortlisted}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] transition-colors hover:bg-[var(--raised)]"
            style={{ color: shortlisted ? 'var(--accent)' : 'var(--muted)' }}
            onClick={() =>
              void updateIdea(idea.id, {
                status: shortlisted ? 'new' : 'shortlisted',
              })
                .then(onChanged)
                .catch((e: Error) => toast.error(e.message))
            }
          >
            <Star size={16} strokeWidth={1.5} fill={shortlisted ? 'currentColor' : 'none'} />
          </button>
        )}
        {tab !== 'dismissed' && (
          <select
            data-testid="schedule-idea-select"
            className="h-7 rounded-[var(--radius-control)] border bg-transparent px-1.5 text-[11px] text-[var(--muted)]"
            style={{ borderColor: 'var(--control)' }}
            defaultValue=""
            onChange={(e) => {
              const date = e.target.value
              e.target.value = ''
              if (!date) return
              void scheduleIdea(idea.id, {
                date,
                account_id: accountId || undefined,
              })
                .then(() => {
                  onChanged()
                  toast.success('Scheduled')
                })
                .catch((err: Error) => toast.error(err.message))
            }}
          >
            <option value="">Add to day…</option>
            {days.map((d) => (
              <option key={isoDay(d)} value={isoDay(d)}>
                {d.toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
              </option>
            ))}
          </select>
        )}
        {tab !== 'dismissed' && (
          <button
            type="button"
            disabled={riffPending}
            aria-busy={riffPending}
            className="h-7 px-2 text-[12px] font-medium text-[var(--muted)] hover:text-[var(--text)] hover:underline disabled:opacity-45"
            onClick={() => {
              if (riffPending) return
              onRiff()
            }}
          >
            {riffPending ? 'Riffing…' : 'Riff'}
          </button>
        )}
        {tab === 'dismissed' ? (
          <button
            type="button"
            className="h-7 px-2 text-[12px] font-medium text-[var(--accent)] hover:underline"
            onClick={() =>
              void updateIdea(idea.id, { status: 'new' })
                .then(onChanged)
                .catch((e: Error) => toast.error(e.message))
            }
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            title="Dismiss"
            aria-label="Dismiss"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-[var(--muted)] transition-colors hover:bg-[var(--raised)] hover:text-[var(--text)]"
            onClick={() =>
              void updateIdea(idea.id, { status: 'dismissed' })
                .then(onChanged)
                .catch((e: Error) => toast.error(e.message))
            }
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </div>
  )
}
