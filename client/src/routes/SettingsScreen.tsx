import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, AlertTriangle, CheckCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  listInstagramConnections,
  deleteInstagramConnection,
  instagramOAuthStartUrl,
  getBudget,
  getBudgetSettings,
  saveBudgetSettings,
  type BudgetSettings,
  type InstagramConnection,
} from '../api'
import { Button } from '../components/ui/button'

type TabKey = 'accounts' | 'budget' | 'models' | 'advanced'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'budget', label: 'Budget' },
  { key: 'models', label: 'Models' },
  { key: 'advanced', label: 'Advanced' },
]

// ---- Accounts Tab ----

function daysUntil(dateStr: string | undefined): number | null {
  if (!dateStr) return null
  const diff = new Date(dateStr).getTime() - Date.now()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

function AccountsTab() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['ig-connections'],
    queryFn: listInstagramConnections,
  })

  const disconnect = useMutation({
    mutationFn: (id: number) => deleteInstagramConnection(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ig-connections'] })
      toast.success('Account disconnected')
    },
    onError: () => toast.error('Failed to disconnect'),
  })

  const connections: InstagramConnection[] = (data as { connections?: InstagramConnection[] })?.connections ?? []

  if (isLoading) {
    return <div className="h-24 bg-[var(--raised)] rounded animate-pulse" />
  }

  if (error) {
    return (
      <div className="text-sm text-[var(--negative)] bg-[var(--pill-negative-bg)] px-3 py-2 rounded">
        Failed to load account info.
      </div>
    )
  }

  if (connections.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm text-[var(--muted)] mb-4">No Instagram account connected.</p>
        <a
          href="/api/auth/instagram/start"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-control)] bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <ExternalLink size={14} />
          Connect Instagram
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {connections.map((conn) => {
        const expiry = daysUntil(conn.token_expires_at as string | undefined)
        const expiringSoon = expiry !== null && expiry < 7

        return (
          <div
            key={conn.id}
            className="border border-[var(--border)] rounded-[var(--radius-card)] p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--raised)] flex items-center justify-center text-sm font-semibold text-[var(--muted)]">
                  {(conn.account_id || '?')[0].toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--text)]">@{conn.account_id || 'unknown'}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {conn.status === 'active' ? (
                      <span className="flex items-center gap-1 text-xs text-[var(--positive)]">
                        <CheckCircle size={11} />
                        Connected
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">{conn.status}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={instagramOAuthStartUrl(conn.id)}
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  Reconnect
                </a>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnect.mutate(conn.id)}
                  disabled={disconnect.isPending}
                  className="text-[var(--negative)] border-[var(--negative)]/30 hover:bg-[var(--pill-negative-bg)]"
                >
                  Disconnect
                </Button>
              </div>
            </div>

            {expiringSoon && (
              <div className="mt-3 flex items-center gap-2 text-xs text-[var(--warning)] bg-[var(--pill-warning-bg)] px-3 py-2 rounded">
                <AlertTriangle size={12} />
                Token expires in {expiry} day{expiry === 1 ? '' : 's'} — reconnect to refresh.
              </div>
            )}
          </div>
        )
      })}

      <a
        href="/api/auth/instagram/start"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline mt-2"
      >
        <ExternalLink size={13} />
        Add another account
      </a>
    </div>
  )
}

// ---- Budget Tab ----

function BudgetTab() {
  const qc = useQueryClient()

  const { data: budget } = useQuery({
    queryKey: ['budget'],
    queryFn: getBudget,
  })

  const { data: settings, isLoading } = useQuery({
    queryKey: ['budget-settings'],
    queryFn: getBudgetSettings,
  })

  const [form, setForm] = useState<Partial<BudgetSettings>>({})
  const dirty = Object.keys(form).length > 0

  const save = useMutation({
    mutationFn: (body: Partial<BudgetSettings>) => saveBudgetSettings(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['budget-settings'] })
      void qc.invalidateQueries({ queryKey: ['budget'] })
      setForm({})
      toast.success('Budget settings saved')
    },
    onError: () => toast.error('Failed to save budget settings'),
  })

  if (isLoading || !settings) {
    return <div className="h-32 bg-[var(--raised)] rounded animate-pulse" />
  }

  const current = { ...settings, ...form }
  const pct = budget ? Math.min((budget.spent / budget.cap) * 100, 100) : 0
  const nearCap = pct >= 80

  function field(key: keyof BudgetSettings, label: string, suffix = '') {
    return (
      <div>
        <label className="block text-sm text-[var(--muted)] mb-1">{label}</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            step="0.01"
            min="0"
            value={current[key]}
            onChange={(e) =>
              setForm((f) => ({ ...f, [key]: key.includes('rerolls') ? parseInt(e.target.value) : parseFloat(e.target.value) }))
            }
            className="w-28 h-8 px-2 text-sm border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
          />
          {suffix && <span className="text-sm text-[var(--muted)]">{suffix}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {budget && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm text-[var(--muted)]">This month</span>
            <span className="text-sm tabular-nums font-medium text-[var(--text)]">
              ${budget.spent.toFixed(2)} of ${budget.cap.toFixed(0)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-[var(--raised)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${pct}%`,
                background: nearCap ? 'var(--warning)' : 'var(--accent)',
              }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-[var(--muted)]">
              Forecast: ${budget.forecast.toFixed(2)}
            </span>
            {budget.at_capacity && (
              <span className="text-xs text-[var(--negative)] font-medium">Cap reached</span>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {field('budget_monthly_usd', 'Monthly cap', '/ mo')}
        {field('budget_per_post_soft_usd', 'Soft per-post cap', '/ post')}
        {field('budget_max_image_rerolls', 'Max image re-rolls')}
        {field('budget_max_reel_rerolls', 'Max reel re-rolls')}
      </div>

      {dirty && (
        <Button
          onClick={() => save.mutate(form)}
          disabled={save.isPending}
          className="bg-[var(--accent)] text-white hover:opacity-90"
          size="sm"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      )}
    </div>
  )
}

// ---- Models Tab ----

const MODEL_ROLES = [
  { role: 'Writer', model: 'Claude Sonnet 5.5', note: 'Plan, hooks, caption' },
  { role: 'Judge', model: 'Gemini 3.8 Flash', note: 'Rubric scoring, pairwise picks' },
  { role: 'Research', model: 'Gemini 3.8 Flash', note: 'Topic research, routing' },
  { role: 'Vision', model: 'Claude Sonnet 5.5', note: 'Media QA' },
]

function ModelsTab() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">
        Model roles are configured via environment variables. Set them in <code className="text-xs bg-[var(--raised)] px-1 py-0.5 rounded">.env.local</code> in the project root.
      </p>
      <div className="border border-[var(--border)] rounded-[var(--radius-card)] overflow-hidden">
        {MODEL_ROLES.map((r, i) => (
          <div
            key={r.role}
            className={`flex items-center gap-4 px-4 py-3 ${i < MODEL_ROLES.length - 1 ? 'border-b border-[var(--rule)]' : ''}`}
          >
            <span className="w-20 text-sm font-medium text-[var(--text)]">{r.role}</span>
            <span className="flex-1 text-sm text-[var(--muted)]">{r.model}</span>
            <span className="text-xs text-[var(--faint)]">{r.note}</span>
          </div>
        ))}
      </div>
      <div className="bg-[var(--raised)] rounded-[var(--radius-control)] px-4 py-3 text-sm text-[var(--muted)]">
        Set <code className="text-xs bg-[var(--surface)] px-1 rounded">LLM_WRITER</code>,{' '}
        <code className="text-xs bg-[var(--surface)] px-1 rounded">LLM_JUDGE</code> etc. to override defaults.
        All text models route through Runware.
      </div>
    </div>
  )
}

// ---- Advanced Tab ----

function AdvancedTab() {
  const mockMode = import.meta.env.VITE_MOCK === '1'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border border-[var(--border)] rounded-[var(--radius-card)] px-4 py-3">
        <div>
          <p className="text-sm font-medium text-[var(--text)]">Mock mode</p>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Returns fake data instead of hitting live APIs. Set via <code className="text-xs bg-[var(--raised)] px-1 rounded">VITE_MOCK=1</code>.
          </p>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded font-medium ${
            mockMode
              ? 'bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]'
              : 'bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]'
          }`}
        >
          {mockMode ? 'On' : 'Off'}
        </span>
      </div>
    </div>
  )
}

// ---- Root ----

export function SettingsScreen() {
  const [tab, setTab] = useState<TabKey>('accounts')

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <h1 className="text-2xl font-semibold text-[var(--text)] mb-6">Settings</h1>

      <div className="flex gap-0">
        <nav className="w-44 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`w-full text-left px-3 py-2 text-sm rounded-[var(--radius-control)] mb-0.5 transition-colors ${
                tab === t.key
                  ? 'bg-[var(--active)] text-[var(--accent-ink)] font-medium'
                  : 'text-[var(--muted)] hover:bg-[var(--raised)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 pl-8">
          {tab === 'accounts' && <AccountsTab />}
          {tab === 'budget' && <BudgetTab />}
          {tab === 'models' && <ModelsTab />}
          {tab === 'advanced' && <AdvancedTab />}
        </div>
      </div>
    </div>
  )
}
