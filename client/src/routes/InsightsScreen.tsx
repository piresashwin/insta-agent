import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  getInsightsAccount,
  getInsightsDigest,
  listInstagramConnections,
  listBrandProfiles,
} from '../api'

function sumField(
  rows: Array<{ reach?: number | null; views?: number | null; followers?: number | null }>,
  key: 'reach' | 'views' | 'followers',
): number {
  return rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0)
}

/** Minimal SVG line chart — avoids a charting-library install for Phase 4. */
function FollowersChart({
  data,
  publishDates,
}: {
  data: Array<{ fullDate: string; followers: number | null }>
  publishDates: Set<string>
}) {
  const pts = data.filter((d) => d.followers != null) as Array<{ fullDate: string; followers: number }>
  if (pts.length < 2) {
    return (
      <p className="p-4 text-xs text-[var(--muted)]">
        No daily metrics yet — sync runs every ~30 minutes.
      </p>
    )
  }
  const w = 640
  const h = 200
  const pad = 24
  const ys = pts.map((p) => p.followers)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanY = Math.max(maxY - minY, 1)
  const path = pts
    .map((p, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - pad * 2)
      const y = h - pad - ((p.followers - minY) / spanY) * (h - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" role="img" aria-label="Followers over time">
      <path d={path} fill="none" stroke="var(--accent, #b8336a)" strokeWidth="2" />
      {pts.map((p, i) => {
        if (!publishDates.has(p.fullDate)) return null
        const x = pad + (i / (pts.length - 1)) * (w - pad * 2)
        return (
          <line
            key={p.fullDate}
            x1={x}
            x2={x}
            y1={pad}
            y2={h - pad}
            stroke="var(--border)"
            strokeDasharray="2 2"
          />
        )
      })}
    </svg>
  )
}

export function InsightsScreen() {
  const { data: connData } = useQuery({
    queryKey: ['instagram-connections'],
    queryFn: listInstagramConnections,
  })
  const { data: brandsData } = useQuery({
    queryKey: ['brands'],
    queryFn: listBrandProfiles,
  })

  const connections = connData?.connections ?? []
  const brands = brandsData?.brands ?? []
  const [accountId, setAccountId] = useState<string>('')
  const [brandId, setBrandId] = useState<number | null>(null)

  const resolvedAccount =
    accountId ||
    connections.find((c) => c.status === 'connected' && !c.account_id.startsWith('pending:'))
      ?.account_id ||
    ''
  const resolvedBrand =
    brandId ??
    connections.find((c) => c.account_id === resolvedAccount)?.default_brand_profile_id ??
    brands[0]?.id ??
    null

  const accountQ = useQuery({
    queryKey: ['insights-account', resolvedAccount],
    queryFn: () => getInsightsAccount(resolvedAccount),
    enabled: !!resolvedAccount,
  })
  const digestQ = useQuery({
    queryKey: ['insights-digest', resolvedBrand],
    queryFn: () => getInsightsDigest(resolvedBrand!),
    enabled: resolvedBrand != null,
  })

  const dailyAsc = useMemo(() => {
    const rows = [...(accountQ.data?.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date))
    return rows
  }, [accountQ.data])

  const last28 = dailyAsc.slice(-28)
  const prior28 = dailyAsc.slice(-56, -28)
  const followersNow = last28.filter((d) => d.followers != null).at(-1)?.followers ?? null
  const followersPrior = prior28.filter((d) => d.followers != null).at(-1)?.followers ?? null
  const reach28 = sumField(last28, 'reach')
  const reachPrior = sumField(prior28, 'reach')
  const views28 = sumField(last28, 'views')
  const viewsPrior = sumField(prior28, 'views')

  const chartData = dailyAsc.map((d) => ({
    fullDate: d.date,
    followers: d.followers,
  }))
  const publishDates = new Set((accountQ.data?.publish_markers ?? []).map((m) => m.date))

  const digest = digestQ.data
  const insufficient = digest && 'insufficientData' in digest && digest.insufficientData

  return (
    <div className="h-full overflow-y-auto bg-[var(--background)] text-[var(--text)]">
      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-2 text-[var(--muted)]">
              Account
              <select
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
                value={resolvedAccount}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">Select…</option>
                {connections
                  .filter((c) => c.status === 'connected')
                  .map((c) => (
                    <option key={c.id} value={c.account_id}>
                      {c.ig_username || c.account_id}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[var(--muted)]">
              Brand
              <select
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
                value={resolvedBrand ?? ''}
                onChange={(e) => setBrandId(Number(e.target.value) || null)}
              >
                <option value="">Select…</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {digest && !insufficient && 'finding_line' in digest && (
            <p className="text-sm text-[var(--muted)]" data-testid="insights-finding">
              {digest.finding_line}
            </p>
          )}
          {insufficient && (
            <p className="text-sm text-[var(--muted)]" data-testid="insights-insufficient">
              Not enough posts yet ({digest.count} of {digest.needed}) — publish more to unlock the
              leaderboard.
            </p>
          )}
        </header>

        {!resolvedAccount ? (
          <p className="text-sm text-[var(--muted)]">Connect an Instagram account to see insights.</p>
        ) : accountQ.isLoading ? (
          <p className="text-sm text-[var(--muted)]">Loading account metrics…</p>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="insights-stat-strip">
              <Stat
                label="Followers"
                value={followersNow != null ? followersNow.toLocaleString() : '—'}
                baseline={
                  followersPrior != null && followersNow != null
                    ? `vs prior 28d: ${followersNow - followersPrior >= 0 ? '+' : ''}${followersNow - followersPrior}`
                    : 'vs prior 28 days'
                }
              />
              <Stat
                label="Reach 28d"
                value={reach28 ? reach28.toLocaleString() : '—'}
                baseline={
                  reachPrior
                    ? `vs prior 28d: ${(((reach28 - reachPrior) / Math.max(reachPrior, 1)) * 100).toFixed(0)}%`
                    : 'vs prior 28 days'
                }
              />
              <Stat
                label="Views 28d"
                value={views28 ? views28.toLocaleString() : '—'}
                baseline={
                  viewsPrior
                    ? `vs prior 28d: ${(((views28 - viewsPrior) / Math.max(viewsPrior, 1)) * 100).toFixed(0)}%`
                    : 'vs prior 28 days'
                }
              />
              <Stat
                label="Saves / reach"
                value={
                  digest && !insufficient && 'median_score' in digest
                    ? digest.median_score.toFixed(3)
                    : '—'
                }
                baseline="median lift score"
              />
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Followers / day</h2>
              <div className="h-56 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
                <FollowersChart data={chartData} publishDates={publishDates} />
              </div>
              <p className="text-[11px] text-[var(--muted)]">
                Dashed markers = publish days. Non-final days may still adjust (Meta delay up to 48h).
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Post leaderboard</h2>
              {insufficient || !digest || !('top' in digest) ? (
                <p className="text-xs text-[var(--muted)]" data-testid="insights-leaderboard-empty">
                  Leaderboard unlocks at 8 scored published posts.
                </p>
              ) : (
                <ul
                  className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]"
                  data-testid="insights-leaderboard"
                >
                  {digest.top.map((p) => (
                    <li
                      key={p.post_id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <Link
                        to="/posts/$postId"
                        params={{ postId: String(p.post_id) }}
                        className="truncate text-[var(--accent)] hover:underline"
                      >
                        {p.hook || `Post #${p.post_id}`}
                      </Link>
                      <span className="shrink-0 text-xs text-[var(--muted)]">
                        {p.format || '—'} · {p.score.toFixed(3)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {digest && !insufficient && 'lift_by_format' in digest && (
              <section className="grid gap-4 sm:grid-cols-2">
                <LiftList title="Format lift" rows={digest.lift_by_format} />
                <LiftList title="Pillar lift" rows={digest.lift_by_pillar} />
              </section>
            )}

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Best times</h2>
              <p className="text-xs text-[var(--muted)]">
                Not enough signal yet to recommend posting windows (needs more history + online
                followers access).
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Audience</h2>
              {accountQ.data?.audience &&
              typeof accountQ.data.audience === 'object' &&
              'hidden' in accountQ.data.audience &&
              accountQ.data.audience.hidden ? (
                <p className="text-xs text-[var(--muted)]" data-testid="insights-audience-hidden">
                  Hidden — {accountQ.data.audience.reason} (Meta API restriction).
                </p>
              ) : accountQ.data?.audience && 'captured_at' in accountQ.data.audience ? (
                <p className="text-xs text-[var(--muted)]">
                  Snapshot {new Date(accountQ.data.audience.captured_at).toLocaleString()}
                  {accountQ.data.audience.follower_count_at_capture != null
                    ? ` · ${accountQ.data.audience.follower_count_at_capture} followers`
                    : ''}
                </p>
              ) : (
                <p className="text-xs text-[var(--muted)]">No audience snapshot yet.</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  baseline,
}: {
  label: string
  value: string
  baseline: string
}) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-[var(--muted)]">{baseline}</p>
    </div>
  )
}

function LiftList({
  title,
  rows,
}: {
  title: string
  rows: Array<{ key: string; lift_vs_median: number; count: number }>
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="space-y-1 text-sm">
        {rows.length === 0 && <li className="text-xs text-[var(--muted)]">No data yet.</li>}
        {rows.map((r) => (
          <li key={r.key} className="flex justify-between gap-2 text-[var(--muted)]">
            <span>{r.key}</span>
            <span className="tabular-nums">
              {r.lift_vs_median >= 0 ? '+' : ''}
              {(r.lift_vs_median * 100).toFixed(0)}% · n={r.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
