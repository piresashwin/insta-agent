import { useEffect, useState } from 'react'
import type {
  BrandProfile,
  BackgroundStyle,
  VisualIdentity,
  FormatMix,
  VoiceRules,
  ExamplePost,
  HashtagSet,
} from '@instagram-agent/shared'
import { BACKGROUND_STYLES } from '../lib/background-styles'
import { CANVAS_FONTS, canvasFontCss, ensureGoogleFontsLoaded } from '../lib/canvas-fonts'
import {
  createBrandProfile,
  deleteBrandProfile,
  generateBrandProfile,
  generateVisualIdentity,
  listBrandProfiles,
  updateBrandProfile,
  getBrandRubric,
  saveBrandRubric,
  generateBrandRubric,
  type RubricCriterion,
  type BrandRubricData,
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
    visual_identity: null,
    format_mix: JSON.stringify({ feed: 1, reel: 1, carousel: 1 }),
    default_background_style: 'lifestyle',
    default_format: 'feed',
    default_max_slides: 5,
    guide_md: '',
  }
}

function parseVoiceRules(raw: string | null | undefined): VoiceRules {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as VoiceRules
  } catch {
    return {}
  }
}

function parseExamplePosts(raw: string | null | undefined): ExamplePost[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v as ExamplePost[]
  } catch {
    /* ignore */
  }
  return []
}

function parseHashtagSets(raw: string | null | undefined): HashtagSet[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v as HashtagSet[]
  } catch {
    /* ignore */
  }
  return []
}

function parseIdentity(raw: string | null | undefined): VisualIdentity {
  if (!raw?.trim()) return {}
  try {
    return JSON.parse(raw) as VisualIdentity
  } catch {
    return {}
  }
}

function parseMix(raw: string | null | undefined): FormatMix {
  if (!raw?.trim()) return { feed: 1, reel: 1, carousel: 1 }
  try {
    return JSON.parse(raw) as FormatMix
  } catch {
    return { feed: 1, reel: 1, carousel: 1 }
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

const BRAND_TABS = ['Basics', 'Voice', 'Look', 'Rubric', 'Advanced'] as const
type BrandTab = (typeof BRAND_TABS)[number]

/** Live preview of a sample post rendered in the brand's colors + fonts. */
function BrandSwatchCard({
  identity,
  sampleHook,
}: {
  identity: VisualIdentity
  sampleHook?: string
}) {
  const palette = identity.palette || {}
  const headingId = identity.typography?.heading_font
  const bodyId = identity.typography?.body_font

  useEffect(() => {
    ensureGoogleFontsLoaded([headingId, bodyId])
  }, [headingId, bodyId])

  const bg = palette.background || palette.primary || '#1a1a2e'
  const headingColor = palette.accent || palette.secondary || '#ffffff'
  const bodyColor = palette.primary || palette.secondary || '#e5e5e5'
  const hook = sampleHook?.trim() || 'Your hook, set in the brand heading font'

  return (
    <div
      className="flex aspect-[4/5] w-[220px] flex-col justify-between overflow-hidden rounded-md border border-border p-4"
      style={{ backgroundColor: bg }}
    >
      <span
        className="text-[10px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: bodyColor, fontFamily: canvasFontCss(bodyId), opacity: 0.7 }}
      >
        @yourbrand
      </span>
      <p
        className="text-[22px] font-bold leading-tight"
        style={{ color: headingColor, fontFamily: canvasFontCss(headingId) }}
      >
        {hook}
      </p>
      <p
        className="text-[11px] leading-snug"
        style={{ color: bodyColor, fontFamily: canvasFontCss(bodyId), opacity: 0.85 }}
      >
        A sample caption line showing the body font and color on your background.
      </p>
    </div>
  )
}

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
  const [identity, setIdentity] = useState<VisualIdentity>({})
  const [formatMix, setFormatMix] = useState<FormatMix>({ feed: 1, reel: 1, carousel: 1 })
  const [genIdentityBusy, setGenIdentityBusy] = useState(false)
  const [voiceRules, setVoiceRules] = useState<VoiceRules>({})
  const [examplePosts, setExamplePosts] = useState<ExamplePost[]>([])
  const [hashtagSets, setHashtagSets] = useState<HashtagSet[]>([])
  const [rubric, setRubric] = useState<BrandRubricData | null>(null)
  const [rubricBusy, setRubricBusy] = useState(false)
  const [rubricDirty, setRubricDirty] = useState(false)
  const [tab, setTab] = useState<BrandTab>('Basics')

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
    setIdentity(parseIdentity(b.visual_identity))
    setFormatMix(parseMix(b.format_mix))
    setVoiceRules(parseVoiceRules(b.voice_rules))
    setExamplePosts(parseExamplePosts(b.example_posts))
    setHashtagSets(parseHashtagSets(b.hashtag_sets))
    setRubric(null)
    setRubricDirty(false)
    void getBrandRubric(b.id).then(({ rubric: r }) => setRubric(r)).catch(() => null)
  }

  function startNew() {
    setSelectedId(null)
    setDraft(emptyDraft())
    setPillarsText('')
    setDays(['mon', 'wed', 'fri'])
    setIdentity({})
    setFormatMix({ feed: 1, reel: 1, carousel: 1 })
    setVoiceRules({})
    setExamplePosts([])
    setHashtagSets([])
    setRubric(null)
    setRubricDirty(false)
  }

  async function save() {
    setBusy(true)
    onError(null)
    try {
      // Serialize pillars and preferred_days to JSON strings — the server
      // stores and returns them as JSON-encoded strings in the DB.
      const pillarsArr = pillarsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }))
      const body = {
        ...draft,
        name: (draft.name || '').trim(),
        pillars: JSON.stringify(pillarsArr),
        preferred_days: JSON.stringify(days),
        posts_per_week: Number(draft.posts_per_week) || 3,
        visual_identity: JSON.stringify(identity),
        format_mix: JSON.stringify(formatMix),
        voice_rules: JSON.stringify(voiceRules),
        example_posts: JSON.stringify(examplePosts),
        hashtag_sets: JSON.stringify(hashtagSets),
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

          <div className="flex gap-5 border-b border-rule/40 -mt-1">
            {BRAND_TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  '-mb-px border-b-2 pb-2 text-[13px] font-medium transition-colors',
                  tab === t
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'Basics' && (
          <>
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

          </>
          )}

          {tab === 'Voice' && (
          <>
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

          {/* Structured voice rules */}
          <SectionRule title="Voice rules (structured)" />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <FieldLabel>Do — write like this (one per line)</FieldLabel>
              <textarea
                className={areaClass}
                rows={3}
                value={(voiceRules.do || []).join('\n')}
                disabled={busy}
                onChange={(e) =>
                  setVoiceRules((v) => ({
                    ...v,
                    do: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  }))
                }
                placeholder="Use short punchy sentences&#10;Start with the problem&#10;Always include a CTA"
              />
            </label>
            <label className="block sm:col-span-2">
              <FieldLabel>Don't — avoid these (one per line)</FieldLabel>
              <textarea
                className={areaClass}
                rows={3}
                value={(voiceRules.dont || []).join('\n')}
                disabled={busy}
                onChange={(e) =>
                  setVoiceRules((v) => ({
                    ...v,
                    dont: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  }))
                }
                placeholder="Don't use passive voice&#10;No corporate jargon&#10;Avoid vague claims"
              />
            </label>
            <label className="block sm:col-span-2">
              <FieldLabel>Banned words (comma-separated)</FieldLabel>
              <input
                className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                value={(voiceRules.banned_words || []).join(', ')}
                disabled={busy}
                onChange={(e) =>
                  setVoiceRules((v) => ({
                    ...v,
                    banned_words: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  }))
                }
                placeholder="synergy, leverage, disruptive"
              />
            </label>
            <div>
              <FieldLabel>Emoji policy</FieldLabel>
              <div className="flex gap-1 mt-1 flex-wrap">
                {(['none', 'sparing', 'moderate'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    onClick={() => setVoiceRules((v) => ({ ...v, emoji_policy: p }))}
                    className={cn(
                      'border px-2 py-1 text-[11px] font-medium transition-colors capitalize',
                      voiceRules.emoji_policy === p
                        ? 'border-rule bg-rule/10 text-foreground'
                        : 'border-border text-muted-foreground hover:border-rule/40'
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <FieldLabel>Caption length</FieldLabel>
              <div className="flex gap-1 mt-1 flex-wrap">
                {(['short', 'medium', 'long'] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    disabled={busy}
                    onClick={() => setVoiceRules((v) => ({ ...v, caption_length: l }))}
                    className={cn(
                      'border px-2 py-1 text-[11px] font-medium transition-colors capitalize',
                      voiceRules.caption_length === l
                        ? 'border-rule bg-rule/10 text-foreground'
                        : 'border-border text-muted-foreground hover:border-rule/40'
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Few-shot example posts */}
          <SectionRule title="Few-shot examples" />
          <p className="text-[11px] text-muted-foreground -mt-3 mb-1">
            Add 2–5 real posts. The agent uses these as style reference.
          </p>
          <div className="space-y-3">
            {examplePosts.map((ep, i) => (
              <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    Example {i + 1}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setExamplePosts((eps) => eps.filter((_, j) => j !== i))}
                    className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Remove
                  </button>
                </div>
                <label className="block">
                  <FieldLabel>Hook</FieldLabel>
                  <input
                    className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                    value={ep.hook}
                    disabled={busy}
                    onChange={(e) =>
                      setExamplePosts((eps) =>
                        eps.map((x, j) => j === i ? { ...x, hook: e.target.value } : x)
                      )
                    }
                    placeholder="Compelling hook text…"
                  />
                </label>
                <label className="block">
                  <FieldLabel>What works (optional)</FieldLabel>
                  <input
                    className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                    value={ep.what_works || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setExamplePosts((eps) =>
                        eps.map((x, j) => j === i ? { ...x, what_works: e.target.value } : x)
                      )
                    }
                    placeholder="Why this post worked well…"
                  />
                </label>
              </div>
            ))}
            {examplePosts.length < 5 && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setExamplePosts((eps) => [...eps, { hook: '', what_works: '' }])
                }
                className="text-xs border border-dashed border-border rounded-lg px-3 py-2 text-muted-foreground hover:border-primary/60 hover:text-foreground transition-colors w-full"
              >
                + Add example post
              </button>
            )}
          </div>

          {/* Hashtag sets */}
          <SectionRule title="Hashtag sets" />
          <p className="text-[11px] text-muted-foreground -mt-3 mb-1">
            Named groups of tags. Use always or pick a subset per post.
          </p>
          <div className="space-y-3">
            {hashtagSets.map((hs, i) => (
              <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    className="h-8 flex-1 rounded-sm border border-border bg-card px-2 text-sm font-medium"
                    value={hs.name}
                    disabled={busy}
                    onChange={(e) =>
                      setHashtagSets((sets) =>
                        sets.map((x, j) => j === i ? { ...x, name: e.target.value } : x)
                      )
                    }
                    placeholder="Set name (e.g. niche, broad, location)"
                  />
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
                    <input
                      type="checkbox"
                      checked={hs.use_always ?? false}
                      disabled={busy}
                      onChange={(e) =>
                        setHashtagSets((sets) =>
                          sets.map((x, j) => j === i ? { ...x, use_always: e.target.checked } : x)
                        )
                      }
                    />
                    Always
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setHashtagSets((sets) => sets.filter((_, j) => j !== i))}
                    className="text-[11px] text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  >
                    ×
                  </button>
                </div>
                <textarea
                  className={cn(areaClass, 'min-h-[60px]')}
                  value={hs.tags.join(' ')}
                  disabled={busy}
                  onChange={(e) =>
                    setHashtagSets((sets) =>
                      sets.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              tags: e.target.value
                                .split(/\s+/)
                                .map((t) => t.startsWith('#') ? t : t ? `#${t}` : '')
                                .filter(Boolean),
                            }
                          : x
                      )
                    )
                  }
                  placeholder="#yourtag #anothertag"
                />
              </div>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setHashtagSets((sets) => [...sets, { name: '', tags: [] }])
              }
              className="text-xs border border-dashed border-border rounded-lg px-3 py-2 text-muted-foreground hover:border-primary/60 hover:text-foreground transition-colors w-full"
            >
              + Add hashtag set
            </button>
          </div>

          </>
          )}

          {tab === 'Look' && (
          <>
          <SectionRule title="Visual identity" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Structured palette, type, shot rules — used in Generate media prompts.
            </p>
            <button
              type="button"
              disabled={busy || genIdentityBusy || !selectedId}
              className="border border-rule/40 bg-rule/10 px-2.5 py-1 text-[11px] font-semibold text-rule disabled:opacity-50"
              onClick={() => {
                if (!selectedId) return
                setGenIdentityBusy(true)
                onError(null)
                void generateVisualIdentity(selectedId, { persist: true })
                  .then(({ identity: idn, visual_summary, brand }) => {
                    setIdentity(idn)
                    setDraft((d) => ({
                      ...d,
                      visual: visual_summary || d.visual,
                      visual_identity: brand.visual_identity,
                    }))
                    setBrands((list) => list.map((b) => (b.id === brand.id ? brand : b)))
                  })
                  .catch((e) =>
                    onError(e instanceof Error ? e.message : 'Visual identity failed')
                  )
                  .finally(() => setGenIdentityBusy(false))
              }}
            >
              {genIdentityBusy ? 'Generating…' : 'Generate identity'}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['primary', 'secondary', 'accent', 'background'] as const).map((key) => (
              <label key={key} className="block">
                <FieldLabel>Palette · {key}</FieldLabel>
                <div className="flex gap-2">
                  <input
                    type="color"
                    className="h-9 w-12 cursor-pointer rounded-sm border border-border bg-card"
                    value={identity.palette?.[key] || '#888888'}
                    disabled={busy}
                    onChange={(e) =>
                      setIdentity((id) => ({
                        ...id,
                        palette: { ...id.palette, [key]: e.target.value },
                      }))
                    }
                  />
                  <input
                    className="h-9 flex-1 rounded-sm border border-border bg-card px-2 font-mono text-xs"
                    value={identity.palette?.[key] || ''}
                    disabled={busy}
                    placeholder="#hex"
                    onChange={(e) =>
                      setIdentity((id) => ({
                        ...id,
                        palette: { ...id.palette, [key]: e.target.value },
                      }))
                    }
                  />
                </div>
              </label>
            ))}
          </div>
          {/* Live swatch + sample-post preview */}
          {identity.palette && Object.values(identity.palette).some(Boolean) && (
            <div>
              <FieldLabel>Color preview</FieldLabel>
              <div className="mt-1 flex flex-wrap items-start gap-4">
                <div className="flex flex-wrap gap-2">
                  {(['primary', 'secondary', 'accent', 'background'] as const).map((key) => {
                    const hex = identity.palette?.[key]
                    if (!hex) return null
                    return (
                      <div key={key} className="flex flex-col items-center gap-1">
                        <div
                          className="w-10 h-10 rounded border border-border"
                          style={{ backgroundColor: hex }}
                          title={`${key}: ${hex}`}
                        />
                        <span className="text-[9px] text-muted-foreground capitalize">{key}</span>
                      </div>
                    )
                  })}
                </div>
                <BrandSwatchCard
                  identity={identity}
                  sampleHook={examplePosts[0]?.hook || draft.niche || undefined}
                />
              </div>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <FieldLabel>Heading font</FieldLabel>
              <select
                className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                value={identity.typography?.heading_font || ''}
                disabled={busy}
                onChange={(e) =>
                  setIdentity((id) => ({
                    ...id,
                    typography: { ...id.typography, heading_font: e.target.value },
                  }))
                }
              >
                <option value="">—</option>
                {CANVAS_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <FieldLabel>Body font</FieldLabel>
              <select
                className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                value={identity.typography?.body_font || ''}
                disabled={busy}
                onChange={(e) =>
                  setIdentity((id) => ({
                    ...id,
                    typography: { ...id.typography, body_font: e.target.value },
                  }))
                }
              >
                <option value="">—</option>
                {CANVAS_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <FieldLabel>Shot must (one per line)</FieldLabel>
            <textarea
              className={areaClass}
              value={(identity.shot_rules?.must || []).join('\n')}
              disabled={busy}
              onChange={(e) =>
                setIdentity((id) => ({
                  ...id,
                  shot_rules: {
                    ...id.shot_rules,
                    must: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  },
                }))
              }
            />
          </label>
          <label className="block">
            <FieldLabel>Shot avoid (one per line)</FieldLabel>
            <textarea
              className={areaClass}
              value={(identity.shot_rules?.avoid || []).join('\n')}
              disabled={busy}
              onChange={(e) =>
                setIdentity((id) => ({
                  ...id,
                  shot_rules: {
                    ...id.shot_rules,
                    avoid: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  },
                }))
              }
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block">
              <FieldLabel>Default scrim</FieldLabel>
              <select
                className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                value={identity.layout_defaults?.scrim || 'bottom'}
                disabled={busy}
                onChange={(e) =>
                  setIdentity((id) => ({
                    ...id,
                    layout_defaults: {
                      ...id.layout_defaults,
                      scrim: e.target.value as 'none' | 'bottom' | 'full',
                    },
                  }))
                }
              >
                <option value="none">none</option>
                <option value="bottom">bottom</option>
                <option value="full">full</option>
              </select>
            </label>
            <label className="block">
              <FieldLabel>Text align</FieldLabel>
              <select
                className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                value={identity.layout_defaults?.text_align || 'center'}
                disabled={busy}
                onChange={(e) =>
                  setIdentity((id) => ({
                    ...id,
                    layout_defaults: {
                      ...id.layout_defaults,
                      text_align: e.target.value as 'left' | 'center' | 'right',
                    },
                  }))
                }
              >
                <option value="left">left</option>
                <option value="center">center</option>
                <option value="right">right</option>
              </select>
            </label>
            <label className="block">
              <FieldLabel>Safe margin</FieldLabel>
              <input
                type="number"
                step={0.01}
                min={0.04}
                max={0.16}
                className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
                value={identity.layout_defaults?.safe_margin ?? 0.08}
                disabled={busy}
                onChange={(e) =>
                  setIdentity((id) => ({
                    ...id,
                    layout_defaults: {
                      ...id.layout_defaults,
                      safe_margin: Number(e.target.value) || 0.08,
                    },
                  }))
                }
              />
            </label>
          </div>
          <label className="block">
            <FieldLabel>Visual narrative (prose supplement)</FieldLabel>
            <textarea
              className={areaClass}
              value={draft.visual || ''}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, visual: e.target.value }))}
            />
          </label>
          <div>
            <FieldLabel>Week format mix (fill-week quotas)</FieldLabel>
            <div className="flex flex-wrap gap-3">
              {(['feed', 'reel', 'carousel'] as const).map((f) => (
                <label key={f} className="flex items-center gap-1.5 text-xs">
                  <span className="w-16 uppercase tracking-wide text-muted-foreground">{f}</span>
                  <input
                    type="number"
                    min={0}
                    max={7}
                    className="h-8 w-14 rounded-sm border border-border bg-card px-1.5 text-sm"
                    value={formatMix[f] ?? 0}
                    disabled={busy}
                    onChange={(e) =>
                      setFormatMix((m) => ({
                        ...m,
                        [f]: Math.max(0, Math.min(7, Number(e.target.value) || 0)),
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </div>
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
          <label className="block">
            <FieldLabel>Max carousel slides (generation)</FieldLabel>
            <input
              type="number"
              min={2}
              max={7}
              className="h-9 w-full rounded-sm border border-border bg-card px-2 text-sm"
              value={draft.default_max_slides ?? 5}
              disabled={busy}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  default_max_slides: Math.min(
                    7,
                    Math.max(2, Number(e.target.value) || 5)
                  ),
                }))
              }
            />
          </label>

          </>
          )}

          {tab === 'Rubric' && (
          <>
          <SectionRule title="Brand rubric" />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {rubric
                ? `${rubric.criteria.length} criteria · version ${rubric.version ?? 1}${rubric.edited_by_human ? ' · edited' : ''}`
                : 'No rubric yet — generate one from the brand context.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || rubricBusy || !selectedId}
              onClick={async () => {
                if (!selectedId) return
                setRubricBusy(true)
                try {
                  const { rubric: r } = await generateBrandRubric(selectedId)
                  setRubric({ criteria: r.criteria })
                  setRubricDirty(false)
                } catch (e) {
                  onError(e instanceof Error ? e.message : 'Rubric generate failed')
                } finally {
                  setRubricBusy(false)
                }
              }}
            >
              {rubricBusy ? 'Generating…' : 'AI Generate'}
            </Button>
          </div>

          {rubric && rubric.criteria.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {rubric.criteria.map((c, i) => (
                <div key={c.id} className="rounded border border-border p-3 bg-card flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground capitalize w-16 justify-center shrink-0">
                      {c.target}
                    </span>
                    <input
                      className="flex-1 h-7 rounded-sm border border-border bg-background px-2 text-sm"
                      value={c.description}
                      disabled={busy}
                      onChange={(e) => {
                        const updated = rubric.criteria.map((x, j) =>
                          j === i ? { ...x, description: e.target.value } : x
                        )
                        setRubric({ ...rubric, criteria: updated })
                        setRubricDirty(true)
                      }}
                    />
                    <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
                      {Math.round(c.weight * 100)}%
                    </span>
                    <button
                      className="text-muted-foreground hover:text-destructive text-xs shrink-0"
                      disabled={busy}
                      onClick={() => {
                        setRubric({ ...rubric, criteria: rubric.criteria.filter((_, j) => j !== i) })
                        setRubricDirty(true)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {(c.pass_example || c.fail_example) && (
                    <div className="grid grid-cols-2 gap-2 pl-18">
                      {c.pass_example && (
                        <p className="text-[11px] text-positive bg-pill-positive-bg rounded px-2 py-1">
                          ✓ {c.pass_example}
                        </p>
                      )}
                      {c.fail_example && (
                        <p className="text-[11px] text-negative bg-pill-negative-bg rounded px-2 py-1">
                          ✗ {c.fail_example}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {rubricDirty && (
                <Button
                  size="sm"
                  disabled={busy || rubricBusy || !selectedId}
                  onClick={async () => {
                    if (!selectedId || !rubric) return
                    setRubricBusy(true)
                    try {
                      await saveBrandRubric(selectedId, rubric.criteria as RubricCriterion[])
                      setRubricDirty(false)
                    } catch (e) {
                      onError(e instanceof Error ? e.message : 'Save rubric failed')
                    } finally {
                      setRubricBusy(false)
                    }
                  }}
                >
                  Save rubric
                </Button>
              )}
            </div>
          )}

          </>
          )}

          {tab === 'Advanced' && (
          <>
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
          </>
          )}
        </div>
      </div>
    </div>
  )
}
