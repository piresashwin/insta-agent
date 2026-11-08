import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import os from 'os'
import {
  SceneDocSchema,
  type CanvasDoc,
  type FeedPromptVars,
  type CarouselPromptVars,
} from '@instagram-agent/shared'

process.env.DB_PATH = path.join(os.tmpdir(), `scene-bf-${Math.random().toString(36).slice(2)}.db`)

let db: typeof import('../db').default
let backfillSceneJson: typeof import('../scene/backfill').backfillSceneJson

beforeAll(async () => {
  const dbMod = await import('../db')
  db = dbMod.default
  const bf = await import('../scene/backfill')
  backfillSceneJson = bf.backfillSceneJson
})

function sampleV1(): CanvasDoc {
  return {
    version: 1,
    format: 'feed',
    background: { fit: 'cover', focusX: 0.5, focusY: 0.5 },
    scrim: 'none',
    layers: [
      {
        id: 'l1',
        type: 'hook',
        text: 'Backfill me',
        x: 0.1,
        y: 0.1,
        w: 0.8,
        fontSize: 64,
        align: 'center',
        color: '#ffffff',
        weight: 700,
      },
    ],
    safeZone: true,
  }
}

describe('backfillSceneJson', () => {
  it('converts a post with canvas_json and null scene_json; second run is a no-op', () => {
    const info = db
      .prepare(
        `INSERT INTO posts (status, format, canvas_json, scene_json, hook)
         VALUES ('draft', 'feed', ?, NULL, 'unused')`,
      )
      .run(JSON.stringify(sampleV1()))
    const postId = Number(info.lastInsertRowid)

    const first = backfillSceneJson(db)
    expect(first.converted).toBeGreaterThanOrEqual(1)
    expect(first.failed).toBe(0)

    const row = db
      .prepare('SELECT scene_json FROM posts WHERE id = ?')
      .get(postId) as { scene_json: string }
    expect(row.scene_json).toBeTruthy()
    const parsed = JSON.parse(row.scene_json)
    expect(SceneDocSchema.safeParse(parsed).success).toBe(true)
    expect(parsed.version).toBe(2)
    expect(parsed.pages[0].layers.some((l: { type: string; text?: string }) => l.type === 'text' && l.text === 'Backfill me')).toBe(true)

    const second = backfillSceneJson(db)
    expect(second.scanned).toBe(0)
    expect(second.converted).toBe(0)

    const again = db
      .prepare('SELECT scene_json FROM posts WHERE id = ?')
      .get(postId) as { scene_json: string }
    expect(again.scene_json).toBe(row.scene_json)
  })

  it('backfills from prompt_vars when canvas_json and slides are both empty (feed)', () => {
    const vars: FeedPromptVars = {
      format: 'feed',
      hook_on_image: 'From prompt_vars',
      caption: 'caption',
      hashtags: '#x',
      subject: 's',
      setting: 's',
      lighting: 'l',
      palette: 'p',
      font: 'f',
      scrim: 'bottom',
      aspect: '4:5',
      negative: 'n',
    }
    const info = db
      .prepare(
        `INSERT INTO posts (status, format, canvas_json, scene_json, hook, prompt_vars)
         VALUES ('draft', 'feed', NULL, NULL, 'unused', ?)`,
      )
      .run(JSON.stringify(vars))
    const postId = Number(info.lastInsertRowid)

    const result = backfillSceneJson(db)
    expect(result.failed).toBe(0)

    const row = db.prepare('SELECT scene_json FROM posts WHERE id = ?').get(postId) as { scene_json: string }
    const parsed = JSON.parse(row.scene_json)
    expect(SceneDocSchema.safeParse(parsed).success).toBe(true)
    expect(parsed.pages).toHaveLength(1)
    expect(parsed.pages[0].layers.some((l: { text?: string }) => l.text === 'From prompt_vars')).toBe(true)
  })

  it('backfills a carousel from prompt_vars with the expected page count', () => {
    const vars: CarouselPromptVars = {
      format: 'carousel',
      slide_count: 3,
      slides: [
        { on_image_text: 'Slide one', role: 'cover', visual_subject: 'a' },
        { on_image_text: 'Slide two', role: 'point', visual_subject: 'b' },
        { on_image_text: 'Slide three', role: 'cta', visual_subject: 'c' },
      ],
      palette: 'p',
      font: 'f',
      scrim: 'none',
      aspect: '4:5',
      negative: 'n',
      caption: 'caption',
      hashtags: '#x',
    }
    const info = db
      .prepare(
        `INSERT INTO posts (status, format, canvas_json, scene_json, hook, prompt_vars)
         VALUES ('draft', 'carousel', NULL, NULL, 'unused', ?)`,
      )
      .run(JSON.stringify(vars))
    const postId = Number(info.lastInsertRowid)

    const result = backfillSceneJson(db)
    expect(result.failed).toBe(0)

    const row = db.prepare('SELECT scene_json FROM posts WHERE id = ?').get(postId) as { scene_json: string }
    const parsed = JSON.parse(row.scene_json)
    expect(SceneDocSchema.safeParse(parsed).success).toBe(true)
    expect(parsed.pages).toHaveLength(3)
    expect(parsed.pages[1].layers.some((l: { text?: string }) => l.text === 'Slide two')).toBe(true)
  })
})
