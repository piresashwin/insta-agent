/**
 * One-shot: convert posts with null scene_json from canvas_json / post_slides.
 * Safe to re-run (skips rows that already have scene_json).
 *
 * Usage: pnpm --filter server backfill:scene
 */

import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

import db from '../src/db'
import { backfillSceneJson } from '../src/scene/backfill'

const stats = backfillSceneJson(db)

console.log(
  JSON.stringify(
    {
      scanned: stats.scanned,
      converted: stats.converted,
      skipped: stats.skipped,
      failed: stats.failed,
      errors: stats.errors.slice(0, 20),
    },
    null,
    2,
  ),
)

if (stats.failed > 0) process.exitCode = 1
