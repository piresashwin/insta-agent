import { Router, type IRouter, type Request, type Response } from 'express'
import type { Post } from '@instagram-agent/shared'
import db from '../../db'
import { getPost, transitionPost } from '../../orchestrator'
import { assertAllowed, humanFromBody } from '../../policy'
import { defaultBrandForAccount, getBrandProfile } from '../../brand'
import { ensureSlidesForFormat, listSlides } from '../../slides'
import { sendApiError, normalizeFormat, PATCHABLE_POST_FIELDS } from '../helpers'
import {
  judgeFailedRequiresOverride,
  recordApproval,
} from '../../services/approvals'
import { historyActorFrom } from '../../services/attribution'

export const postsRouter: IRouter = Router()

postsRouter.post('/', (req: Request, res: Response) => {
  const { topic, account_id, background_style, format, brand_profile_id, scheduled_at, pillar } =
    (req.body || {}) as {
      topic?: string
      account_id?: string
      background_style?: string
      format?: string
      brand_profile_id?: number
      scheduled_at?: string
      pillar?: string
    }
  const fmt = format ? normalizeFormat(format) : null
  const brandId =
    brand_profile_id != null
      ? Number(brand_profile_id)
      : defaultBrandForAccount(account_id) || null
  const brand = brandId ? getBrandProfile(brandId) : null
  const bg = background_style || brand?.default_background_style || null
  const finalFormat = fmt || (brand?.default_format ? normalizeFormat(brand.default_format) : null)
  const info = db
    .prepare(
      `INSERT INTO posts (
        account_id, topic, background_style, format, status,
        brand_profile_id, scheduled_at, pillar, created_at, updated_at
      ) VALUES (?, COALESCE(?, ''), ?, ?, 'draft', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(
      account_id || null,
      topic || null,
      bg,
      finalFormat,
      brandId,
      scheduled_at || null,
      pillar || null
    )
  const post = getPost(Number(info.lastInsertRowid))
  if (post && finalFormat) {
    ensureSlidesForFormat(post.id, finalFormat, post.hook)
  }
  res.status(201).json({ post, slides: post ? listSlides(post.id) : [] })
})

postsRouter.get('/', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : ''
  const rows = (
    status
      ? db
          .prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC')
          .all(status)
      : db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all()
  ) as Post[]
  res.json({ posts: rows })
})

postsRouter.get('/:id', (req: Request, res: Response) => {
  const post = getPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'post not found' })
  res.json({ post, slides: listSlides(post.id) })
})

postsRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })

    const body = (req.body || {}) as Record<string, unknown>
    if ('status' in body) {
      return res.status(400).json({
        error: 'Cannot PATCH status — use approve / request-changes / agent-run / publish routes',
      })
    }

    // Optimistic concurrency: if caller provides expected_version, reject on mismatch
    if ('expected_version' in body) {
      const expected = Number(body.expected_version)
      const current = Number((post as Post & { version?: number }).version ?? 1)
      if (Number.isFinite(expected) && expected !== current) {
        return res.status(409).json({
          error: `Version conflict: expected ${expected}, got ${current}`,
          current_version: current,
        })
      }
    }

    const sets: string[] = []
    const values: Array<string | number | null> = []
    for (const [key, value] of Object.entries(body)) {
      if (key === 'expected_version' || key === 'actor') continue
      if (!PATCHABLE_POST_FIELDS.has(key)) {
        return res.status(400).json({ error: `patch field not allowed: ${key}` })
      }
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
        return res.status(400).json({ error: `invalid type for ${key}` })
      }
      sets.push(`${key} = ?`)
      values.push(value as string | number | null)
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' })

    // Apply fields, then bump + snapshot via versions service (keeps post_versions in sync).
    sets.push('updated_at = CURRENT_TIMESTAMP')
    values.push(req.params.id)
    db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...values)

    const bodyActor = body.actor as { id?: string; name?: string } | undefined
    // sync require — route is sync; versions module has no cycle with posts router
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bumpAndSnapshot } = require('../../services/versions') as typeof import('../../services/versions')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { historyActorFrom } = require('../../services/attribution') as typeof import('../../services/attribution')
    const updated = bumpAndSnapshot(
      req.params.id,
      historyActorFrom(
        bodyActor
          ? { id: bodyActor.id, name: bodyActor.name }
          : { id: 'dashboard:rest', name: 'Dashboard' },
      ),
    )
    res.json({ post: updated })
  } catch (e) {
    sendApiError(res, e)
  }
})

postsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const post = getPost(req.params.id)
    if (!post) return res.status(404).json({ error: 'post not found' })
    if (post.status === 'publishing' || post.status === 'published') {
      return res.status(409).json({ error: `Cannot delete post in status "${post.status}"` })
    }
    const id = Number(req.params.id)
    db.prepare('DELETE FROM post_slides WHERE post_id = ?').run(id)
    db.prepare('DELETE FROM iterations WHERE post_id = ?').run(id)
    db.prepare('DELETE FROM posts WHERE id = ?').run(id)
    res.json({ ok: true, deleted_id: id })
  } catch (e) {
    sendApiError(res, e)
  }
})

/** POST /api/posts/bulk-approve — approve copy on multiple passing posts at once. */
postsRouter.post('/bulk-approve', (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as {
      post_ids?: unknown[]
      actor?: { id?: string; name?: string }
      /** When true, allow judge-failed posts (records override_reason). Default false. */
      allow_override?: boolean
      override_reason?: string
    }
    if (!Array.isArray(body.post_ids) || body.post_ids.length === 0) {
      return res.status(400).json({ error: 'post_ids array required' })
    }
    const actor = body.actor || {}
    if (!actor.id) return res.status(400).json({ error: 'actor.id required for bulk approve' })

    const approved: number[] = []
    const skipped: Array<{ id: number; reason: string }> = []

    for (const rawId of body.post_ids) {
      const id = Number(rawId)
      if (!Number.isFinite(id)) {
        skipped.push({ id, reason: 'invalid id' })
        continue
      }
      const post = getPost(id)
      if (!post) {
        skipped.push({ id, reason: 'not found' })
        continue
      }
      if (post.status !== 'pending_approval') {
        skipped.push({ id, reason: `status is ${post.status}` })
        continue
      }
      if (judgeFailedRequiresOverride(id)) {
        if (!body.allow_override || !body.override_reason?.trim()) {
          skipped.push({ id, reason: 'judge failed — needs override_reason' })
          continue
        }
      }
      try {
        assertAllowed(humanFromBody(actor), 'post.approve', { type: 'post', post })
        recordApproval({
          postId: id,
          stage: 'copy',
          actor: historyActorFrom({ id: actor.id, name: actor.name }),
          overrideReason: body.override_reason ?? null,
        })
        transitionPost(id, 'approved', { actor })
        approved.push(id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        skipped.push({ id, reason: msg })
      }
    }

    res.json({ approved, skipped })
  } catch (e) {
    sendApiError(res, e)
  }
})
