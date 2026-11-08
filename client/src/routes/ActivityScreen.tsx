import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { listActivity, type ActivityItem } from '../api'
import { Button } from '../components/ui/button'

type FilterKind = 'all' | 'post_version' | 'approval' | 'run' | 'auth'

const FILTERS: { key: FilterKind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'post_version', label: 'Posts' },
  { key: 'approval', label: 'Approvals' },
  { key: 'run', label: 'Runs' },
  { key: 'auth', label: 'Auth' },
]

type ActorStyle = { bg: string; ink: string; initial: string; label: string }

function actorStyle(item: ActivityItem): ActorStyle {
  const kind = item.actor_kind
  if (kind === 'mcp' || kind === 'operator_agent' || item.actor_client) {
    return {
      bg: 'var(--accent-soft)',
      ink: 'var(--accent-ink)',
      initial: 'M',
      label: item.actor_name || item.actor_client || 'MCP',
    }
  }
  if (kind === 'scheduler') {
    return {
      bg: 'var(--pill-warning-bg)',
      ink: 'var(--pill-warning-ink)',
      initial: 'S',
      label: 'Scheduler',
    }
  }
  if (kind === 'agent') {
    return {
      bg: 'var(--raised)',
      ink: 'var(--muted)',
      initial: 'A',
      label: item.actor_name || 'Agent',
    }
  }
  return {
    bg: 'var(--pill-neutral-bg)',
    ink: 'var(--pill-neutral-ink)',
    initial: 'Y',
    label: item.actor_name || 'You',
  }
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
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

function ActivityRow({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(false)
  const style = actorStyle(item)
  const isRun = item.kind === 'run'

  return (
    <div className="border-b border-[var(--rule)] last:border-0">
      <div className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--raised)] transition-colors">
        <div
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold mt-0.5"
          style={{ background: style.bg, color: style.ink }}
        >
          {style.initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--text)]">{style.label}</span>
            <span className="text-xs text-[var(--muted)]">{kindLabel(item.kind)}</span>
            {item.kind === 'approval' && Boolean(item.detail.decision) && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: item.detail.decision === 'approved' ? 'var(--pill-positive-bg)' : 'var(--pill-negative-bg)',
                  color: item.detail.decision === 'approved' ? 'var(--pill-positive-ink)' : 'var(--pill-negative-ink)',
                }}
              >
                {String(item.detail.decision)} · {String(item.detail.stage ?? '')}
              </span>
            )}
            {Boolean(item.detail.status) && item.kind === 'run' && (
              <span className="text-xs text-[var(--muted)]">({String(item.detail.status)})</span>
            )}
          </div>
          {item.post_id && (
            <Link
              to="/posts/$postId"
              params={{ postId: String(item.post_id) }}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              Post #{item.post_id}
            </Link>
          )}
          {Boolean(item.detail.comment) && (
            <p className="text-xs text-[var(--muted)] mt-0.5 truncate">{String(item.detail.comment ?? '')}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-[var(--muted)]">{relativeTime(item.created_at)}</span>
          {isRun && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              {expanded ? 'Hide' : 'Details'}
            </button>
          )}
        </div>
      </div>
      {isRun && expanded && (
        <div className="px-4 pb-3 ml-10">
          <pre className="text-xs bg-[var(--raised)] text-[var(--muted)] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(item.detail, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--rule)]">
      <div className="w-7 h-7 rounded-full bg-[var(--raised)] animate-pulse shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 bg-[var(--raised)] rounded w-1/3 animate-pulse" />
        <div className="h-2.5 bg-[var(--raised)] rounded w-1/4 animate-pulse" />
      </div>
      <div className="h-2.5 w-12 bg-[var(--raised)] rounded animate-pulse" />
    </div>
  )
}

export function ActivityScreen() {
  const [filter, setFilter] = useState<FilterKind>('all')
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['activity', filter],
    queryFn: () => listActivity({ limit: 100, kind: filter === 'all' ? undefined : filter }),
    refetchInterval: 30_000,
  })

  const items = data?.items ?? []

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-semibold text-[var(--text)]">Activity</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void qc.invalidateQueries({ queryKey: ['activity'] })}
          className="gap-1.5"
        >
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      <div className="flex gap-1 mb-4 border-b border-[var(--border)] pb-3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              filter === f.key
                ? 'bg-[var(--active)] text-[var(--accent-ink)] font-medium'
                : 'text-[var(--muted)] hover:bg-[var(--raised)]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="text-sm text-[var(--negative)] bg-[var(--pill-negative-bg)] px-3 py-2 rounded mb-4">
          Failed to load activity.
        </div>
      )}

      <div className="bg-[var(--surface)] rounded-[var(--radius-card)] border border-[var(--border)]">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-[var(--muted)] mb-3">No activity yet.</p>
            <Link to="/inbox" className="text-sm text-[var(--accent)] hover:underline">
              Go to inbox
            </Link>
          </div>
        ) : (
          items.map((item, i) => <ActivityRow key={`${item.kind}-${item.created_at}-${i}`} item={item} />)
        )}
      </div>
    </div>
  )
}
