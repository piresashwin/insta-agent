import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BrandProfile, CalendarProposal, Post } from '@instagram-agent/shared'
import {
  createPost,
  fillWeek,
  listBrandProfiles,
  listCalendar,
  listInstagramConnections,
  type InstagramConnection,
} from '../api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { cn } from '../lib/utils'

function mondayOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(12, 0, 0, 0)
  const day = x.getDay()
  const offset = day === 0 ? -6 : 1 - day
  x.setDate(x.getDate() + offset)
  return x
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

const STATUS_MARK: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'text-muted-foreground' },
  pending_approval: { label: 'Needs OK', className: 'text-pending' },
  changes_requested: { label: 'Revise', className: 'text-warn' },
  approved: { label: 'Passed', className: 'text-ok' },
  media_ready: { label: 'Compose', className: 'text-rule' },
  staged: { label: 'Staged', className: 'text-ok' },
  published: { label: 'Live', className: 'text-ok' },
  failed: { label: 'Failed', className: 'text-destructive' },
}

const FORMAT_TAG: Record<string, { label: string; className: string }> = {
  feed: {
    label: 'Feed',
    className: 'border-border bg-muted text-muted-foreground',
  },
  reel: {
    label: 'Reel',
    className: 'border-rule/40 bg-rule/10 text-rule',
  },
  carousel: {
    label: 'Carousel',
    className: 'border-pending/40 bg-pending/10 text-pending',
  },
}

function ChromeLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </span>
  )
}

type Props = {
  onOpenPost: (post: Post) => void
  onError: (msg: string | null) => void
}

export function CalendarWeekPanel({ onOpenPost, onError }: Props) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()))
  const [posts, setPosts] = useState<Post[]>([])
  const [brands, setBrands] = useState<BrandProfile[]>([])
  const [accounts, setAccounts] = useState<InstagramConnection[]>([])
  const [brandId, setBrandId] = useState<number | ''>('')
  const [accountId, setAccountId] = useState('')
  const [busy, setBusy] = useState(false)
  const [proposals, setProposals] = useState<CalendarProposal[] | null>(null)
  const [manualTopic, setManualTopic] = useState('')
  const [manualDay, setManualDay] = useState('')

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  )
  const from = isoDay(weekStart)
  const to = isoDay(addDays(weekStart, 7))
  const todayIso = isoDay(new Date())
  const weekLabel = `${weekStart.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`

  const refresh = useCallback(async () => {
    const [{ posts: cal }, { brands: b }, { connections }] = await Promise.all([
      listCalendar({
        from,
        to,
        brand_profile_id: brandId === '' ? undefined : brandId,
        account_id: accountId || undefined,
      }),
      listBrandProfiles(),
      listInstagramConnections(),
    ])
    setPosts(cal)
    setBrands(b)
    setAccounts(connections)
    if (brandId === '' && b[0]) setBrandId(b[0].id)
  }, [from, to, brandId, accountId])

  useEffect(() => {
    void refresh().catch((e) => onError(e instanceof Error ? e.message : 'Calendar load failed'))
  }, [refresh, onError])

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>()
    for (const d of days) map.set(isoDay(d), [])
    for (const p of posts) {
      const key = (p.scheduled_at || '').slice(0, 10)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(p)
    }
    return map
  }, [posts, days])

  const scheduledCount = posts.length

  async function handleFillWeek() {
    if (brandId === '') {
      onError('Select a brand first')
      return
    }
    setBusy(true)
    onError(null)
    try {
      const { proposals: props } = await fillWeek(brandId, {
        week_start: from,
        account_id: accountId || undefined,
        dry_run: true,
      })
      setProposals(props)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Fill week failed')
    } finally {
      setBusy(false)
    }
  }

  async function commitProposals() {
    if (brandId === '' || !proposals?.length) return
    setBusy(true)
    onError(null)
    try {
      await fillWeek(brandId, {
        week_start: from,
        account_id: accountId || undefined,
        dry_run: false,
        proposals,
      })
      setProposals(null)
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Commit failed')
    } finally {
      setBusy(false)
    }
  }

  async function addManual(dayIso: string) {
    const topic = manualTopic.trim() || window.prompt('Topic for this day?')
    if (!topic) return
    setBusy(true)
    onError(null)
    try {
      const { post } = await createPost(topic, {
        brand_profile_id: brandId === '' ? undefined : brandId,
        account_id: accountId || undefined,
        scheduled_at: `${dayIso}T12:00:00.000Z`,
      })
      setManualTopic('')
      setManualDay('')
      await refresh()
      onOpenPost(post)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dash-in space-y-5">
      {/* Ruled control strip */}
      <div className="border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule/40 px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
              Week plan
            </h2>
            <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              {weekLabel}
              <span className="mx-2 text-border">·</span>
              {scheduledCount} slotted
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setWeekStart(addDays(weekStart, -7))}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setWeekStart(mondayOf(new Date()))}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setWeekStart(addDays(weekStart, 7))}
            >
              Next
            </Button>
            <Button
              size="sm"
              disabled={busy || brandId === ''}
              onClick={() => void handleFillWeek()}
            >
              {busy ? 'Planning…' : 'Fill week'}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4 px-4 py-3">
          <label className="space-y-1">
            <ChromeLabel>Week of</ChromeLabel>
            <Input
              type="date"
              className="h-8 w-[148px] font-mono text-xs"
              value={from}
              disabled={busy}
              onChange={(e) => setWeekStart(mondayOf(new Date(`${e.target.value}T12:00:00`)))}
            />
          </label>
          <label className="space-y-1">
            <ChromeLabel>Brand</ChromeLabel>
            <select
              className="flex h-8 min-w-[160px] rounded-sm border border-input bg-card px-2 text-sm outline-none focus-visible:border-rule"
              value={brandId === '' ? '' : String(brandId)}
              disabled={busy}
              onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Select brand…</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <ChromeLabel>Account</ChromeLabel>
            <select
              className="flex h-8 min-w-[140px] rounded-sm border border-input bg-card px-2 text-sm outline-none focus-visible:border-rule"
              value={accountId}
              disabled={busy}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Any</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.account_id}>
                  {a.ig_username ? `@${a.ig_username}` : a.account_id}
                </option>
              ))}
            </select>
          </label>
          {brands.length === 0 && (
            <p className="pb-1 text-xs text-muted-foreground">
              Create a brand first — Fill week needs a profile.
            </p>
          )}
        </div>
      </div>

      {/* Proposal proof sheet */}
      {proposals && (
        <div className="border border-rule/50 bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule/40 bg-rule/5 px-4 py-2">
            <div>
              <h3 className="text-[13px] font-semibold">Proposed slots</h3>
              <p className="text-[11px] text-muted-foreground">
                Edit topics or drop rows, then create drafts on the grid.
              </p>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setProposals(null)}>
                Discard
              </Button>
              <Button
                size="sm"
                disabled={busy || !proposals.length}
                onClick={() => void commitProposals()}
              >
                Create drafts
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-border">
            {proposals.map((p, i) => (
              <li
                key={`${p.date}-${i}`}
                className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[120px_minmax(0,1fr)_auto]"
              >
                <Input
                  type="date"
                  className="h-8 font-mono text-xs"
                  value={p.date.slice(0, 10)}
                  disabled={busy}
                  onChange={(e) =>
                    setProposals((prev) =>
                      prev
                        ? prev.map((x, j) => (j === i ? { ...x, date: e.target.value } : x))
                        : prev
                    )
                  }
                />
                <div className="min-w-0 space-y-1">
                  <Input
                    className="h-8"
                    value={p.topic}
                    disabled={busy}
                    onChange={(e) =>
                      setProposals((prev) =>
                        prev
                          ? prev.map((x, j) =>
                              j === i ? { ...x, topic: e.target.value } : x
                            )
                          : prev
                      )
                    }
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <select
                      className="h-7 rounded-sm border border-input bg-card px-1.5 text-[10px] font-semibold uppercase"
                      value={(p.format || 'feed') as string}
                      disabled={busy}
                      onChange={(e) =>
                        setProposals((prev) =>
                          prev
                            ? prev.map((x, j) =>
                                j === i ? { ...x, format: e.target.value } : x
                              )
                            : prev
                        )
                      }
                    >
                      <option value="feed">feed</option>
                      <option value="reel">reel</option>
                      <option value="carousel">carousel</option>
                    </select>
                    <Input
                      className="h-7 flex-1 text-[11px]"
                      value={p.pillar || ''}
                      disabled={busy}
                      placeholder="Pillar"
                      onChange={(e) =>
                        setProposals((prev) =>
                          prev
                            ? prev.map((x, j) =>
                                j === i ? { ...x, pillar: e.target.value || null } : x
                              )
                            : prev
                        )
                      }
                    />
                  </div>
                  <Input
                    className="h-7 text-[11px]"
                    value={p.angle || ''}
                    disabled={busy}
                    placeholder="Angle / POV"
                    onChange={(e) =>
                      setProposals((prev) =>
                        prev
                          ? prev.map((x, j) =>
                              j === i ? { ...x, angle: e.target.value || null } : x
                            )
                          : prev
                      )
                    }
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setProposals((prev) => (prev ? prev.filter((_, j) => j !== i) : prev))
                  }
                >
                  Drop
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Blueline week grid */}
      <div className="overflow-x-auto border border-border bg-card">
        <div className="grid min-w-[720px] grid-cols-7 divide-x divide-border">
          {days.map((d) => {
            const key = isoDay(d)
            const items = byDay.get(key) || []
            const isToday = key === todayIso
            const weekday = d.toLocaleDateString(undefined, { weekday: 'short' })
            const dayNum = d.getDate()

            return (
              <div
                key={key}
                className={cn(
                  'flex min-h-[220px] flex-col bg-card',
                  isToday && 'bg-rule/[0.04]'
                )}
              >
                <div
                  className={cn(
                    'flex items-baseline justify-between gap-1 border-b px-2.5 py-2',
                    isToday ? 'border-rule/50' : 'border-border'
                  )}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className={cn(
                        'text-[10px] font-semibold uppercase tracking-[0.08em]',
                        isToday ? 'text-rule' : 'text-muted-foreground'
                      )}
                    >
                      {weekday}
                    </span>
                    <span
                      className={cn(
                        'font-mono text-[13px] font-semibold tabular-nums',
                        isToday ? 'text-rule' : 'text-foreground'
                      )}
                    >
                      {dayNum}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-[10px] font-semibold uppercase tracking-[0.06em] text-rule hover:underline disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      setManualDay(key)
                      if (manualDay === key && manualTopic.trim()) void addManual(key)
                    }}
                  >
                    Add
                  </button>
                </div>

                <ul className="flex flex-1 flex-col gap-1.5 p-2">
                  {items.length === 0 && manualDay !== key && (
                    <li className="px-0.5 py-6 text-center text-[10px] text-muted-foreground/80">
                      —
                    </li>
                  )}
                  {items.map((p) => {
                    const mark = STATUS_MARK[p.status] || STATUS_MARK.draft
                    const formatKey = (p.format || 'feed').toLowerCase()
                    const formatTag = FORMAT_TAG[formatKey] || FORMAT_TAG.feed
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => onOpenPost(p)}
                          className="group w-full border border-border bg-background px-2 py-1.5 text-left transition-colors hover:border-rule/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rule"
                        >
                          <div className="mb-1 flex items-start justify-between gap-1">
                            <span
                              className={cn(
                                'inline-flex shrink-0 border px-1 py-px text-[8px] font-semibold uppercase tracking-[0.06em]',
                                formatTag.className
                              )}
                            >
                              {formatTag.label}
                            </span>
                            <span className="font-mono text-[9px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                              #{p.id}
                            </span>
                          </div>
                          <p className="line-clamp-2 text-[12px] font-medium leading-snug text-foreground">
                            {p.topic || `Post ${p.id}`}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span
                              className={cn(
                                'text-[9px] font-semibold uppercase tracking-[0.06em]',
                                mark.className
                              )}
                            >
                              {mark.label}
                            </span>
                            {p.pillar && (
                              <span className="truncate text-[9px] text-muted-foreground">
                                {p.pillar}
                              </span>
                            )}
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>

                {manualDay === key && (
                  <div className="border-t border-border p-2">
                    <Input
                      className="h-8 text-xs"
                      autoFocus
                      placeholder="Topic for this day…"
                      value={manualTopic}
                      disabled={busy}
                      onChange={(e) => setManualTopic(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void addManual(key)
                        if (e.key === 'Escape') {
                          setManualDay('')
                          setManualTopic('')
                        }
                      }}
                      onBlur={() => {
                        if (!manualTopic.trim()) setManualDay('')
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
