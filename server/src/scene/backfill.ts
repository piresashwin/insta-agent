/**
 * Idempotent v1 → v2 scene_json backfill for posts.
 */

import {
  SceneDocSchema,
  upgradePostToScene,
  type SceneDoc,
} from '@instagram-agent/shared'
import type { DatabaseSync } from 'node:sqlite'

export type BackfillStats = {
  scanned: number
  converted: number
  skipped: number
  failed: number
  errors: Array<{ postId: number; message: string }>
}

type PostRow = {
  id: number
  format: string | null
  canvas_json: string | null
  source_image_url: string | null
  image_url: string | null
  hook: string | null
  scene_json: string | null
  prompt_vars: string | null
}

type SlideRow = {
  position: number
  canvas_json: string | null
  source_image_url: string | null
  text: string | null
}

export function backfillSceneJson(database: DatabaseSync): BackfillStats {
  const stats: BackfillStats = {
    scanned: 0,
    converted: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  const posts = database
    .prepare(
      `SELECT id, format, canvas_json, source_image_url, image_url, hook, scene_json, prompt_vars
       FROM posts
       WHERE scene_json IS NULL`,
    )
    .all() as PostRow[]

  const slideStmt = database.prepare(
    `SELECT position, canvas_json, source_image_url, text
     FROM post_slides
     WHERE post_id = ?
     ORDER BY position ASC`,
  )
  const updateStmt = database.prepare(
    `UPDATE posts SET scene_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND scene_json IS NULL`,
  )

  for (const post of posts) {
    stats.scanned += 1
    try {
      const slides = slideStmt.all(post.id) as SlideRow[]
      const doc: SceneDoc = upgradePostToScene({
        format: post.format,
        canvas_json: post.canvas_json,
        source_image_url: post.source_image_url,
        image_url: post.image_url,
        hook: post.hook,
        slides,
        prompt_vars: post.prompt_vars,
      })

      const validated = SceneDocSchema.safeParse(doc)
      if (!validated.success) {
        stats.failed += 1
        stats.errors.push({
          postId: post.id,
          message: validated.error.issues.map((i) => i.message).join('; '),
        })
        continue
      }

      const result = updateStmt.run(JSON.stringify(validated.data), post.id)
      if (result.changes === 0) {
        stats.skipped += 1
      } else {
        stats.converted += 1
      }
    } catch (err) {
      stats.failed += 1
      stats.errors.push({
        postId: post.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return stats
}
