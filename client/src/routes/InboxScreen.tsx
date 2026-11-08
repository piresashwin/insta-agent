/**
 * Phase 2 Inbox: split-pane list + detail with stage tabs, keyboard shortcuts, bulk approve.
 */
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  listPosts,
  bulkApprovePosts,
  type Post,
} from '../api'
import { PostScreen } from './PostScreen'

// ---- Stage tab config ----
type Stage = {
  key: string
  label: string
  statuses: string[]
  count?: number
}

const STAGES: Stage[] = [
  { key: 'copy', label: 'Needs copy OK', statuses: ['pending_approval'] },
  { key: 'media', label: 'Needs media OK', statuses: ['media_ready'] },
  { key: 'changes', label: 'Changes requested', statuses: ['changes_requested'] },
  { key: 'failed', label: 'Failed', statuses: ['failed'] },
  { key: 'scheduled', label: 'Scheduled', statuses: ['staged'] },
]


// ---- Format labels ----
const FORMAT_LABEL: Record<string, string> = {
  feed: 'Feed',
  carousel: 'Carousel',
  reel: 'Reel',
}

function formatRelTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending_approval: 'var(--accent)',
    approved: 'var(--positive)',
    media_ready: 'var(--positive)',
    changes_requested: 'var(--warning)',
    failed: 'var(--negative)',
    staged: 'var(--chart-2)',
  }
  const bg = map[status] ?? 'var(--muted)'
  return (
    <span
      className="text-[11px] px-1.5 py-0.5 rounded font-medium"
      style={{ background: bg + '22', color: bg }}
    >
      {status.replace(/_/g, ' ')}
    </span>
  )
}

// ---- Post row ----
type PostRowProps = {
  post: Post
  selected: boolean
  bulkMode: boolean
  checked: boolean
  onSelect: (id: number) => void
  onToggle: (id: number) => void
}

function PostRow({ post, selected, bulkMode, checked, onSelect, onToggle }: PostRowProps) {
  const hook = post.hook?.slice(0, 72) ?? '(no hook)'
  const fmt = FORMAT_LABEL[(post.format ?? 'feed').toLowerCase()] ?? 'Feed'
  const age = formatRelTime(post.created_at ?? '')

  return (
    <button
      onClick={() => { if (bulkMode) onToggle(post.id); else onSelect(post.id) }}
      className="w-full text-left flex items-start gap-3 px-4 py-3 border-b border-[var(--rule)] transition-colors"
      style={{ background: selected ? 'var(--active)' : 'transparent' }}
    >
      {bulkMode && (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(post.id)}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 h-4 w-4 accent-[var(--accent)] shrink-0"
        />
      )}
      {/* Thumbnail placeholder */}
      <div className="w-10 h-10 rounded bg-[var(--raised)] shrink-0 flex items-center justify-center text-[10px] text-[var(--muted)]">
        {fmt[0]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text)] truncate leading-snug">{hook}</p>
        <p className="text-[12px] text-[var(--muted)] mt-0.5">
          {fmt} · {age}
        </p>
      </div>
      <div className="shrink-0">
        <StatusPill status={post.status} />
      </div>
    </button>
  )
}

// ---- Inbox ----
export function InboxScreen() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [activeStage, setActiveStage] = useState('copy')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [bulkMode, setBulkMode] = useState(false)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  // Fetch all posts (we filter client-side by stage tab)
  const { data, isLoading } = useQuery({
    queryKey: ['posts'],
    queryFn: () => listPosts(''),
    refetchInterval: 30_000,
  })
  const allPosts: Post[] = data?.posts ?? []

  // Staged posts for each stage tab
  const postsForStage = (stageKey: string): Post[] => {
    const stage = STAGES.find((s) => s.key === stageKey)
    if (!stage) return []
    return allPosts.filter((p) => stage.statuses.includes(p.status))
  }

  const visiblePosts = postsForStage(activeStage)

  // Auto-select first post when stage changes
  useEffect(() => {
    if (visiblePosts.length > 0 && (selectedId === null || !visiblePosts.find((p) => p.id === selectedId))) {
      setSelectedId(visiblePosts[0].id)
    } else if (visiblePosts.length === 0) {
      setSelectedId(null)
    }
  }, [activeStage, allPosts.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard navigation
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const idx = visiblePosts.findIndex((p) => p.id === selectedId)
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = visiblePosts[idx + 1]
        if (next) setSelectedId(next.id)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = visiblePosts[idx - 1]
        if (prev) setSelectedId(prev.id)
      } else if (e.key === 'e' && selectedId != null) {
        void navigate({ to: '/posts/$postId', params: { postId: String(selectedId) } })
      }
    },
    [visiblePosts, selectedId, navigate]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  // Bulk toggle
  function toggleCheck(id: number) {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function handleBulkApprove() {
    if (checkedIds.size === 0) return
    setBulkBusy(true)
    try {
      const r = await bulkApprovePosts([...checkedIds])
      toast.success(`Approved ${r.approved.length} post${r.approved.length !== 1 ? 's' : ''}`)
      if (r.skipped.length) toast.warning(`Skipped ${r.skipped.length}: ${r.skipped[0].reason}`)
      setCheckedIds(new Set())
      setBulkMode(false)
      void qc.invalidateQueries({ queryKey: ['posts'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk approve failed')
    } finally {
      setBulkBusy(false)
    }
  }

  const selectedPost = visiblePosts.find((p) => p.id === selectedId)

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--ground)' }}>
      {/* Stage tabs */}
      <div
        className="flex items-center gap-0 px-4 border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', height: 44 }}
      >
        {STAGES.map((stage) => {
          const count = postsForStage(stage.key).length
          const active = activeStage === stage.key
          return (
            <button
              key={stage.key}
              onClick={() => { setActiveStage(stage.key); setBulkMode(false); setCheckedIds(new Set()) }}
              className="relative flex items-center gap-1.5 px-3 h-full text-sm transition-colors"
              style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}
            >
              {stage.label}
              {count > 0 && (
                <span
                  className="text-[11px] font-medium px-1.5 rounded-full"
                  style={{
                    background: active ? 'var(--accent)' : 'var(--raised)',
                    color: active ? '#fff' : 'var(--muted)',
                  }}
                >
                  {count}
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

        <div className="ml-auto flex items-center gap-2">
          {activeStage === 'copy' && (
            <button
              onClick={() => { setBulkMode((b) => !b); setCheckedIds(new Set()) }}
              className="text-xs px-2 py-1 rounded border transition-colors"
              style={{
                borderColor: bulkMode ? 'var(--accent)' : 'var(--control)',
                color: bulkMode ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              {bulkMode ? 'Cancel' : 'Bulk'}
            </button>
          )}
          {bulkMode && checkedIds.size > 0 && (
            <button
              disabled={bulkBusy}
              onClick={() => void handleBulkApprove()}
              className="text-xs px-3 py-1 rounded font-medium transition-opacity"
              style={{ background: 'var(--accent)', color: '#fff', opacity: bulkBusy ? 0.6 : 1 }}
            >
              {bulkBusy ? 'Approving…' : `Approve ${checkedIds.size} that pass`}
            </button>
          )}
        </div>
      </div>

      {/* Split pane */}
      <div className="flex flex-1 min-h-0">
        {/* List */}
        <div
          className="w-[380px] shrink-0 overflow-y-auto border-r"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          {isLoading && (
            <div className="p-4 space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[72px] rounded bg-[var(--raised)] animate-pulse" />
              ))}
            </div>
          )}
          {!isLoading && visiblePosts.length === 0 && (
            <div className="p-6 text-center text-[var(--muted)] text-sm">
              <p>Nothing here.</p>
            </div>
          )}
          {visiblePosts.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              selected={selectedId === post.id}
              bulkMode={bulkMode}
              checked={checkedIds.has(post.id)}
              onSelect={setSelectedId}
              onToggle={toggleCheck}
            />
          ))}
        </div>

        {/* Detail */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selectedPost ? (
            <PostScreen inlinePostId={selectedPost.id} key={selectedPost.id} />
          ) : (
            <div className="flex items-center justify-center h-full text-[var(--muted)] text-sm">
              Select a post to review.
            </div>
          )}
        </div>
      </div>

      {/* Keyboard hint */}
      <div
        className="px-4 py-1.5 text-[11px] shrink-0 border-t"
        style={{ borderColor: 'var(--rule)', color: 'var(--faint)', background: 'var(--surface)' }}
      >
        j/k navigate · e open full · a approve · r request changes
      </div>
    </div>
  )
}
