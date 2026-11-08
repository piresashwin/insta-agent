import { Router, type IRouter, type Request, type Response } from 'express'
import { listCalendarPosts } from '../../brand'

export const calendarRouter: IRouter = Router()

calendarRouter.get('/', (req: Request, res: Response) => {
  const from = typeof req.query.from === 'string' ? req.query.from : ''
  const to = typeof req.query.to === 'string' ? req.query.to : ''
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to query params required (ISO dates)' })
  }
  const brand_profile_id =
    typeof req.query.brand_profile_id === 'string' && req.query.brand_profile_id
      ? Number(req.query.brand_profile_id)
      : undefined
  const account_id =
    typeof req.query.account_id === 'string' ? req.query.account_id : undefined
  const posts = listCalendarPosts({
    from,
    to,
    brand_profile_id: Number.isFinite(brand_profile_id) ? brand_profile_id : undefined,
    account_id,
  })
  res.json({ posts })
})
