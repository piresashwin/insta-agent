import { useEffect, useState } from 'react'
import type { BrandProfile, BackgroundStyle } from '@instagram-agent/shared'
import { BACKGROUND_STYLES } from '../lib/background-styles'
import {
  createBrandProfile,
  deleteBrandProfile,
  generateBrandProfile,
  listBrandProfiles,
  updateBrandProfile,
} from '../api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { cn } from '../lib/utils'

const DAYS = [
  { id: 'mon', label: 'M' },
  { id: 'tue', label: 'T' },
  { id: 'wed', label: 'W' },
  { id: 'thu', label: 'T' },
  { id: 'fri', label: 'F' },
  { id: 'sat', label: 'S' },
  { id: 'sun', label: 'S' },
]

function parseDays(raw: string | null): string[] {
  if (!raw) return ['mon', 'wed', 'fri']
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.map(String)
  } catch {
    /* ignore */
  }
  return ['mon', 'wed', 'fri']
}

function pillarsToText(raw: string | null): string {
  if (!raw) return ''
  try {
    const v = JSON.parse(raw) as unknown
    if (Array.isArray(v)) {
      return v
        .map((p) => (typeof p === 'string' ? p : (p as { name?: string }).name || ''))
        .filter(Boolean)
        .join('\n')
    }
  } catch {
    return raw
  }
  return raw
}

function emptyDraft(): Partial<BrandProfile> & { name: string } {
  return {
    name: '',
    niche: '',
    audience: '',
    goals: '',
    pillars: '[]',
    posts_per_week: 3,
    preferred_days: JSON.stringify(['mon', 'wed', 'fri']),
    voice: '',
    examples: '',
    visual: '',
    default_background_style: 'lifestyle',
    default_format: 'feed',
    guide_md: '',
  }
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </span>
  )
}

function SectionRule({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-rule">
        {title}
      </span>
      <span className="h-px flex-1 bg-rule/35" />
    </div>
  )
}

const areaClass =
  'min-h-[72px] w-full rounded-sm border border-input bg-card px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-rule'

type Props = {
  onError: (msg: string | null) => void
}

export function BrandProfilesPanel({ onError }: Props) {
  const [brands, setBrands] = useState<BrandProfile[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiFeedback, setAiFeedback] = useState('')
  const [pillarsText, setPillarsText] = useState('')
  const [days, setDays] = useState<string[]>(['mon', 'wed', 'fri'])

  async function refresh() {
    const { brands: list } = await listBrandProfiles()
    setBrands(list)
    return list
  }

  useEffect(() => {
    void refresh().catch((e) => onError(e instanceof Error ? e.message : 'Failed to load brands'))
  }, [onError])

  function loadBrand(b: BrandProfile) {
    setSelectedId(b.id)
    setDraft({ ...b })
    setPillarsText(pillarsToText(b.pillars))
    setDays(parseDays(b.preferred_days))
  }

  function startNew() {
    setSelectedId(null)
    setDraft(emptyDraft())
    setPillarsText('')
    setDays(['mon', 'wed', 'fri'])
  }

  async function save() {
    setBusy(true)
    onError(null)
    try {
      const pillars = pillarsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }))
      const body = {
        ...draft,
        name: (draft.name || '').trim(),
        pillars,
        preferred_days: days,
        posts_per_week: Number(draft.posts_per_week) || 3,
      }
      if (!body.name) throw new Error('Name is required')
      if (selectedId) {
        const { brand } = await updateBrandProfile(selectedId, body)
        loadBrand(brand)
      } else {
        const { brand } = await createBrandProfile(body as { name: string })
        loadBrand(brand)
      }
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save brand failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!selectedId) return
    if (!confirm('Delete this brand profile?')) return
    setBusy(true)
    onError(null)
    try {
      await deleteBrandProfile(selectedId)
      startNew()
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  async function generateWithAi() {
    const feedback = aiFeedback.trim()
    if (!feedback) {
      onError('Describe the brand first — who it is, who it serves, tone, look.')
      return
    }
    setGenerating(true)
    onError(null)
    try {
      const { draft: gen } = await generateBrandProfile({
        feedback,
        name: draft.name || undefined,
      })
      const pillarLines = (gen.pillars || [])
        .map((p) => (typeof p === 'string' ? p : p.name))
        .filter(Boolean)
      setDraft((d) => ({
        ...d,
        name: gen.name || d.name,
        niche: gen.niche,
        audience: gen.audience,
        goals: gen.goals,
        posts_per_week: gen.posts_per_week,
        voice: gen.voice,
        examples: gen.examples,
        visual: gen.visual,
        default_background_style: gen.default_background_style as BackgroundStyle,
        default_format: gen.default_format,
        guide_md: gen.guide_md,
      }))
      setPillarsText(pillarLines.join('\n'))
      setDays(
        Array.isArray(gen.preferred_days) && gen.preferred_days.length
          ? gen.preferred_days.map(String)
          : ['mon', 'wed', 'fri']
      )
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Generate failed')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="dash-in grid gap-0 overflow-hidden border border-border bg-card lg:grid-cols-[220px_minmax(0,1fr)]">
      {/* Profile rail */}
      <aside className="border-b border-border lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between border-b border-rule/40 px-3 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Profiles</h2>
          <Button size="sm" variant="outline" disabled={busy} onClick={startNew}>
            New
          </Button>
        </div>
        <ul className="max-h-[280px] overflow-y-auto lg:max-h-[calc(100vh-11rem)]">
          {brands.map((b) => (
            <li key={b.id} className="border-b border-border last:border-0">
              <button
                type="button"
                onClick={() => loadBrand(b)}
                className={cn(
                  'flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left transition-colors',
                  selectedId === b.id
                    ? 'bg-rule/8'
                    : 'hover:bg-muted/50'
                )}
              >
                <div className="min-w-0">
                  <p
                    className={cn(
                      'truncate text-sm font-semibold',
                      selectedId === b.id ? 'text-foreground' : 'text-foreground'
                    )}
                  >
                    {b.name}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                    {b.niche || 'No niche set'}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {b.posts_per_week}/wk
                </span>
              </button>
              {selectedId === b.id && <div className="h-0.5 bg-rule" />}
            </li>
          ))}
          {brands.length === 0 && (
            <li className="px-3 py-8 text-center text-xs text-muted-foreground">
              No profiles yet.
              <br />
              New starts a blank sheet.
            </li>
          )}
        </ul>
      </aside>

      {/* Editor sheet */}
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule/40 px-4 py-2.5">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">
              {selectedId ? draft.name || 'Untitled' : 'New brand'}
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Direction for copy, calendar fill, and image generation.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selectedId && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
                Delete
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : selectedId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>

        <div className="space-y-5 p-4 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto">
          <div className="border border-rule/40 bg-rule/[0.04] p-3">
            <FieldLabel>Generate with AI</FieldLabel>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Paste notes about the brand — niche, audience, tone, visuals. AI fills the
              fields below; review then Save. Uses chat model (OPENAI_*), not image keys.
            </p>
            <textarea
              className={cn(areaClass, 'min-h-[88px] bg-card')}
              value={aiFeedback}
              disabled={busy || generating}
              onChange={(e) => setAiFeedback(e.target.value)}
              placeholder="e.g. Specialty coffee for remote workers. Warm, practical, no hype. Flat-lay brew gear and cozy desks. 3 posts/week Mon Wed Fri…"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy || generating || !aiFeedback.trim()}
                onClick={() => void generateWithAi()}
              >
                {generating ? 'Generating…' : 'Generate with AI'}
              </Button>
              {generating && (
                <span className="text-[11px] text-muted-foreground">
                  Usually 15–40s while the model drafts…
                </span>
              )}
            </div>
          </div>

          <label className="block">
            <FieldLabel>Name</FieldLabel>
            <Input
              value={draft.name || ''}
              disabled={busy || generating}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Acme Coffee"
            />
          </label>

          <SectionRule title="Direction" />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <FieldLabel>Niche</FieldLabel>
              <Input
                value={draft.niche || ''}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, niche: e.target.value }))}
                placeholder="Specialty coffee for remote workers"
              />
            </label>
            <label className="block">
              <FieldLabel>Audience</FieldLabel>
              <Input
                value={draft.audience || ''}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, audience: e.target.value }))}
              />
            </label>
            <label className="block">
              <FieldLabel>Goals</FieldLabel>
              <Input
                value={draft.goals || ''}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, goals: e.target.value }))}
                placeholder="Saves · profile visits"
              />
            </label>
            <label className="block sm:col-span-2">
              <FieldLabel>Pillars — one per line</FieldLabel>
              <textarea
                className={areaClass}
                value={pillarsText}
                disabled={busy}
                onChange={(e) => setPillarsText(e.target.value)}
                placeholder={'Brew tips\nBehind the bar\nProduct drops'}
              />
            </label>
          </div>

          <SectionRule title="Cadence" />
          <div className="flex flex-wrap items-end gap-4">
            <label className="block">
              <FieldLabel>Posts / week</FieldLabel>
              <Input
                type="number"
                className="w-20 font-mono"
                min={1}
                max={14}
                value={draft.posts_per_week ?? 3}
                disabled={busy}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, posts_per_week: Number(e.target.value) || 3 }))
                }
              />
            </label>
            <div>
              <FieldLabel>Preferred days</FieldLabel>
              <div className="flex gap-1">
                {DAYS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    title={d.id}
                    disabled={busy}
                    onClick={() =>
                      setDays((prev) =>
                        prev.includes(d.id) ? prev.filter((x) => x !== d.id) : [...prev, d.id]
                      )
                    }
                    className={cn(
                      'flex h-8 w-8 items-center justify-center border text-[11px] font-semibold transition-colors',
                      days.includes(d.id)
                        ? 'border-rule bg-rule text-white'
                        : 'border-border bg-card text-muted-foreground hover:border-rule/40'
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <SectionRule title="Voice" />
          <label className="block">
            <FieldLabel>Voice — adjectives, do / don’t</FieldLabel>
            <textarea
              className={areaClass}
              value={draft.voice || ''}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, voice: e.target.value }))}
            />
          </label>
          <label className="block">
            <FieldLabel>Examples — good / bad snippets</FieldLabel>
            <textarea
              className={areaClass}
              value={draft.examples || ''}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, examples: e.target.value }))}
            />
          </label>

          <SectionRule title="Visual" />
          <label className="block">
            <FieldLabel>Visual direction — style, must / avoid</FieldLabel>
            <textarea
              className={areaClass}
              value={draft.visual || ''}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, visual: e.target.value }))}
            />
          </label>
          <div>
            <FieldLabel>Default background</FieldLabel>
            <div className="flex flex-wrap gap-1">
              {BACKGROUND_STYLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      default_background_style: s.id as BackgroundStyle,
                    }))
                  }
                  className={cn(
                    'border px-2 py-1 text-[11px] font-medium transition-colors',
                    draft.default_background_style === s.id
                      ? 'border-rule bg-rule/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-rule/40'
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>Default format</FieldLabel>
            <div className="flex gap-1">
              {(['feed', 'reel', 'carousel'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  disabled={busy}
                  onClick={() => setDraft((d) => ({ ...d, default_format: f }))}
                  className={cn(
                    'border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
                    draft.default_format === f
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:border-foreground/30'
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          <SectionRule title="Notes" />
          <label className="block">
            <FieldLabel>Long-form guide (optional)</FieldLabel>
            <textarea
              className={cn(areaClass, 'min-h-[100px]')}
              value={draft.guide_md || ''}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, guide_md: e.target.value }))}
            />
          </label>
        </div>
      </div>
    </div>
  )
}
