/**
 * Brand profiles + resolve context for agent/image injection.
 */
import type {
  BrandOverrides,
  BrandPillar,
  BrandProfile,
  CalendarProposal,
  Post,
  PostFormat,
} from '@instagram-agent/shared'
import db from './db'
import { ensureSlidesForFormat } from './slides'

export type BrandContext = {
  profile: BrandProfile | null
  overrides: BrandOverrides
  briefMd: string
  voiceBrief: string
  visualBrief: string
  backgroundStyle: string | null
  format: PostFormat | string | null
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export function parsePillars(raw: string | null | undefined): BrandPillar[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed
        .map((p) => {
          if (typeof p === 'string') return { name: p }
          if (p && typeof p === 'object' && 'name' in p && typeof (p as BrandPillar).name === 'string') {
            return { name: (p as BrandPillar).name, notes: (p as BrandPillar).notes }
          }
          return null
        })
        .filter((p): p is BrandPillar => !!p?.name)
    }
  } catch {
    return raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name }))
  }
  return []
}

export function parsePreferredDays(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return ['mon', 'wed', 'fri']
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((d) => d.toLowerCase().slice(0, 3))
    }
  } catch {
    return raw
      .split(/[,\s]+/)
      .map((d) => d.toLowerCase().slice(0, 3))
      .filter(Boolean)
  }
  return ['mon', 'wed', 'fri']
}

export function parseOverrides(raw: string | null | undefined): BrandOverrides {
  if (!raw?.trim()) return {}
  try {
    return JSON.parse(raw) as BrandOverrides
  } catch {
    return {}
  }
}

export function listBrandProfiles(): BrandProfile[] {
  return db
    .prepare('SELECT * FROM brand_profiles ORDER BY name COLLATE NOCASE ASC')
    .all() as BrandProfile[]
}

export function getBrandProfile(id: number | string): BrandProfile | null {
  return (
    (db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(Number(id)) as
      | BrandProfile
      | undefined) || null
  )
}

export type BrandProfileInput = {
  name: string
  niche?: string | null
  audience?: string | null
  goals?: string | null
  pillars?: string | BrandPillar[] | string[] | null
  posts_per_week?: number | null
  preferred_days?: string | string[] | null
  voice?: string | null
  examples?: string | null
  visual?: string | null
  default_background_style?: string | null
  default_format?: string | null
  guide_md?: string | null
}

function serializePillars(v: BrandProfileInput['pillars']): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

function serializeDays(v: BrandProfileInput['preferred_days']): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

export function createBrandProfile(input: BrandProfileInput): BrandProfile {
  const name = (input.name || '').trim()
  if (!name) throw new Error('Brand name is required')
  const info = db
    .prepare(
      `INSERT INTO brand_profiles (
        name, niche, audience, goals, pillars, posts_per_week, preferred_days,
        voice, examples, visual, default_background_style, default_format, guide_md,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(
      name,
      input.niche ?? null,
      input.audience ?? null,
      input.goals ?? null,
      serializePillars(input.pillars),
      Math.max(1, Math.min(14, Number(input.posts_per_week) || 3)),
      serializeDays(input.preferred_days) ?? JSON.stringify(['mon', 'wed', 'fri']),
      input.voice ?? null,
      input.examples ?? null,
      input.visual ?? null,
      input.default_background_style ?? null,
      input.default_format ?? 'feed',
      input.guide_md ?? null
    )
  return getBrandProfile(Number(info.lastInsertRowid))!
}

export function updateBrandProfile(
  id: number | string,
  patch: Partial<BrandProfileInput>
): BrandProfile | null {
  const existing = getBrandProfile(id)
  if (!existing) return null
  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() : existing.name,
    niche: patch.niche !== undefined ? patch.niche : existing.niche,
    audience: patch.audience !== undefined ? patch.audience : existing.audience,
    goals: patch.goals !== undefined ? patch.goals : existing.goals,
    pillars:
      patch.pillars !== undefined ? serializePillars(patch.pillars) : existing.pillars,
    posts_per_week:
      patch.posts_per_week !== undefined
        ? Math.max(1, Math.min(14, Number(patch.posts_per_week) || 3))
        : existing.posts_per_week,
    preferred_days:
      patch.preferred_days !== undefined
        ? serializeDays(patch.preferred_days)
        : existing.preferred_days,
    voice: patch.voice !== undefined ? patch.voice : existing.voice,
    examples: patch.examples !== undefined ? patch.examples : existing.examples,
    visual: patch.visual !== undefined ? patch.visual : existing.visual,
    default_background_style:
      patch.default_background_style !== undefined
        ? patch.default_background_style
        : existing.default_background_style,
    default_format:
      patch.default_format !== undefined ? patch.default_format : existing.default_format,
    guide_md: patch.guide_md !== undefined ? patch.guide_md : existing.guide_md,
  }
  if (!next.name) throw new Error('Brand name is required')
  db.prepare(
    `UPDATE brand_profiles SET
      name = ?, niche = ?, audience = ?, goals = ?, pillars = ?, posts_per_week = ?,
      preferred_days = ?, voice = ?, examples = ?, visual = ?,
      default_background_style = ?, default_format = ?, guide_md = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`
  ).run(
    next.name,
    next.niche,
    next.audience,
    next.goals,
    next.pillars,
    next.posts_per_week,
    next.preferred_days,
    next.voice,
    next.examples,
    next.visual,
    next.default_background_style,
    next.default_format,
    next.guide_md,
    Number(id)
  )
  return getBrandProfile(id)
}

export function deleteBrandProfile(id: number | string): boolean {
  const info = db.prepare('DELETE FROM brand_profiles WHERE id = ?').run(Number(id))
  return info.changes > 0
}

export function renderBrandBrief(profile: BrandProfile): string {
  const pillars = parsePillars(profile.pillars)
    .map((p) => (p.notes ? `${p.name}: ${p.notes}` : p.name))
    .join('; ')
  const lines = [
    `# Brand: ${profile.name}`,
    profile.niche && `Niche: ${profile.niche}`,
    profile.audience && `Audience: ${profile.audience}`,
    profile.goals && `Goals: ${profile.goals}`,
    pillars && `Pillars: ${pillars}`,
    profile.voice && `Voice:\n${profile.voice}`,
    profile.examples && `Examples:\n${profile.examples}`,
    profile.visual && `Visual:\n${profile.visual}`,
    profile.default_format && `Default format: ${profile.default_format}`,
    profile.default_background_style &&
      `Default background style: ${profile.default_background_style}`,
    profile.guide_md && `Guide:\n${profile.guide_md}`,
  ].filter(Boolean)
  return lines.join('\n\n')
}

export function resolveBrandContext(post: Post): BrandContext {
  const profile = post.brand_profile_id ? getBrandProfile(post.brand_profile_id) : null
  const overrides = parseOverrides(post.brand_overrides)
  const voiceParts = [
    profile?.voice,
    overrides.tone && `Tone for this post: ${overrides.tone}`,
    overrides.voice_note,
    overrides.audience && `Audience focus: ${overrides.audience}`,
    overrides.hashtag_extra && `Hashtag extras: ${overrides.hashtag_extra}`,
  ].filter(Boolean)
  const visualParts = [
    profile?.visual,
    overrides.visual_extra,
    overrides.image_prompt_extra && `Image direction: ${overrides.image_prompt_extra}`,
  ].filter(Boolean)
  const briefMd = [
    profile ? renderBrandBrief(profile) : '',
    Object.keys(overrides).length
      ? `## Post overrides\n${JSON.stringify(overrides, null, 2)}`
      : '',
    post.pillar ? `Content pillar for this post: ${post.pillar}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    profile,
    overrides,
    briefMd: briefMd || 'No brand profile set.',
    voiceBrief: voiceParts.join('\n') || '',
    visualBrief: visualParts.join('\n') || '',
    backgroundStyle:
      overrides.background_style ||
      post.background_style ||
      profile?.default_background_style ||
      null,
    format: post.format || profile?.default_format || 'feed',
  }
}

/** Dates in week (Mon–Sun) matching preferred_days, up to count. */
export function pickWeekDates(weekStartIso: string, preferredDays: string[], count: number): string[] {
  const start = new Date(`${weekStartIso.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(start.getTime())) throw new Error('Invalid week_start')
  // Normalize to Monday of that week
  const day = start.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  start.setDate(start.getDate() + mondayOffset)

  const preferred = new Set(preferredDays.map((d) => d.toLowerCase().slice(0, 3)))
  const dates: string[] = []
  for (let i = 0; i < 7 && dates.length < count; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = DAY_KEYS[d.getDay()]
    if (preferred.size === 0 || preferred.has(key)) {
      dates.push(d.toISOString().slice(0, 10))
    }
  }
  // If preferred days didn't fill count, add remaining weekdays
  for (let i = 0; i < 7 && dates.length < count; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = d.toISOString().slice(0, 10)
    if (!dates.includes(iso)) dates.push(iso)
  }
  return dates.slice(0, count)
}

export function listCalendarPosts(opts: {
  from: string
  to: string
  brand_profile_id?: number
  account_id?: string
}): Post[] {
  const clauses = ['scheduled_at IS NOT NULL', 'scheduled_at >= ?', 'scheduled_at < ?']
  const params: Array<string | number> = [opts.from, opts.to]
  if (opts.brand_profile_id != null) {
    clauses.push('brand_profile_id = ?')
    params.push(opts.brand_profile_id)
  }
  if (opts.account_id) {
    clauses.push('account_id = ?')
    params.push(opts.account_id)
  }
  return db
    .prepare(
      `SELECT * FROM posts WHERE ${clauses.join(' AND ')} ORDER BY scheduled_at ASC, id ASC`
    )
    .all(...params) as Post[]
}

export function createDraftFromProposal(opts: {
  brand_profile_id: number
  account_id?: string | null
  proposal: CalendarProposal
}): Post {
  const profile = getBrandProfile(opts.brand_profile_id)
  const scheduled = opts.proposal.date.includes('T')
    ? opts.proposal.date
    : `${opts.proposal.date}T12:00:00.000Z`
  const format = opts.proposal.format || profile?.default_format || 'feed'
  const bg =
    opts.proposal.background_style || profile?.default_background_style || null
  const info = db
    .prepare(
      `INSERT INTO posts (
        account_id, topic, background_style, format, status,
        brand_profile_id, scheduled_at, pillar, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(
      opts.account_id || null,
      opts.proposal.topic,
      bg,
      format,
      opts.brand_profile_id,
      scheduled,
      opts.proposal.pillar || null
    )
  const post = db
    .prepare('SELECT * FROM posts WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Post
  const fmt: PostFormat =
    format === 'reel' || format === 'carousel' || format === 'feed' ? format : 'feed'
  ensureSlidesForFormat(post.id, fmt, opts.proposal.topic)
  return post
}

export function defaultBrandForAccount(accountId: string | null | undefined): number | null {
  if (!accountId) return null
  const row = db
    .prepare(
      'SELECT default_brand_profile_id FROM instagram_conn WHERE account_id = ? LIMIT 1'
    )
    .get(accountId) as { default_brand_profile_id?: number | null } | undefined
  return row?.default_brand_profile_id ?? null
}
