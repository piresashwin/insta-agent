import { Router, type IRouter, type Request, type Response } from 'express'
import type { Actor, CalendarProposal } from '@instagram-agent/shared'
import db from '../../db'
import { ApiError } from '../../orchestrator'
import { actorFromRequest, assertAllowed } from '../../policy'
import {
  createBrandProfile,
  deleteBrandProfile,
  getBrandProfile,
  listBrandProfiles,
  updateBrandProfile,
  type BrandProfileInput,
} from '../../brand'
import { generateBrandFromFeedback } from '../../skills/generate-brand-profile'
import { generateAndMaybePersistVisualIdentity } from '../../brand-visual'
import { resolveBrandContextV2 } from '../../generation/brand-context'
import { generateBrandRubric } from '../../skills/generate-brand-rubric'
import { fillWeekForBrand } from '../../fill-week'
import { sendApiError } from '../helpers'

export const brandsRouter: IRouter = Router()

brandsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ brands: listBrandProfiles() })
})

/** Autofill brand draft from freeform feedback (does not persist — client applies). */
brandsRouter.post('/generate', async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { feedback?: string; name?: string }
    const feedback = (body.feedback || '').trim()
    if (!feedback) {
      return res.status(400).json({ error: 'feedback is required' })
    }
    const draft = await generateBrandFromFeedback({
      feedback,
      nameHint: body.name,
    })
    res.json({
      draft: {
        ...draft,
        pillars: draft.pillars.map((name) => ({ name })),
        preferred_days: draft.preferred_days,
      },
      note: 'Draft generated — review and Save to persist',
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Brand generate failed'
    console.error('[brand-generate]', message)
    res.status(502).json({ error: message })
  }
})

brandsRouter.post('/', (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as BrandProfileInput & { actor?: Actor }
    const actor = actorFromRequest(body.actor)
    assertAllowed(actor, 'brand.create', {
      type: 'brand',
      brand: { name: (body.name || '').trim() },
    })
    const brand = createBrandProfile(body)
    res.status(201).json({ brand })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Create brand failed'
    res.status(400).json({ error: message })
  }
})

brandsRouter.get('/:id', (req: Request, res: Response) => {
  const brand = getBrandProfile(req.params.id)
  if (!brand) return res.status(404).json({ error: 'brand not found' })
  res.json({ brand })
})

brandsRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const existing = getBrandProfile(req.params.id)
    if (!existing) return res.status(404).json({ error: 'brand not found' })
    const body = (req.body || {}) as BrandProfileInput & { actor?: Actor }
    const actor = actorFromRequest(body.actor)
    assertAllowed(actor, 'brand.update', { type: 'brand', brand: existing })
    const brand = updateBrandProfile(req.params.id, body)
    if (!brand) return res.status(404).json({ error: 'brand not found' })
    res.json({ brand })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Update brand failed'
    res.status(400).json({ error: message })
  }
})

brandsRouter.delete('/:id', (req: Request, res: Response) => {
  const ok = deleteBrandProfile(req.params.id)
  if (!ok) return res.status(404).json({ error: 'brand not found' })
  db.prepare(
    'UPDATE instagram_conn SET default_brand_profile_id = NULL WHERE default_brand_profile_id = ?'
  ).run(Number(req.params.id))
  res.json({ ok: true })
})

brandsRouter.post('/:id/generate-visual-identity', async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { persist?: boolean; actor?: Actor }
    const result = await generateAndMaybePersistVisualIdentity(req.params.id, {
      persist: body.persist,
      actor: actorFromRequest(body.actor),
    })
    res.json(result)
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Visual identity generate failed'
    console.error('[generate-visual-identity]', message)
    res.status(502).json({ error: message })
  }
})

brandsRouter.get('/:id/rubric', (req: Request, res: Response) => {
  const brand = getBrandProfile(req.params.id)
  if (!brand) return res.status(404).json({ error: 'brand not found' })
  const row = db.prepare(
    'SELECT id, version, rubric_json, edited_by_human, created_at FROM brand_rubrics WHERE brand_profile_id = ? ORDER BY version DESC LIMIT 1'
  ).get(Number(req.params.id)) as Record<string, unknown> | undefined
  if (!row) return res.json({ rubric: null })
  const criteria = typeof row.rubric_json === 'string' ? JSON.parse(row.rubric_json) : row.rubric_json
  res.json({ rubric: { ...row, criteria: (criteria as { criteria?: unknown })?.criteria ?? criteria } })
})

brandsRouter.post('/:id/rubric', (req: Request, res: Response) => {
  const brand = getBrandProfile(req.params.id)
  if (!brand) return res.status(404).json({ error: 'brand not found' })
  const body = (req.body || {}) as { criteria?: unknown[] }
  if (!Array.isArray(body.criteria)) return res.status(400).json({ error: 'criteria array required' })
  const existing = db.prepare(
    'SELECT version FROM brand_rubrics WHERE brand_profile_id = ? ORDER BY version DESC LIMIT 1'
  ).get(Number(req.params.id)) as { version: number } | undefined
  const nextVersion = (existing?.version ?? 0) + 1
  db.prepare(
    'INSERT INTO brand_rubrics (brand_profile_id, version, rubric_json, edited_by_human) VALUES (?, ?, ?, 1)'
  ).run(Number(req.params.id), nextVersion, JSON.stringify({ criteria: body.criteria }))
  res.json({ ok: true, version: nextVersion })
})

brandsRouter.post('/:id/rubric/generate', async (req: Request, res: Response) => {
  try {
    const brand = getBrandProfile(req.params.id)
    if (!brand) return res.status(404).json({ error: 'brand not found' })
    // resolveBrandContextV2 only reads post.brand_profile_id; pass a minimal stub
    const ctx = resolveBrandContextV2({ brand_profile_id: brand.id } as import('@instagram-agent/shared').Post)
    const result = await generateBrandRubric(ctx)
    res.json({ rubric: result.rubric, version: result.version, saved: result.saved })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Rubric generate failed'
    console.error('[rubric-generate]', message)
    res.status(502).json({ error: message })
  }
})

brandsRouter.post('/:id/fill-week', async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as {
      week_start?: string
      account_id?: string
      dry_run?: boolean
      proposals?: CalendarProposal[]
      count?: number
      actor?: Actor
    }
    const result = await fillWeekForBrand(req.params.id, {
      week_start: body.week_start,
      account_id: body.account_id,
      dry_run: body.dry_run,
      proposals: body.proposals,
      count: body.count,
      actor: actorFromRequest(body.actor),
    })
    if (result.dry_run) {
      return res.json({ proposals: result.proposals, dry_run: true })
    }
    res.status(201).json({
      posts: result.posts,
      proposals: result.proposals,
      dry_run: false,
    })
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const message = e instanceof Error ? e.message : 'Fill week failed'
    console.error('[fill-week]', message)
    res.status(502).json({ error: message })
  }
})
