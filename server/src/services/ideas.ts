/**
 * Ideas backlog service — generate, curate, schedule onto the calendar.
 */
import crypto from 'crypto'
import type {
  Idea,
  IdeaSource,
  IdeaStatus,
  Post,
  PostFormat,
} from '@instagram-agent/shared'
import db from '../db'
import {
  createDraftFromProposal,
  getBrandProfile,
  parseFormatMix,
} from '../brand'
import { ApiError, getPost } from '../orchestrator'
import { assertAllowed, type PolicyActor } from '../policy'
import { resolveBrandContextForBrand } from '../generation/brand-context'
import { isNearDuplicate } from '../generation/similarity'
import { generateIdeas } from '../skills/idea-generation'
import { budgetAwareFormatMix, monthlyCap, monthlySpend } from './budget'

type IdeaRow = {
  id: number
  brand_profile_id: number
  batch_id: string | null
  topic: string
  angle: string | null
  pillar: string | null
  format: string
  hooks_json: string
  chosen_hook: string | null
  direction: string | null
  why: string | null
  source: string
  parent_idea_id: number | null
  steer: string | null
  status: string
  post_id: number | null
  created_at: string
  updated_at: string | null
}

function parseHooks(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export function rowToIdea(row: IdeaRow): Idea {
  const format =
    row.format === 'reel' || row.format === 'carousel' || row.format === 'feed'
      ? row.format
      : 'feed'
  return {
    id: row.id,
    brand_profile_id: row.brand_profile_id,
    batch_id: row.batch_id,
    topic: row.topic,
    angle: row.angle,
    pillar: row.pillar,
    format,
    hooks: parseHooks(row.hooks_json),
    chosen_hook: row.chosen_hook,
    direction: row.direction,
    why: row.why,
    source: (row.source as IdeaSource) || 'ai',
    parent_idea_id: row.parent_idea_id,
    steer: row.steer,
    status: (row.status as IdeaStatus) || 'new',
    post_id: row.post_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listIdeas(
  brandProfileId: number,
  status?: IdeaStatus | 'board',
): Idea[] {
  let rows: IdeaRow[]
  if (status === 'board') {
    rows = db
      .prepare(
        `SELECT * FROM ideas
         WHERE brand_profile_id = ? AND status IN ('new','shortlisted')
         ORDER BY created_at DESC, id DESC`,
      )
      .all(brandProfileId) as IdeaRow[]
  } else if (status) {
    rows = db
      .prepare(
        `SELECT * FROM ideas
         WHERE brand_profile_id = ? AND status = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(brandProfileId, status) as IdeaRow[]
  } else {
    rows = db
      .prepare(
        `SELECT * FROM ideas
         WHERE brand_profile_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(brandProfileId) as IdeaRow[]
  }
  return rows.map(rowToIdea)
}

export function getIdea(id: number): Idea {
  const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as IdeaRow | undefined
  if (!row) throw new ApiError(404, 'idea not found')
  return rowToIdea(row)
}

export function tryGetIdea(id: number): Idea | null {
  const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as IdeaRow | undefined
  return row ? rowToIdea(row) : null
}

type IdeaBatchResult = { batch_id: string; ideas: Idea[]; dropped: number }

/** Process-local coalesce for overlapping riffs on the same parent (decision C). */
const riffInflight = new Map<string, Promise<IdeaBatchResult>>()

async function runGenerateIdeaBatch(
  brandProfileId: number,
  opts: {
    count?: number
    steer?: string | null
    pillar?: string | null
    format?: PostFormat | null
    likeIdeaId?: number | null
  } = {},
): Promise<IdeaBatchResult> {
  const brand = getBrandProfile(brandProfileId)
  if (!brand) throw new ApiError(404, 'brand not found')

  let likeIdea: { topic: string; angle: string | null; hooks: string[] } | null = null
  let parentIdeaId: number | null = null
  let count = Math.max(1, Math.min(12, Number(opts.count) || 8))
  if (opts.likeIdeaId != null) {
    const parent = getIdea(opts.likeIdeaId)
    if (parent.brand_profile_id !== brandProfileId) {
      throw new ApiError(400, 'like_idea_id belongs to another brand')
    }
    likeIdea = { topic: parent.topic, angle: parent.angle, hooks: parent.hooks }
    parentIdeaId = parent.id
    count = 3
  }

  const remaining = Math.max(0, monthlyCap() - monthlySpend('prod'))
  const rawMix = parseFormatMix(brand.format_mix)
  const mix = rawMix
    ? budgetAwareFormatMix(rawMix as unknown as Record<string, number>, remaining)
    : null
  const allowReels = Number((mix as Record<string, number> | null)?.reel ?? 1) > 0

  const existing = db
    .prepare(
      `SELECT topic, hooks_json FROM ideas
       WHERE brand_profile_id = ? AND status != 'dismissed'`,
    )
    .all(brandProfileId) as Array<{ topic: string; hooks_json: string }>
  const avoid: string[] = []
  for (const e of existing) {
    avoid.push(e.topic)
    avoid.push(...parseHooks(e.hooks_json))
  }
  const ctx = resolveBrandContextForBrand(brandProfileId)
  avoid.push(...(ctx.recentHooks || []))

  const generated = await generateIdeas({
    brandProfileId,
    count,
    steer: opts.steer,
    pillar: opts.pillar,
    format: opts.format,
    likeIdea,
    avoidTopics: avoid,
    allowReels,
  })

  const kept: typeof generated = []
  const batchAvoid = [...avoid]
  let dropped = 0
  for (const idea of generated) {
    const candidates = [idea.topic, ...idea.hooks]
    const dup = candidates.some((c) =>
      batchAvoid.some((a) => a && c && isNearDuplicate(c, a)),
    )
    if (dup) {
      dropped += 1
      continue
    }
    kept.push(idea)
    batchAvoid.push(...candidates)
  }

  const batchId = crypto.randomUUID()
  const source: IdeaSource = parentIdeaId ? 'riff' : 'ai'
  const ideas: Idea[] = []
  const insert = db.prepare(
    `INSERT INTO ideas (
       brand_profile_id, batch_id, topic, angle, pillar, format, hooks_json,
       why, source, parent_idea_id, steer, status, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', CURRENT_TIMESTAMP)`,
  )
  for (const idea of kept) {
    const info = insert.run(
      brandProfileId,
      batchId,
      idea.topic,
      idea.angle || null,
      idea.pillar || null,
      idea.format,
      JSON.stringify(idea.hooks),
      idea.why || null,
      source,
      parentIdeaId,
      opts.steer?.trim() || null,
    )
    ideas.push(getIdea(Number(info.lastInsertRowid)))
  }

  return { batch_id: batchId, ideas, dropped }
}

export async function generateIdeaBatch(
  brandProfileId: number,
  opts: {
    count?: number
    steer?: string | null
    pillar?: string | null
    format?: PostFormat | null
    likeIdeaId?: number | null
  } = {},
): Promise<IdeaBatchResult> {
  if (opts.likeIdeaId == null) {
    return runGenerateIdeaBatch(brandProfileId, opts)
  }

  const key = `${brandProfileId}:${opts.likeIdeaId}`
  const existing = riffInflight.get(key)
  if (existing) return existing

  const pending = runGenerateIdeaBatch(brandProfileId, opts).finally(() => {
    riffInflight.delete(key)
  })
  riffInflight.set(key, pending)
  return pending
}

export function createManualIdea(
  brandProfileId: number,
  input: {
    topic: string
    angle?: string | null
    pillar?: string | null
    format?: PostFormat | null
    hooks?: string[]
  },
): Idea {
  const brand = getBrandProfile(brandProfileId)
  if (!brand) throw new ApiError(404, 'brand not found')
  const topic = (input.topic || '').trim()
  if (!topic) throw new ApiError(400, 'topic required')
  const format =
    input.format === 'reel' || input.format === 'carousel' || input.format === 'feed'
      ? input.format
      : 'feed'
  const hooks = (input.hooks || []).map((h) => String(h).trim()).filter(Boolean).slice(0, 3)
  const info = db
    .prepare(
      `INSERT INTO ideas (
         brand_profile_id, topic, angle, pillar, format, hooks_json,
         source, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'shortlisted', CURRENT_TIMESTAMP)`,
    )
    .run(
      brandProfileId,
      topic.slice(0, 200),
      input.angle?.trim()?.slice(0, 300) || null,
      input.pillar?.trim() || null,
      format,
      JSON.stringify(hooks),
    )
  return getIdea(Number(info.lastInsertRowid))
}

export function updateIdea(
  id: number,
  patch: {
    topic?: string
    angle?: string | null
    pillar?: string | null
    format?: PostFormat | string | null
    chosen_hook?: string | null
    direction?: string | null
    status?: IdeaStatus
  },
): Idea {
  const idea = getIdea(id)
  if (patch.status != null && !['new', 'shortlisted', 'dismissed'].includes(patch.status)) {
    throw new ApiError(400, 'status must be new, shortlisted, or dismissed')
  }
  const touchingMeta =
    patch.topic !== undefined ||
    patch.angle !== undefined ||
    patch.pillar !== undefined ||
    patch.format !== undefined ||
    patch.status !== undefined
  if (idea.status === 'scheduled' && touchingMeta) {
    throw new ApiError(409, 'Idea is scheduled — unschedule it or edit the post')
  }

  const next = {
    topic: patch.topic !== undefined ? String(patch.topic).trim().slice(0, 200) : idea.topic,
    angle:
      patch.angle !== undefined
        ? patch.angle == null
          ? null
          : String(patch.angle).trim().slice(0, 300)
        : idea.angle,
    pillar:
      patch.pillar !== undefined
        ? patch.pillar == null
          ? null
          : String(patch.pillar).trim()
        : idea.pillar,
    format:
      patch.format !== undefined
        ? patch.format === 'reel' || patch.format === 'carousel' || patch.format === 'feed'
          ? patch.format
          : idea.format
        : idea.format,
    chosen_hook:
      patch.chosen_hook !== undefined
        ? patch.chosen_hook == null
          ? null
          : String(patch.chosen_hook).trim().slice(0, 150)
        : idea.chosen_hook,
    direction:
      patch.direction !== undefined
        ? patch.direction == null
          ? null
          : String(patch.direction).trim().slice(0, 1000)
        : idea.direction,
    status: patch.status !== undefined ? patch.status : idea.status,
  }
  if (!next.topic) throw new ApiError(400, 'topic required')

  db.prepare(
    `UPDATE ideas SET
       topic = ?, angle = ?, pillar = ?, format = ?,
       chosen_hook = ?, direction = ?, status = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(
    next.topic,
    next.angle,
    next.pillar,
    next.format,
    next.chosen_hook,
    next.direction,
    next.status,
    id,
  )
  return getIdea(id)
}

function isValidDate(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false
  const d = new Date(`${ymd}T12:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd
}

export function scheduleIdea(
  id: number,
  opts: { date: string; account_id?: string | null },
  actor: PolicyActor,
): { idea: Idea; post: Post } {
  const idea = getIdea(id)
  if (idea.status !== 'new' && idea.status !== 'shortlisted') {
    throw new ApiError(409, 'Idea cannot be scheduled in its current status')
  }
  if (!isValidDate(opts.date)) throw new ApiError(400, 'date must be YYYY-MM-DD')

  const brand = getBrandProfile(idea.brand_profile_id)
  if (!brand) throw new ApiError(404, 'brand not found')
  assertAllowed(actor, 'calendar.commit', { type: 'brand', brand })

  try {
    db.exec('BEGIN IMMEDIATE')
    const post = createDraftFromProposal({
      brand_profile_id: idea.brand_profile_id,
      account_id: opts.account_id ?? null,
      proposal: {
        date: opts.date,
        topic: idea.topic,
        pillar: idea.pillar,
        format: idea.format,
        angle: idea.angle,
      },
    })
    assertAllowed(actor, 'post.draft', { type: 'post', post })
    db.prepare('UPDATE posts SET idea_id = ? WHERE id = ?').run(idea.id, post.id)
    db.prepare(
      `UPDATE ideas SET status = 'scheduled', post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(post.id, idea.id)
    db.exec('COMMIT')
    return { idea: getIdea(id), post: getPost(post.id)! }
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  }
}

export function unscheduleIdea(id: number, actor: PolicyActor): Idea {
  const idea = getIdea(id)
  if (idea.status !== 'scheduled' || idea.post_id == null) {
    throw new ApiError(409, 'Idea is not scheduled')
  }
  const brand = getBrandProfile(idea.brand_profile_id)
  if (!brand) throw new ApiError(404, 'brand not found')
  assertAllowed(actor, 'calendar.commit', { type: 'brand', brand })

  const post = getPost(idea.post_id)
  if (!post) {
    db.prepare(
      `UPDATE ideas SET status = 'shortlisted', post_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(id)
    return getIdea(id)
  }

  const runCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE post_id = ?`).get(post.id) as { c: number }
  ).c
  const iterCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM iterations WHERE post_id = ?`)
      .get(post.id) as { c: number }
  ).c
  const untouched =
    post.status === 'draft' &&
    !post.hook &&
    !post.caption &&
    runCount === 0 &&
    iterCount === 0
  if (!untouched) {
    throw new ApiError(409, 'This post is already being crafted — open it instead')
  }

  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare('DELETE FROM post_slides WHERE post_id = ?').run(post.id)
    db.prepare('DELETE FROM iterations WHERE post_id = ?').run(post.id)
    try {
      db.prepare('DELETE FROM post_versions WHERE post_id = ?').run(post.id)
    } catch {
      /* table may vary */
    }
    try {
      db.prepare('DELETE FROM post_proposed_versions WHERE post_id = ?').run(post.id)
    } catch {
      /* optional */
    }
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id)
    db.prepare(
      `UPDATE ideas SET status = 'shortlisted', post_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(id)
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  }
  return getIdea(id)
}
