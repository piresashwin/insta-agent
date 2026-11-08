import { useState, useMemo, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  listCalendar,
  listBrandProfiles,
  listInstagramConnections,
  listPosts,
  patchPost,
  getBudget,
  type BudgetData,
} from '../api'
import type { Post, BrandProfile, InstagramConnection } from '../api'
import { mondayOf, isoDay, addDays, weekLabel } from '../lib/week'
import { resolveNextStep } from '../lib/post-studio-actions'

// ---- Format glyph ----
function FormatGlyph({ format }: { format?: string }) {
  const f = (format || 'feed').toLowerCase()
  if (f === 'reel') {
    return (
      <svg width="8" height="14" viewBox="0 0 8 14" fill="none" className="shrink-0">
        <rect x="0.5" y="0.5" width="7" height="13" rx="1" stroke="currentColor" strokeWidth="1" />
      </svg>
    )
  }
  if (f === 'carousel') {
    return (
      <svg width="14" height="12" viewBox="0 0 14 12" fill="none" className="shrink-0">
        <rect x="0.5" y="2.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1" />
        <rect x="4.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1" fill="var(--surface)" />
      </svg>
    )
  }
  // feed: 4:5
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" className="shrink-0">
      <rect x="0.5" y="0.5" width="9" height="11" rx="1" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

// ---- Status card style ----
function cardStyle(status: string): React.CSSProperties {
  if (status === 'pending_approval' || status === 'media_ready') {
    return { background: 'var(--accent-soft)', borderColor: 'var(--accent)' }
  }
  if (status === 'staged') {
    return { background: 'var(--surface)', borderColor: 'var(--control)' }
  }
  if (status === 'published') {
    return { background: 'var(--raised)', borderColor: 'var(--border)' }
  }
  if (status === 'failed') {
    return { background: 'var(--pill-negative-bg)', borderColor: 'var(--negative)' }
  }
  return { background: 'var(--surface)', borderColor: 'var(--border)' }
}

function statusLabel(status: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    draft: { label: 'Draft', color: 'var(--muted)' },
    pending_approval: { label: 'Needs OK', color: 'var(--accent)' },
    media_ready: { label: 'Media OK?', color: 'var(--accent)' },
    changes_requested: { label: 'Revise', color: 'var(--warning)' },
    approved: { label: 'Approved', color: 'var(--positive)' },
    staged: { label: 'Scheduled', color: 'var(--muted)' },
    published: { label: 'Live', color: 'var(--positive)' },
    failed: { label: 'Failed', color: 'var(--negative)' },
  }
  return map[status] ?? { label: status, color: 'var(--muted)' }
}

// ---- Post card on grid ----
type PostCardProps = {
  post: Post
  onDragStart: (postId: number) => void
  onClick: (postId: number) => void
}

function PostCard({ post, onDragStart, onClick }: PostCardProps) {
  const style = cardStyle(post.status)
  const sl = statusLabel(post.status)
  const text = post.hook || post.topic || `Post #${post.id}`

  return (
    <div
      draggable
      onDragStart={() => onDragStart(post.id)}
      onClick={() => onClick(post.id)}
      className="cursor-pointer rounded border px-1.5 py-1 text-left transition-opacity hover:opacity-80"
      style={style}
    >
      <div className="flex items-start gap-1 mb-0.5">
        <span className="mt-[1px] text-[var(--muted)]">
          <FormatGlyph format={post.format ?? undefined} />
        </span>
        <p className="line-clamp-2 text-[11px] font-medium leading-snug text-[var(--text)] flex-1 min-w-0">
          {text}
        </p>
      </div>
      <span className="text-[9px] font-semibold uppercase tracking-[0.06em]" style={{ color: sl.color }}>
        {sl.label}
      </span>
      {(() => {
        const next = resolveNextStep(post, [])
        const label = next.primary?.label ?? next.info
        return label ? (
          <p className="mt-0.5 text-[9px] text-[var(--muted)] truncate">{label}</p>
        ) : null
      })()}
    </div>
  )
}

// ---- Profile grid tile ----
function GridTile({ post }: { post: Post }) {
  const bg: Record<string, string> = {
    draft: 'var(--raised)',
    pending_approval: 'var(--accent-soft)',
    media_ready: 'var(--accent-soft)',
    staged: 'var(--surface)',
    published: 'var(--surface)',
    failed: 'var(--pill-negative-bg)',
  }
  const dot: Record<string, string | null> = {
    draft: null,
    pending_approval: 'var(--accent)',
    media_ready: 'var(--accent)',
    staged: 'var(--muted)',
    published: 'var(--positive)',
    failed: 'var(--negative)',
  }
  const fmt = (post.format || 'feed').toLowerCase()
  const initial = fmt === 'reel' ? 'R' : fmt === 'carousel' ? 'C' : 'F'
  const bgColor = bg[post.status] ?? 'var(--raised)'
  const dotColor = dot[post.status] ?? null

  return (
    <Link
      to="/posts/$postId"
      params={{ postId: String(post.id) }}
      className="relative flex items-center justify-center rounded border"
      style={{ width: 56, height: 56, background: bgColor, borderColor: 'var(--border)' }}
    >
      <span className="text-[10px] font-semibold text-[var(--muted)]">{initial}</span>
      {dotColor && (
        <span
          className="absolute bottom-1 right-1 h-2 w-2 rounded-full"
          style={{ background: dotColor }}
        />
      )}
    </Link>
  )
}

// ---- Side rail ----
type SideRailProps = {
  allPosts: Post[]
  weekPosts: Post[]
  budget: BudgetData | undefined
}

function SideRail({ allPosts, weekPosts, budget }: SideRailProps) {
  const today = new Date()
  const gridPosts = allPosts
    .filter((p) => p.scheduled_at && new Date(p.scheduled_at) >= today)
    .sort((a, b) => (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? ''))
    .slice(0, 9)

  // Pillar balance
  const pillarMap = new Map<string, number>()
  for (const p of weekPosts) {
    if (p.pillar) pillarMap.set(p.pillar, (pillarMap.get(p.pillar) ?? 0) + 1)
  }
  const totalSlots = Math.max(weekPosts.length, 1)

  const pct = budget ? Math.min((budget.spent / budget.cap) * 100, 100) : 0
  const nearCap = pct >= 80

  return (
    <div
      className="flex flex-col shrink-0 overflow-y-auto"
      style={{ width: 280, borderLeft: '1px solid var(--border)', background: 'var(--surface)' }}
    >
      {/* Profile grid */}
      <div className="p-4 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] mb-3">
          Your grid
        </div>
        {gridPosts.length === 0 ? (
          <p className="text-[12px] text-[var(--faint)]">No upcoming posts.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {gridPosts.map((p) => (
              <GridTile key={p.id} post={p} />
            ))}
          </div>
        )}
      </div>

      {/* Pillar balance */}
      <div className="p-4 flex-1 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] mb-3">
          Pillars this week
        </div>
        {pillarMap.size === 0 ? (
          <p className="text-[12px] text-[var(--faint)]">—</p>
        ) : (
          <div className="space-y-2">
            {[...pillarMap.entries()].map(([pillar, count]) => (
              <div key={pillar} className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--muted)] truncate" style={{ width: 70 }}>
                  {pillar}
                </span>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--raised)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.round((count / totalSlots) * 100)}%`,
                      background: 'var(--accent)',
                    }}
                  />
                </div>
                <span className="text-[11px] tabular-nums text-[var(--faint)]">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Week forecast */}
      <div className="p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] mb-2">
          Week cost
        </div>
        {budget ? (
          <>
            <div className="text-[12px] text-[var(--muted)] mb-1.5">
              Est. ${budget.forecast.toFixed(2)} · ${budget.remaining.toFixed(2)} remaining
            </div>
            <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'var(--accent-track)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${pct}%`,
                  background: nearCap ? 'var(--warning)' : 'var(--accent)',
                }}
              />
            </div>
          </>
        ) : (
          <p className="text-[12px] text-[var(--faint)]">—</p>
        )}
      </div>
    </div>
  )
}

// ---- Main screen ----
export function CalendarScreen() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()))
  const [brandId, setBrandId] = useState<number | null>(null)
  const [accountId, setAccountId] = useState('')
  const busy = false

  const dragRef = useRef<{ postId: number } | null>(null)

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  )
  const from = isoDay(weekStart)
  const to = isoDay(addDays(weekStart, 7))
  const todayIso = isoDay(new Date())

  // Queries
  const { data: brandsData } = useQuery({
    queryKey: ['brands'],
    queryFn: listBrandProfiles,
  })
  const brands: BrandProfile[] = brandsData?.brands ?? []

  const { data: connectionsData } = useQuery({
    queryKey: ['ig-connections'],
    queryFn: listInstagramConnections,
  })
  const connections: InstagramConnection[] = (connectionsData as { connections?: InstagramConnection[] })?.connections ?? []

  const effectiveBrandId: number | null = brandId ?? brands[0]?.id ?? null

  const { data: calData, isLoading: calLoading } = useQuery({
    queryKey: ['calendar', from, to, effectiveBrandId, accountId],
    queryFn: () =>
      listCalendar({
        from,
        to,
        brand_profile_id: effectiveBrandId ?? undefined,
        account_id: accountId || undefined,
      }),
    staleTime: 30_000,
  })
  const calPosts: Post[] = calData?.posts ?? []

  const { data: allPostsData } = useQuery({
    queryKey: ['posts'],
    queryFn: () => listPosts(''),
    staleTime: 60_000,
  })
  const allPosts: Post[] = allPostsData?.posts ?? []

  const { data: budget } = useQuery({
    queryKey: ['budget'],
    queryFn: getBudget,
    staleTime: 60_000,
  })

  // Set brandId once brands load
  useMemo(() => {
    if (brandId === null && brands.length > 0) setBrandId(brands[0].id)
  }, [brands.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>()
    for (const d of days) map.set(isoDay(d), [])
    for (const p of calPosts) {
      const key = (p.scheduled_at || '').slice(0, 10)
      if (map.has(key)) map.get(key)!.push(p)
    }
    return map
  }, [calPosts, days])

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['calendar'] })
    void qc.invalidateQueries({ queryKey: ['posts'] })
  }, [qc])

  // Drag-to-reschedule drop
  async function handleDrop(dayIso: string) {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    try {
      await patchPost(drag.postId, { scheduled_at: `${dayIso}T12:00:00.000Z` })
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reschedule failed')
    }
  }

  return (
    <div className="flex h-full overflow-hidden" style={{ background: 'var(--ground)' }}>
      {/* Week grid column */}
      <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
        {/* Header strip */}
        <div
          className="flex items-center gap-3 border-b px-4 shrink-0 flex-wrap"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)', minHeight: 52, paddingTop: 8, paddingBottom: 8 }}
        >
          {/* Week label */}
          <span className="text-[13px] font-semibold text-[var(--text)] shrink-0">
            {weekLabel(weekStart)}
          </span>

          {/* Brand selector */}
          {brands.length > 0 && (
            <select
              className="h-8 rounded-[var(--radius-control)] border px-2 text-sm bg-[var(--surface)] text-[var(--text)]"
              style={{ borderColor: 'var(--control)' }}
              value={effectiveBrandId === null ? '' : String(effectiveBrandId)}
              disabled={busy}
              onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)}
            >
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}

          {/* Account selector */}
          {connections.length > 1 && (
            <select
              className="h-8 rounded-[var(--radius-control)] border px-2 text-sm bg-[var(--surface)] text-[var(--text)]"
              style={{ borderColor: 'var(--control)' }}
              value={accountId}
              disabled={busy}
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

          <div className="ml-auto flex items-center gap-1.5 flex-wrap">
            {/* Nav buttons */}
            {(['← Prev', 'Today', 'Next →'] as const).map((label) => (
              <button
                key={label}
                className="h-8 px-3 text-sm rounded-[var(--radius-control)] border transition-colors hover:bg-[var(--raised)] text-[var(--muted)]"
                style={{ borderColor: 'var(--control)' }}
                disabled={busy}
                onClick={() => {
                  if (label === '← Prev') setWeekStart(addDays(weekStart, -7))
                  else if (label === 'Today') setWeekStart(mondayOf(new Date()))
                  else setWeekStart(addDays(weekStart, 7))
                }}
              >
                {label}
              </button>
            ))}

            <button
              className="h-8 px-3 text-sm rounded-[var(--radius-control)] font-medium text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)' }}
              onClick={() => navigate({ to: '/plan' })}
            >
              Plan this week
            </button>
          </div>
        </div>

        {/* 7-day grid */}
        <div className="flex-1 overflow-auto">
          <div className="grid min-h-full" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', minWidth: 700 }}>
            {days.map((d) => {
              const key = isoDay(d)
              const items = byDay.get(key) ?? []
              const isToday = key === todayIso

              return (
                <div
                  key={key}
                  className="flex flex-col border-r last:border-r-0"
                  style={{ borderColor: 'var(--border)', background: isToday ? 'rgba(184,51,106,0.02)' : 'var(--ground)' }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void handleDrop(key)}
                >
                  {/* Day header */}
                  <div
                    className="flex items-baseline gap-1.5 border-b px-2.5 py-2 shrink-0"
                    style={{ borderColor: isToday ? 'var(--accent)' : 'var(--border)' }}
                  >
                    <span
                      className="text-[10px] font-semibold uppercase tracking-[0.08em]"
                      style={{ color: isToday ? 'var(--accent)' : 'var(--muted)' }}
                    >
                      {d.toLocaleDateString(undefined, { weekday: 'short' })}
                    </span>
                    <span
                      className="font-mono text-[13px] font-semibold tabular-nums"
                      style={{ color: isToday ? 'var(--accent)' : 'var(--text)' }}
                    >
                      {d.getDate()}
                    </span>
                  </div>

                  {/* Cards */}
                  <div className="flex flex-col gap-1.5 p-1.5 flex-1">
                    {calLoading && items.length === 0 && (
                      <div className="h-12 rounded animate-pulse" style={{ background: 'var(--raised)' }} />
                    )}
                    {items.map((p) => (
                      <PostCard
                        key={p.id}
                        post={p}
                        onDragStart={(id) => { dragRef.current = { postId: id } }}
                        onClick={(id) => void navigate({ to: '/posts/$postId', params: { postId: String(id) } })}
                      />
                    ))}
                    {items.length === 0 && !calLoading && (
                      <div className="flex-1 flex items-center justify-center py-6">
                        <span className="text-[10px] text-[var(--faint)]">—</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

      </div>

      {/* Side rail */}
      <SideRail allPosts={allPosts} weekPosts={calPosts} budget={budget} />
    </div>
  )
}
