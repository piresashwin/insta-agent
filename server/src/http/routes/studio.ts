import { Router, type IRouter, type Request, type Response } from 'express'
import { SceneDocParseError, parseSceneDocJson, emptyTokens } from '@instagram-agent/shared'
import crypto from 'crypto'
import db from '../../db'
import { sendApiError } from '../helpers'
import { renderPostScene } from '../../render/render-post'
import { uploadStagedPng } from '../../media/r2'
import {
  isStudioAction,
  loadPostSceneById,
  runAlternateHooks,
  runAutoLayout,
  runGenerateBackgroundPrompt,
  punchUpText,
  rewriteTextLocal,
  applyTextToSelected,
  type StudioActionResult,
} from '../../generation/studio-actions'
import { downloadStockForPost } from '../../media/stock'
import { getBrandProfile } from '../../brand'
import { resolvePostScene } from '../../scene/resolve'

export const studioRouter: IRouter = Router()

// ── Scene endpoints ────────────────────────────────────────────────────────────

/** GET /api/posts/:id/scene — returns scene_json (upgrades from slides/prompt_vars on first access). */
studioRouter.get('/:id/scene', (req: Request, res: Response) => {
  const postId = Number(req.params.id)
  if (isNaN(postId)) return void sendApiError(res, new Error('Invalid post id'))

  const row = db
    .prepare('SELECT canvas_json, format FROM posts WHERE id = ?')
    .get(postId) as { canvas_json: string | null; format: string | null } | undefined

  if (!row) return void res.status(404).json({ error: 'Post not found' })

  try {
    const { doc } = resolvePostScene(db, postId)
    res.json({
      scene_json: JSON.stringify(doc),
      canvas_json: row.canvas_json ?? null,
      format: row.format ?? 'feed',
    })
  } catch (err) {
    return void sendApiError(res, err)
  }
})

/** PATCH /api/posts/:id/scene — saves scene_json */
studioRouter.patch('/:id/scene', (req: Request, res: Response) => {
  const postId = Number(req.params.id)
  if (isNaN(postId)) return void sendApiError(res, new Error('Invalid post id'))

  const row = db.prepare('SELECT status FROM posts WHERE id = ?').get(postId) as { status: string } | undefined
  if (!row) return void res.status(404).json({ error: 'Post not found' })

  const editable = new Set(['draft', 'pending_approval', 'changes_requested', 'needs_revision',
    'approved', 'media_ready', 'staged'])
  if (!editable.has(row.status)) {
    return void res.status(409).json({ error: `Post in status ${row.status} cannot be edited` })
  }

  const { scene_json } = req.body as { scene_json?: string }
  if (!scene_json) return void res.status(400).json({ error: 'scene_json required' })

  let doc
  try {
    doc = parseSceneDocJson(scene_json)
  } catch (err) {
    if (err instanceof SceneDocParseError) {
      return void res.status(400).json({ error: 'Invalid SceneDoc', issues: err.issues })
    }
    return void res.status(400).json({ error: 'scene_json must be valid JSON' })
  }

  db.prepare('UPDATE posts SET scene_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(doc), postId)

  res.json({ ok: true })
})

/**
 * POST /api/posts/:id/render — render scene pages to PNG assets.
 * Unchanged scenes reuse existing assets via stable scenePageHash.
 */
studioRouter.post('/:id/render', async (req: Request, res: Response) => {
  const postId = Number(req.params.id)
  if (isNaN(postId)) return void sendApiError(res, new Error('Invalid post id'))

  const exists = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId)
  if (!exists) return void res.status(404).json({ error: 'Post not found' })

  try {
    const result = await renderPostScene(db, postId, async ({ postId: pid, position, bytes }) => {
      const uploaded = await uploadStagedPng({ postId: pid, position, bytes })
      return { url: uploaded.publicUrl }
    })
    res.json({
      sceneHash: result.sceneHash,
      pages: result.pages.map(({ url, sha256, w, h }) => ({ url, sha256, w, h })),
    })
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 404) return void res.status(404).json({ error: 'Post not found' })
    return void sendApiError(res, err)
  }
})

/**
 * POST /api/posts/:id/studio/:action — AI studio actions (inline, with cost labels).
 * Actions: generate-background | variations | replace-from-stock | rewrite-text |
 *          punch-up-text | alternate-hooks | auto-layout
 */
studioRouter.post('/:id/studio/:action', async (req: Request, res: Response) => {
  const postId = Number(req.params.id)
  const action = String(req.params.action)
  if (isNaN(postId)) return void sendApiError(res, new Error('Invalid post id'))
  if (!isStudioAction(action)) {
    return void res.status(400).json({ error: `Unknown action: ${action}` })
  }

  const row = db
    .prepare(
      `SELECT scene_json, canvas_json, format, hook, brand_profile_id, stock_search_query, image_prompt
       FROM posts WHERE id = ?`,
    )
    .get(postId) as
    | {
        scene_json: string | null
        canvas_json: string | null
        format: string | null
        hook: string | null
        brand_profile_id: number | null
        stock_search_query: string | null
        image_prompt: string | null
      }
    | undefined

  if (!row) return void res.status(404).json({ error: 'Post not found' })

  const body = req.body as {
    brief?: string
    layerId?: string
    text?: string
    query?: string
    pageCount?: number
    points?: string[]
    cta?: string
  }

  const brand = row.brand_profile_id ? getBrandProfile(row.brand_profile_id) : null
  let identity: { render_style?: string; palette?: Record<string, string> } = {}
  try {
    identity = brand?.visual_identity ? JSON.parse(brand.visual_identity) : {}
  } catch {
    identity = {}
  }
  const tokens = {
    colors: {
      primary: identity.palette?.primary ?? '#b8336a',
      secondary: identity.palette?.secondary ?? '#4a4a4a',
      accent: identity.palette?.accent ?? '#e8a838',
      background: identity.palette?.background ?? '#1a1a2e',
    },
    fonts: emptyTokens().fonts,
  }

  try {
    let result: StudioActionResult

    if (action === 'generate-background' || action === 'variations') {
      const { studioGenerateJobOpts } = await import('../../services/studio-generate')
      const { enqueueJob } = await import('../../jobs')
      const built =
        action === 'generate-background'
          ? runGenerateBackgroundPrompt({
              brief: body.brief || row.image_prompt || row.hook || 'brand scene',
              renderStyle: identity.render_style,
              format: (row.format as 'feed' | 'reel' | 'carousel') || 'feed',
            })
          : null
      const jobId = enqueueJob(
        studioGenerateJobOpts({
          postId,
          action,
          brief: body.brief || row.image_prompt || row.hook || undefined,
        }),
      )
      result = {
        action,
        costLabel: built?.costLabel ?? '~$0.08',
        job_id: jobId,
        note:
          action === 'generate-background'
            ? 'generate_media job queued for background'
            : 'generate_media job queued for 4 variations',
      }
    } else if (action === 'replace-from-stock') {
      const query = body.query || row.stock_search_query || row.hook || 'lifestyle'
      const saved = await downloadStockForPost(postId, query)
      const sha = crypto.createHash('sha256').update(saved.publicUrl).digest('hex')
      const existing = db.prepare('SELECT * FROM assets WHERE sha256 = ?').get(sha) as
        | { url: string; sha256: string | null }
        | undefined
      let url = existing?.url
      if (!existing) {
        const info = db
          .prepare(
            `INSERT INTO assets (kind, url, w, h, source, provider, prompt, sha256, post_id, brand_id)
             VALUES ('image', ?, NULL, NULL, 'stock', ?, ?, ?, ?, ?)`,
          )
          .run(
            saved.publicUrl,
            saved.provider,
            query,
            sha,
            postId,
            row.brand_profile_id,
          )
        url = (db.prepare('SELECT url FROM assets WHERE id = ?').get(info.lastInsertRowid) as { url: string }).url
      }
      const doc = loadPostSceneById(postId)
      const page = doc.pages[0]
      if (page) {
        page.background = {
          kind: 'image',
          assetId: url!,
          fit: 'cover',
          focusX: 0.5,
          focusY: 0.5,
        }
      }
      db.prepare('UPDATE posts SET scene_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        JSON.stringify(doc),
        postId,
      )
      result = {
        action,
        costLabel: 'stock · free',
        scene_json: JSON.stringify(doc),
        assets: [{ url: url!, sha256: sha }],
      }
    } else if (action === 'rewrite-text' || action === 'punch-up-text') {
      const doc = loadPostSceneById(postId)
      const src =
        body.text ||
        (doc.pages[0]?.layers.find((l) => l.type === 'text' && (!body.layerId || l.id === body.layerId)) as
          | { text?: string }
          | undefined)?.text ||
        row.hook ||
        ''
      const next = action === 'punch-up-text' ? punchUpText(src) : rewriteTextLocal(src)
      const updated = applyTextToSelected(doc, body.layerId, next)
      db.prepare('UPDATE posts SET scene_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        JSON.stringify(updated),
        postId,
      )
      result = {
        action,
        costLabel: 'local · $0',
        scene_json: JSON.stringify(updated),
        note: next,
      }
    } else if (action === 'alternate-hooks') {
      const hooks = await runAlternateHooks({ hook: body.text || row.hook || 'New post', postId })
      result = { action, costLabel: '~$0.01', hooks }
    } else {
      // auto-layout
      const doc = runAutoLayout({
        brief: {
          hook: body.text || row.hook || 'Your hook',
          points: body.points,
          pageCount: body.pageCount,
          cta: body.cta,
        },
        tokens,
        format: (row.format as 'feed' | 'reel' | 'carousel') || 'feed',
      })
      db.prepare('UPDATE posts SET scene_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        JSON.stringify(doc),
        postId,
      )
      result = {
        action,
        costLabel: 'local · $0',
        scene_json: JSON.stringify(doc),
      }
    }

    res.json(result)
  } catch (err) {
    return void sendApiError(res, err)
  }
})

// ── Asset endpoints ────────────────────────────────────────────────────────────

type AssetRow = {
  id: number
  kind: string
  url: string
  w: number | null
  h: number | null
  source: string
  provider: string | null
  prompt: string | null
  sha256: string | null
  post_id: number | null
  brand_id: number | null
  created_at: string
}

/** GET /api/assets?brand_id=&post_id=&kind= */
studioRouter.get('/assets', (req: Request, res: Response) => {
  const brandId = req.query.brand_id ? Number(req.query.brand_id) : null
  const postId  = req.query.post_id  ? Number(req.query.post_id)  : null
  const kind    = req.query.kind as string | undefined

  let sql = 'SELECT * FROM assets'
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (brandId) { conditions.push('brand_id = ?'); params.push(brandId) }
  if (postId)  { conditions.push('post_id = ?');  params.push(postId) }
  if (kind)    { conditions.push('kind = ?');     params.push(kind) }

  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`
  sql += ' ORDER BY created_at DESC LIMIT 200'

  const stmt = db.prepare(sql)
  const rows = stmt.all(...params) as AssetRow[]

  res.json({ assets: rows })
})

/** POST /api/assets — register a new asset */
studioRouter.post('/assets', (req: Request, res: Response) => {
  const { kind, url, w, h, source, provider, prompt, sha256, post_id, brand_id } =
    req.body as Partial<AssetRow>

  if (!kind || !url || !source) return void res.status(400).json({ error: 'kind, url and source required' })

  if (sha256) {
    const existing = db.prepare('SELECT id FROM assets WHERE sha256 = ?').get(sha256) as { id: number } | undefined
    if (existing) {
      const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(existing.id) as AssetRow
      return void res.status(200).json(row)
    }
  }

  const info = db.prepare(`
    INSERT INTO assets (kind, url, w, h, source, provider, prompt, sha256, post_id, brand_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(kind, url, w ?? null, h ?? null, source, provider ?? null, prompt ?? null,
         sha256 ?? null, post_id ?? null, brand_id ?? null)

  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(info.lastInsertRowid) as AssetRow
  res.status(201).json(row)
})

/** DELETE /api/assets/:id */
studioRouter.delete('/assets/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return void sendApiError(res, new Error('Invalid id'))
  db.prepare('DELETE FROM assets WHERE id = ?').run(id)
  res.json({ ok: true })
})
