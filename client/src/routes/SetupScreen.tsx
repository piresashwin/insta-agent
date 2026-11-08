import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { BrandProfile, InstagramConnection } from '@instagram-agent/shared'
import {
  listBrandProfiles,
  createBrandProfile,
  generateBrandProfile,
  listPosts,
  listInstagramConnections,
  mockConnectInstagram,
  instagramOAuthStartUrl,
  getBudgetSettings,
  saveBudgetSettings,
  getHealth,
  type HealthData,
} from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { cn } from '../lib/utils'

const LLM_ROLES = ['writer', 'judge', 'planner', 'vision'] as const

type SetupData = {
  brands: BrandProfile[]
  connections: InstagramConnection[]
  postCount: number
  budgetMonthly: number | null
  health: HealthData | null
}

export function SetupScreen() {
  const navigate = useNavigate()
  const [data, setData] = useState<SetupData>({
    brands: [],
    connections: [],
    postCount: 0,
    budgetMonthly: null,
    health: null,
  })
  const [loading, setLoading] = useState(true)
  const [activeStep, setActiveStep] = useState(0)

  const reload = useCallback(async () => {
    const [brandsRes, postsRes, connRes, budget] = await Promise.all([
      listBrandProfiles().catch(() => ({ brands: [] })),
      listPosts().catch(() => ({ posts: [] })),
      listInstagramConnections().catch(() => ({ connections: [] })),
      getBudgetSettings().catch(() => null),
    ])
    setData((prev) => ({
      ...prev,
      brands: brandsRes.brands,
      postCount: postsRes.posts.length,
      connections: connRes.connections,
      budgetMonthly: budget?.budget_monthly_usd ?? null,
    }))
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const firstBrand = data.brands[0]

  const completions = useMemo(
    () => [
      data.brands.some((b) => !!b.visual_identity && b.visual_identity !== '{}'),
      !!data.health && LLM_ROLES.every((r) => data.health?.checks[`llm_${r}`]?.ok),
      data.connections.some((c) => c.status === 'connected'),
      data.budgetMonthly != null && data.budgetMonthly > 0,
      data.postCount >= 3,
    ],
    [data]
  )

  const allComplete = completions.every(Boolean)

  // Auto-advance to the first incomplete step once data has loaded.
  useEffect(() => {
    if (loading) return
    const first = completions.findIndex((c) => !c)
    if (first !== -1) setActiveStep(first)
  }, [loading, completions])

  if (loading) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 text-[var(--muted)]">Loading setup…</div>
    )
  }

  const stepCount = completions.length
  const doneCount = completions.filter(Boolean).length

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold text-foreground">Set up your page</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Complete these steps to start generating posts.
      </p>

      <div className="mb-6 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(doneCount / stepCount) * 100}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {doneCount} of {stepCount}
        </span>
      </div>

      <div className="space-y-2">
        <StepBrand
          index={0}
          active={activeStep === 0}
          done={completions[0]}
          onActivate={() => setActiveStep(0)}
          onDone={reload}
        />
        <StepHealth
          index={1}
          active={activeStep === 1}
          done={completions[1]}
          health={data.health}
          onActivate={() => setActiveStep(1)}
          onLoaded={(h) => setData((p) => ({ ...p, health: h }))}
        />
        <StepInstagram
          index={2}
          active={activeStep === 2}
          done={completions[2]}
          connections={data.connections}
          onActivate={() => setActiveStep(2)}
          onDone={reload}
        />
        <StepBudget
          index={3}
          active={activeStep === 3}
          done={completions[3]}
          current={data.budgetMonthly}
          onActivate={() => setActiveStep(3)}
          onDone={reload}
        />
        <StepFirstWeek
          index={4}
          active={activeStep === 4}
          done={completions[4]}
          brand={firstBrand}
          postCount={data.postCount}
          onActivate={() => setActiveStep(4)}
          onDone={reload}
        />
      </div>

      {allComplete && (
        <div className="mt-6 rounded-lg border border-border bg-card p-4 text-center">
          <p className="mb-3 text-sm text-foreground">You're all set.</p>
          <Button onClick={() => void navigate({ to: '/inbox' })}>Go to Inbox</Button>
        </div>
      )}
    </div>
  )
}

function StepShell({
  index,
  title,
  description,
  active,
  done,
  onActivate,
  children,
}: {
  index: number
  title: string
  description: string
  active: boolean
  done: boolean
  onActivate: () => void
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-colors',
        active ? 'border-primary/60 bg-card' : 'border-border bg-card/50'
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="flex w-full items-center gap-3 text-left"
      >
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            done
              ? 'bg-primary text-primary-foreground'
              : 'border border-border text-muted-foreground'
          )}
        >
          {done ? '✓' : index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
      {active && <div className="mt-3 pl-9">{children}</div>}
    </div>
  )
}

function StepBrand({
  index,
  active,
  done,
  onActivate,
  onDone,
}: {
  index: number
  active: boolean
  done: boolean
  onActivate: () => void
  onDone: () => Promise<void>
}) {
  const [niche, setNiche] = useState('')
  const [busy, setBusy] = useState(false)

  async function generate() {
    if (!niche.trim()) return
    setBusy(true)
    try {
      const { draft } = await generateBrandProfile({ feedback: niche.trim() })
      await createBrandProfile({
        name: draft.name || niche.trim(),
        niche: draft.niche,
        audience: draft.audience,
        goals: draft.goals,
        posts_per_week: draft.posts_per_week,
        voice: draft.voice,
        guide_md: draft.guide_md,
      })
      toast.success('Brand created — review it on the Brand screen.')
      await onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Brand generation failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepShell
      index={index}
      title="Create your brand with AI"
      description={done ? 'Brand created' : 'Describe your niche and let AI draft the profile.'}
      active={active}
      done={done}
      onActivate={onActivate}
    >
      <p className="mb-2 text-xs text-muted-foreground">
        Give a one-line niche. Refine palette, voice and rubric afterwards on the Brand screen.
      </p>
      <Input
        value={niche}
        disabled={busy}
        onChange={(e) => setNiche(e.target.value)}
        placeholder="e.g. Specialty coffee for remote workers"
      />
      <div className="mt-2">
        <Button size="sm" disabled={busy || !niche.trim()} onClick={() => void generate()}>
          {busy ? 'Generating…' : 'Generate brand'}
        </Button>
      </div>
    </StepShell>
  )
}

function StepHealth({
  index,
  active,
  done,
  health,
  onActivate,
  onLoaded,
}: {
  index: number
  active: boolean
  done: boolean
  health: HealthData | null
  onActivate: () => void
  onLoaded: (h: HealthData) => void
}) {
  const [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    setBusy(true)
    try {
      const h = await getHealth()
      onLoaded(h)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Health check failed')
    } finally {
      setBusy(false)
    }
  }, [onLoaded])

  useEffect(() => {
    if (active && !health) void check()
  }, [active, health, check])

  return (
    <StepShell
      index={index}
      title="Check the models work"
      description={done ? 'All model roles reachable' : 'Verify each LLM role is configured.'}
      active={active}
      done={done}
      onActivate={onActivate}
    >
      <div className="space-y-1">
        {LLM_ROLES.map((role) => {
          const c = health?.checks[`llm_${role}`]
          return (
            <div key={role} className="flex items-center gap-2 text-sm">
              <span
                className={cn(
                  'inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                  c?.ok
                    ? 'bg-green-600/15 text-green-600 dark:text-green-400'
                    : 'bg-destructive/15 text-destructive'
                )}
              >
                {c?.ok ? '✓' : '×'}
              </span>
              <span className="capitalize text-foreground">{role}</span>
              {c?.detail && (
                <span className="text-xs text-muted-foreground">{c.detail}</span>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Re-check'}
        </Button>
      </div>
    </StepShell>
  )
}

function StepInstagram({
  index,
  active,
  done,
  connections,
  onActivate,
  onDone,
}: {
  index: number
  active: boolean
  done: boolean
  connections: InstagramConnection[]
  onActivate: () => void
  onDone: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const conn = connections[0]

  async function mock() {
    if (!conn) {
      toast.error('No Instagram connection row — add one in Settings first.')
      return
    }
    setBusy(true)
    try {
      await mockConnectInstagram(conn.id)
      toast.success('Mock account connected.')
      await onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Mock connect failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepShell
      index={index}
      title="Connect Instagram"
      description={done ? 'Account connected' : 'Link a business account, or use a mock in dev.'}
      active={active}
      done={done}
      onActivate={onActivate}
    >
      <p className="mb-2 text-xs text-muted-foreground">
        {conn
          ? `Connection #${conn.id} — status: ${conn.status}`
          : 'No connection configured yet. Add one under Settings → Accounts.'}
      </p>
      {conn?.needs_reconnect && (
        <div
          className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
          data-testid="reconnect-banner"
        >
          Reconnect required — this account is missing insights/comments scopes. Use Connect
          with Instagram to re-authorize.
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {conn && (
          <a href={instagramOAuthStartUrl(conn.id)}>
            <Button size="sm">{conn.needs_reconnect ? 'Reconnect Instagram' : 'Connect with Instagram'}</Button>
          </a>
        )}
        {conn && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void mock()}>
            {busy ? 'Connecting…' : 'Use mock account'}
          </Button>
        )}
      </div>
    </StepShell>
  )
}

function StepBudget({
  index,
  active,
  done,
  current,
  onActivate,
  onDone,
}: {
  index: number
  active: boolean
  done: boolean
  current: number | null
  onActivate: () => void
  onDone: () => Promise<void>
}) {
  const [value, setValue] = useState(current ?? 10)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (current != null) setValue(current)
  }, [current])

  async function save() {
    setBusy(true)
    try {
      await saveBudgetSettings({ budget_monthly_usd: value })
      toast.success(`Monthly budget set to $${value}.`)
      await onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Saving budget failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepShell
      index={index}
      title="Set your monthly budget"
      description={done ? `$${current} / month` : 'Cap your monthly spend (default $10).'}
      active={active}
      done={done}
      onActivate={onActivate}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <Input
          type="number"
          min={1}
          max={50}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-24"
        />
        <span className="text-sm text-muted-foreground">/ month</span>
      </div>
      <div className="mt-2">
        <Button size="sm" disabled={busy || value <= 0} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save budget'}
        </Button>
      </div>
    </StepShell>
  )
}

function StepFirstWeek({
  index,
  active,
  done,
  brand,
  postCount,
  onActivate,
}: {
  index: number
  active: boolean
  done: boolean
  brand: BrandProfile | undefined
  postCount: number
  onActivate: () => void
  onDone: () => Promise<void>
}) {
  const navigate = useNavigate()

  return (
    <StepShell
      index={index}
      title="Plan your first week"
      description={
        done
          ? `${postCount} posts ready`
          : 'Shortlist ideas and place them on days.'
      }
      active={active}
      done={done}
      onActivate={onActivate}
    >
      <p className="mb-2 text-xs text-muted-foreground">
        {brand
          ? `Open Plan to brainstorm and schedule posts for ${brand.name}.`
          : 'Create a brand in step 1 before planning.'}
      </p>
      <Button
        size="sm"
        disabled={!brand}
        onClick={() => navigate({ to: '/plan' })}
      >
        Plan your first week
      </Button>
    </StepShell>
  )
}
