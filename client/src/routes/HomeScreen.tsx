import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  listPosts,
  listCalendar,
  getBudget,
  listActivity,
  approvePost,
  type Post,
  type ActivityItem,
} from '../api'

// ---- Helpers ----

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function mondayOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(12, 0, 0, 0)
  const day = x.getDay()
  const offset = day === 0 ? -6 : 1 - day
  x.setDate(x.getDate() + offset)
  return x
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const FORMAT_LABEL: Record<string, string> = { feed: 'Feed', reel: 'Reel', carousel: 'Carousel' }
const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Needs OK',
  media_ready: 'Needs media OK',
  changes_requested: 'Revise',
  staged: 'Scheduled',
  published: 'Live',
  draft: 'Draft',
  failed: 'Failed',
}

// ---- Needs OK strip ----

function NeedsOKRow({ post, onApproved }: { post: Post; onApproved: () => void }) {
  const navigate = useNavigate()

  async function handleApprove(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await approvePost(post.id)
      onApproved()
      toast.success('Post approved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Approve failed')
    }
  }

  const hook = post.hook?.slice(0, 80) ?? post.topic?.slice(0, 80) ?? '(no hook)'
  const fmt = FORMAT_LABEL[(post.format ?? 'feed').toLowerCase()] ?? 'Feed'
  const statusLabel = STATUS_LABEL[post.status] ?? post.status
  const isMedia = post.status === 'media_ready'
  const waitingTime = post.created_at ? relativeTime(post.created_at) : ''

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 border-b border-[var(--rule)] last:border-0 hover:bg-[var(--raised)] cursor-pointer transition-colors"
      onClick={() => void navigate({ to: '/posts/$postId', params: { postId: String(post.id) } })}
    >
      {/* Thumbnail placeholder */}
      <div className="w-12 h-12 rounded-[var(--radius-card)] bg-[var(--raised)] shrink-0 flex items-center justify-center text-[11px] font-semibold text-[var(--muted)]"
        style={{ background: 'var(--accent-soft)' }}>
        {fmt[0]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text)] truncate leading-snug">{hook}</p>
        <p className="text-xs text-[var(--muted)] mt-0.5">
          {fmt}
          {waitingTime && <> · waiting {waitingTime}</>}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span
          className="text-[11px] px-2 py-0.5 rounded font-medium"
          style={{
            background: isMedia ? 'var(--pill-positive-bg)' : 'var(--accent-soft)',
            color: isMedia ? 'var(--pill-positive-ink)' : 'var(--accent-ink)',
          }}
        >
          {statusLabel}
        </span>
        {!isMedia && (
          <button
            onClick={(e) => void handleApprove(e)}
            className="text-xs font-medium px-3 py-1 rounded-[var(--radius-control)] transition-opacity hover:opacity-80"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Approve
          </button>
        )}
      </div>
    </div>
  )
}

// ---- This week strip ----

function ThisWeekStrip({ posts }: { posts: Post[] }) {
  const weekStart = mondayOf(new Date())
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const todayIso = isoDay(new Date())

  const byDay = new Map<string, Post[]>()
  for (const d of days) byDay.set(isoDay(d), [])
  for (const p of posts) {
    const key = (p.scheduled_at || '').slice(0, 10)
    if (byDay.has(key)) byDay.get(key)!.push(p)
  }

  return (
    <div className="grid grid-cols-7 gap-1">
      {days.map((d) => {
        const key = isoDay(d)
        const isToday = key === todayIso
        const dayPosts = byDay.get(key) ?? []
        const needsOK = dayPosts.some((p) => p.status === 'pending_approval' || p.status === 'media_ready')

        return (
          <div key={key} className="flex flex-col items-center gap-1">
            <span
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: isToday ? 'var(--accent)' : 'var(--muted)' }}
            >
              {d.toLocaleDateString(undefined, { weekday: 'short' })}
            </span>
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold tabular-nums"
              style={{
                background: isToday ? 'var(--accent)' : 'transparent',
                color: isToday ? '#fff' : 'var(--text)',
              }}
            >
              {d.getDate()}
            </div>
            {/* Slot dots */}
            <div className="flex flex-col items-center gap-0.5">
              {dayPosts.length === 0 ? (
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--rule)]" />
              ) : (
                dayPosts.slice(0, 3).map((p) => (
                  <div
                    key={p.id}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      background: needsOK ? 'var(--accent)' : 'var(--positive)',
                    }}
                  />
                ))
              )}
            </div>
            {dayPosts.length > 0 && (
              <span className="text-[10px] text-[var(--muted)]">{dayPosts.length}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---- Profile grid ----

function ProfileGrid({ posts }: { posts: Post[] }) {
  const sorted = [...posts]
    .filter((p) => p.scheduled_at || p.status === 'staged' || p.status === 'published')
    .sort((a, b) => {
      const ta = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0
      const tb = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0
      return ta - tb
    })
    .slice(0, 9)

  const statusDot: Record<string, string> = {
    pending_approval: 'var(--accent)',
    media_ready: 'var(--accent)',
    staged: 'var(--muted)',
    published: 'var(--positive)',
    draft: 'var(--rule)',
    failed: 'var(--negative)',
  }

  const statusBg: Record<string, string> = {
    pending_approval: 'var(--accent-soft)',
    media_ready: 'var(--accent-soft)',
    staged: 'var(--raised)',
    published: 'var(--surface)',
    draft: 'var(--raised)',
    failed: 'var(--pill-negative-bg)',
  }

  return (
    <div className="grid grid-cols-3 gap-1">
      {sorted.length === 0
        ? Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="aspect-square rounded bg-[var(--raised)]" />
          ))
        : sorted.map((p) => (
            <Link
              key={p.id}
              to="/posts/$postId"
              params={{ postId: String(p.id) }}
              className="relative aspect-square rounded-[var(--radius-chip)] flex items-center justify-center text-[11px] font-semibold text-[var(--muted)] transition-opacity hover:opacity-80"
              style={{ background: statusBg[p.status] ?? 'var(--raised)' }}
            >
              {FORMAT_LABEL[(p.format ?? 'feed').toLowerCase()]?.[0] ?? 'F'}
              <div
                className="absolute bottom-1 right-1 w-2 h-2 rounded-full border-2 border-[var(--surface)]"
                style={{ background: statusDot[p.status] ?? 'var(--rule)' }}
              />
            </Link>
          ))}
    </div>
  )
}

// ---- Budget track ----

function BudgetTrack({ cap, spent, forecast }: { cap: number; spent: number; forecast: number }) {
  const pct = Math.min((spent / cap) * 100, 100)
  const forecastPct = Math.min((forecast / cap) * 100, 100)
  const nearCap = pct >= 80

  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-xs text-[var(--muted)]">${spent.toFixed(2)} spent</span>
        <span className="text-xs text-[var(--muted)]">${cap.toFixed(0)} cap</span>
      </div>
      <div className="h-2 rounded-full bg-[var(--accent-track)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${forecastPct}%`,
            background: 'var(--accent-track)',
          }}
        />
        <div
          className="h-full rounded-full -mt-2 transition-all"
          style={{
            width: `${pct}%`,
            background: nearCap ? 'var(--warning)' : 'var(--accent)',
          }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[11px] text-[var(--muted)]">Forecast ${forecast.toFixed(2)}</span>
        {nearCap && (
          <span className="text-[11px] font-medium" style={{ color: 'var(--warning)' }}>
            Near cap
          </span>
        )}
      </div>
    </div>
  )
}

// ---- Activity actor chip ----

function ActorChip({ item }: { item: ActivityItem }) {
  const kind = item.actor_kind
  let bg = 'var(--pill-neutral-bg)'
  let ink = 'var(--pill-neutral-ink)'
  let initial = 'Y'
  let label = item.actor_name || 'You'

  if (kind === 'mcp' || kind === 'operator_agent' || item.actor_client) {
    bg = 'var(--accent-soft)'; ink = 'var(--accent-ink)'; initial = 'M'; label = item.actor_name || item.actor_client || 'MCP'
  } else if (kind === 'scheduler') {
    bg = 'var(--pill-warning-bg)'; ink = 'var(--pill-warning-ink)'; initial = 'S'; label = 'Scheduler'
  } else if (kind === 'agent') {
    bg = 'var(--raised)'; ink = 'var(--muted)'; initial = 'A'; label = item.actor_name || 'Agent'
  }

  return (
    <div
      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0"
      style={{ background: bg, color: ink }}
      title={label}
    >
      {initial}
    </div>
  )
}

function kindLabel(kind: ActivityItem['kind']): string {
  switch (kind) {
    case 'post_version': return 'Post edited'
    case 'approval': return 'Approval'
    case 'iteration': return 'Change requested'
    case 'run': return 'Run'
    case 'auth': return 'Auth event'
    default: return kind
  }
}

// ---- Section heading ----

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--muted)] mb-3">
      {children}
    </p>
  )
}

// ---- HomeScreen ----

export function HomeScreen() {
  const qc = useQueryClient()
  const weekStart = mondayOf(new Date())
  const from = isoDay(weekStart)
  const to = isoDay(addDays(weekStart, 7))

  const { data: postsData, isLoading: postsLoading } = useQuery({
    queryKey: ['posts'],
    queryFn: () => listPosts(''),
    refetchInterval: 30_000,
  })

  const { data: calData } = useQuery({
    queryKey: ['calendar-week', from, to],
    queryFn: () => listCalendar({ from, to }),
    refetchInterval: 30_000,
  })

  const { data: budgetData } = useQuery({
    queryKey: ['budget'],
    queryFn: getBudget,
    refetchInterval: 60_000,
  })

  const { data: activityData } = useQuery({
    queryKey: ['activity'],
    queryFn: () => listActivity({ limit: 5 }),
    refetchInterval: 30_000,
  })

  const allPosts: Post[] = postsData?.posts ?? []
  const weekPosts: Post[] = calData?.posts ?? []
  const activityItems: ActivityItem[] = activityData?.items ?? []

  const needsOK = allPosts.filter(
    (p) => p.status === 'pending_approval' || p.status === 'media_ready'
  ).slice(0, 6)

  const scheduledCount = weekPosts.length
  const readyCount = weekPosts.filter(
    (p) => p.status === 'staged' || p.status === 'published' || p.status === 'approved'
  ).length

  const findingLine = needsOK.length > 0
    ? `${needsOK.length} post${needsOK.length !== 1 ? 's' : ''} need your OK · this week ${readyCount} of 7 slots ready`
    : `This week ${readyCount} of 7 slots ready`

  return (
    <div className="flex gap-0 h-full" style={{ background: 'var(--ground)' }}>
      {/* Main column */}
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-6">
        <h1 className="text-2xl font-semibold text-[var(--text)] mb-1">Home</h1>
        <p className="text-sm text-[var(--muted)] mb-6">{findingLine}</p>

        {/* Needs your OK */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Needs your OK</SectionHeading>
            {needsOK.length > 0 && (
              <Link to="/inbox" className="text-xs text-[var(--accent)] hover:underline">
                View all
              </Link>
            )}
          </div>

          <div
            className="rounded-[var(--radius-card)] border border-[var(--border)] overflow-hidden"
            style={{ background: 'var(--surface)' }}
          >
            {postsLoading ? (
              <div className="p-4 space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 rounded bg-[var(--raised)] animate-pulse" />
                ))}
              </div>
            ) : needsOK.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-[var(--muted)] mb-3">All caught up — no posts waiting.</p>
                <Link to="/inbox" className="text-sm text-[var(--accent)] hover:underline">
                  Go to inbox
                </Link>
              </div>
            ) : (
              needsOK.map((post) => (
                <NeedsOKRow
                  key={post.id}
                  post={post}
                  onApproved={() => void qc.invalidateQueries({ queryKey: ['posts'] })}
                />
              ))
            )}
          </div>
        </section>

        {/* This week */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>This week</SectionHeading>
            <Link to="/calendar" className="text-xs text-[var(--accent)] hover:underline">
              Open calendar
            </Link>
          </div>

          <div
            className="rounded-[var(--radius-card)] border border-[var(--border)] px-4 py-4"
            style={{ background: 'var(--surface)' }}
          >
            <ThisWeekStrip posts={weekPosts} />
            {scheduledCount > 0 && (
              <p className="text-xs text-[var(--muted)] mt-3 text-center">
                {scheduledCount} post{scheduledCount !== 1 ? 's' : ''} this week
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Right rail */}
      <aside
        className="shrink-0 border-l border-[var(--border)] overflow-y-auto px-5 py-6 flex flex-col gap-6"
        style={{ width: 320, background: 'var(--surface)' }}
      >
        {/* Profile grid */}
        <section>
          <SectionHeading>Your grid</SectionHeading>
          <ProfileGrid posts={allPosts} />
          <Link
            to="/plan"
            className="block text-center text-xs text-[var(--accent)] hover:underline mt-2"
          >
            Plan more posts
          </Link>
        </section>

        {/* Budget */}
        {budgetData && (
          <section className="border-t border-[var(--rule)] pt-5">
            <div className="flex items-center justify-between mb-3">
              <SectionHeading>Budget</SectionHeading>
              <Link to="/settings" className="text-xs text-[var(--accent)] hover:underline">
                Settings
              </Link>
            </div>
            <BudgetTrack
              cap={budgetData.cap}
              spent={budgetData.spent}
              forecast={budgetData.forecast}
            />
          </section>
        )}

        {/* Recent activity */}
        <section className="border-t border-[var(--rule)] pt-5">
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Recent activity</SectionHeading>
            <Link to="/activity" className="text-xs text-[var(--accent)] hover:underline">
              View all
            </Link>
          </div>

          {activityItems.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No activity yet.</p>
          ) : (
            <div className="space-y-3">
              {activityItems.map((item, i) => (
                <div key={`${item.kind}-${item.created_at}-${i}`} className="flex items-start gap-2">
                  <ActorChip item={item} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-[var(--text)] truncate">{kindLabel(item.kind)}</p>
                    {item.post_id && (
                      <Link
                        to="/posts/$postId"
                        params={{ postId: String(item.post_id) }}
                        className="text-[11px] text-[var(--accent)] hover:underline"
                      >
                        Post #{item.post_id}
                      </Link>
                    )}
                  </div>
                  <span className="text-[11px] text-[var(--muted)] shrink-0">
                    {relativeTime(item.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}
