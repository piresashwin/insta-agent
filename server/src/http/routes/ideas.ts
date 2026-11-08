/**
 * Ideas REST API — Explore → Shortlist → Craft.
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import type { IdeaStatus, PostFormat } from '@instagram-agent/shared'
import { sendApiError } from '../helpers'
import { ApiError } from '../../orchestrator'
import { actorFromRequest } from '../../policy'
import {
  createManualIdea,
  generateIdeaBatch,
  getIdea,
  listIdeas,
  scheduleIdea,
  unscheduleIdea,
  updateIdea,
} from '../../services/ideas'
import { getBrandProfile } from '../../brand'
import { assertAllowed } from '../../policy'

export const ideasRouter: IRouter = Router()

function parseBrandId(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, 'brand_profile_id required')
  return n
}

ideasRouter.get('/', (req: Request, res: Response) => {
  try {
    const brandId = parseBrandId(req.query.brand_profile_id)
    const statusRaw = String(req.query.status || '').trim()
    const allowed = ['new', 'shortlisted', 'dismissed', 'scheduled', 'board'] as const
    const status = allowed.includes(statusRaw as (typeof allowed)[number])
      ? (statusRaw as IdeaStatus | 'board')
      : undefined
    res.json({ ideas: listIdeas(brandId, status) })
  } catch (e) {
    sendApiError(res, e)
  }
})

ideasRouter.post('/generate', async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as {
      brand_profile_id?: number
      count?: number
      steer?: string
      pillar?: string
      format?: PostFormat
      like_idea_id?: number
      actor?: { id?: string; name?: string; role?: string }
    }
    const brandId = parseBrandId(body.brand_profile_id)
    const brand = getBrandProfile(brandId)
    if (!brand) throw new ApiError(404, 'brand not found')
    const actor = actorFromRequest(body.actor)
    assertAllowed(actor, 'calendar.plan', { type: 'brand', brand })

    if (body.count != null) {
      const c = Number(body.count)
      if (!Number.isInteger(c) || c < 1 || c > 12) {
        throw new ApiError(400, 'count must be an integer 1–12')
      }
    }
    if (body.steer != null && String(body.steer).length > 300) {
      throw new ApiError(400, 'steer must be ≤300 characters')
    }
    if (
      body.format != null &&
      body.format !== 'feed' &&
      body.format !== 'reel' &&
      body.format !== 'carousel'
    ) {
      throw new ApiError(400, 'format must be feed, reel, or carousel')
    }

    const result = await generateIdeaBatch(brandId, {
      count: body.count,
      steer: body.steer,
      pillar: body.pillar,
      format: body.format,
      likeIdeaId: body.like_idea_id,
    })
    res.status(201).json(result)
  } catch (e) {
    if (e instanceof ApiError) return sendApiError(res, e)
    const msg = e instanceof Error ? e.message : String(e)
    res.status(502).json({ error: msg })
  }
})

ideasRouter.post('/', (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as {
      brand_profile_id?: number
      topic?: string
      angle?: string
      pillar?: string
      format?: PostFormat
      hooks?: string[]
      actor?: { id?: string; name?: string; role?: string }
    }
    const brandId = parseBrandId(body.brand_profile_id)
    const brand = getBrandProfile(brandId)
    if (!brand) throw new ApiError(404, 'brand not found')
    assertAllowed(actorFromRequest(body.actor), 'calendar.plan', { type: 'brand', brand })

    const topic = String(body.topic || '').trim()
    if (!topic || topic.length > 200) throw new ApiError(400, 'topic must be 1–200 characters')
    if (body.angle != null && String(body.angle).length > 300) {
      throw new ApiError(400, 'angle must be ≤300 characters')
    }
    if (body.hooks != null) {
      if (!Array.isArray(body.hooks) || body.hooks.length > 3) {
        throw new ApiError(400, 'hooks must be an array of ≤3 items')
      }
      if (body.hooks.some((h) => String(h).length > 150)) {
        throw new ApiError(400, 'each hook must be ≤150 characters')
      }
    }

    const idea = createManualIdea(brandId, {
      topic,
      angle: body.angle,
      pillar: body.pillar,
      format: body.format,
      hooks: body.hooks,
    })
    res.status(201).json({ idea })
  } catch (e) {
    sendApiError(res, e)
  }
})

ideasRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) throw new ApiError(400, 'invalid id')
    res.json({ idea: getIdea(id) })
  } catch (e) {
    sendApiError(res, e)
  }
})

ideasRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) throw new ApiError(400, 'invalid id')
    const body = (req.body || {}) as Record<string, unknown>
    const idea = getIdea(id)
    const brand = getBrandProfile(idea.brand_profile_id)
    if (!brand) throw new ApiError(404, 'brand not found')
    assertAllowed(actorFromRequest(body.actor as { id?: string }), 'calendar.plan', {
      type: 'brand',
      brand,
    })

    if (body.chosen_hook != null && String(body.chosen_hook).length > 150) {
      throw new ApiError(400, 'chosen_hook must be ≤150 characters')
    }
    if (body.direction != null && String(body.direction).length > 1000) {
      throw new ApiError(400, 'direction must be ≤1000 characters')
    }

    const updated = updateIdea(id, {
      topic: body.topic !== undefined ? String(body.topic) : undefined,
      angle: body.angle !== undefined ? (body.angle as string | null) : undefined,
      pillar: body.pillar !== undefined ? (body.pillar as string | null) : undefined,
      format: body.format !== undefined ? (body.format as PostFormat | null) : undefined,
      chosen_hook:
        body.chosen_hook !== undefined ? (body.chosen_hook as string | null) : undefined,
      direction: body.direction !== undefined ? (body.direction as string | null) : undefined,
      status: body.status !== undefined ? (body.status as IdeaStatus) : undefined,
    })
    res.json({ idea: updated })
  } catch (e) {
    sendApiError(res, e)
  }
})

ideasRouter.post('/:id/schedule', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) throw new ApiError(400, 'invalid id')
    const body = (req.body || {}) as {
      date?: string
      account_id?: string | null
      actor?: { id?: string; name?: string; role?: string }
    }
    const result = scheduleIdea(
      id,
      { date: String(body.date || ''), account_id: body.account_id },
      actorFromRequest(body.actor),
    )
    res.status(201).json(result)
  } catch (e) {
    sendApiError(res, e)
  }
})

ideasRouter.post('/:id/unschedule', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) throw new ApiError(400, 'invalid id')
    const body = (req.body || {}) as { actor?: { id?: string; name?: string; role?: string } }
    const idea = unscheduleIdea(id, actorFromRequest(body.actor))
    res.json({ idea })
  } catch (e) {
    sendApiError(res, e)
  }
})
