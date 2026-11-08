/**
 * Resolve a post's SceneDoc, upgrading from slides/canvas/prompt_vars when needed
 * and persisting scene_json on first successful upgrade.
 */
import {
  SceneDocSchema,
  parseSceneJson,
  upgradePostToScene,
  type PostFormat,
  type SceneDoc,
} from '@instagram-agent/shared'
import type { DatabaseSync } from 'node:sqlite'

type PostRow = {
  id: number
  format: string | null
  scene_json: string | null
  canvas_json: string | null
  source_image_url: string | null
  image_url: string | null
  hook: string | null
  prompt_vars: string | null
}

type SlideRow = {
  position: number
  canvas_json: string | null
  source_image_url: string | null
  text: string | null
}

function isValidV2(raw: string | null | undefined): SceneDoc | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as { version?: number }
    if (parsed.version !== 2) return null
    const result = SceneDocSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function resolvePostScene(
  database: DatabaseSync,
  postId: number,
): { doc: SceneDoc; upgraded: boolean } {
  const row = database
    .prepare(
      `SELECT id, format, scene_json, canvas_json, source_image_url, image_url, hook, prompt_vars
       FROM posts WHERE id = ?`,
    )
    .get(postId) as PostRow | undefined
  if (!row) throw Object.assign(new Error('Post not found'), { status: 404 })

  const existing = isValidV2(row.scene_json)
  if (existing) return { doc: existing, upgraded: false }

  const slides = database
    .prepare(
      `SELECT position, canvas_json, source_image_url, text
       FROM post_slides
       WHERE post_id = ? AND archived_at IS NULL
       ORDER BY position ASC`,
    )
    .all(postId) as SlideRow[]

  const doc = upgradePostToScene({
    format: row.format,
    canvas_json: row.canvas_json,
    source_image_url: row.source_image_url,
    image_url: row.image_url,
    hook: row.hook,
    slides,
    prompt_vars: row.prompt_vars,
  })

  const validated = SceneDocSchema.safeParse(doc)
  const finalDoc = validated.success
    ? validated.data
    : parseSceneJson(row.scene_json ?? row.canvas_json, (row.format as PostFormat) || 'feed')

  database
    .prepare(
      `UPDATE posts SET scene_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .run(JSON.stringify(finalDoc), postId)

  return { doc: finalDoc, upgraded: true }
}
