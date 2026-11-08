/**
 * Phase 2 — copy/media approvals + publish gate.
 */
import crypto from 'crypto'
import type { Post, PostFormat } from '@instagram-agent/shared'
import { parseSceneJson } from '@instagram-agent/shared'
import db from '../db'
import { ApiError, getPost } from '../orchestrator'
import { listSlides } from '../slides'
import { sceneHash } from '../render/hash'
import {
  actorColumns,
  historyActorFrom,
  type HistoryActor,
} from './attribution'

export type ApprovalStage = 'copy' | 'media'
export type ApprovalDecision = 'approved' | 'rejected'

export type ApprovalRow = {
  id: number
  post_id: number
  version: number
  stage: ApprovalStage
  decision: ApprovalDecision
  actor_kind: string | null
  actor_name: string | null
  actor_client: string | null
  comment: string | null
  override_reason: string | null
  created_at: string
  artifact_hash?: string | null
}

export function currentPostVersion(post: Post): number {
  return Number((post as Post & { version?: number }).version ?? 1)
}

export function recordApproval(opts: {
  postId: string | number
  stage: ApprovalStage
  decision?: ApprovalDecision
  actor?: HistoryActor | Parameters<typeof historyActorFrom>[0]
  comment?: string | null
  overrideReason?: string | null
  artifactHash?: string | null
  version?: number
}): ApprovalRow {
  const post = getPost(opts.postId)
  if (!post) throw new ApiError(404, 'post not found')

  const version = opts.version ?? currentPostVersion(post)
  const actor =
    opts.actor && 'kind' in opts.actor && typeof (opts.actor as HistoryActor).kind === 'string'
      ? (opts.actor as HistoryActor)
      : historyActorFrom(opts.actor as Parameters<typeof historyActorFrom>[0])
  const cols = actorColumns(actor)
  ensureArtifactHashColumn()

  const info = db
    .prepare(
      `INSERT INTO approvals
        (post_id, version, stage, decision, actor_kind, actor_name, actor_client, comment, override_reason, artifact_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Number(post.id),
      version,
      opts.stage,
      opts.decision ?? 'approved',
      cols.actor_kind,
      cols.actor_name,
      cols.actor_client,
      opts.comment ?? null,
      opts.overrideReason ?? null,
      opts.artifactHash ?? null,
    )

  return db
    .prepare('SELECT * FROM approvals WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as ApprovalRow
}

export function hasApproval(
  postId: string | number,
  stage: ApprovalStage,
  version?: number,
): boolean {
  const post = getPost(postId)
  if (!post) return false
  const ver = version ?? currentPostVersion(post)
  const row = db
    .prepare(
      `SELECT id FROM approvals
       WHERE post_id = ? AND stage = ? AND version = ? AND decision = 'approved'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(Number(postId), stage, ver) as { id: number } | undefined
  return !!row
}

export function latestApproval(
  postId: string | number,
  stage: ApprovalStage,
  version?: number,
): ApprovalRow | null {
  const post = getPost(postId)
  if (!post) return null
  const ver = version ?? currentPostVersion(post)
  return (
    (db
      .prepare(
        `SELECT * FROM approvals
         WHERE post_id = ? AND stage = ? AND version = ? AND decision = 'approved'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(Number(postId), stage, ver) as ApprovalRow | undefined) ?? null
  )
}

/**
 * Stable fingerprint of the post's publishable artifact.
 * Prefers sceneHash(scene_json); falls back to staged media URLs.
 * `overrides` lets callers hash the about-to-stage URLs before they are committed.
 */
export function computeArtifactHash(
  postId: string | number,
  overrides?: {
    scene_json?: string | null
    reel_url?: string | null
    image_url?: string | null
    staged_urls?: Array<string | null | undefined>
  },
): string {
  const post = getPost(postId)
  if (!post) throw new ApiError(404, 'post not found')
  const format = (post.format || 'feed') as PostFormat
  const sceneJson = overrides?.scene_json !== undefined ? overrides.scene_json : post.scene_json

  if (sceneJson) {
    try {
      const doc = parseSceneJson(sceneJson, format)
      return `scene:${sceneHash(doc)}`
    } catch {
      /* fall through to asset fingerprint */
    }
  }

  const slides = listSlides(Number(post.id))
  const staged =
    overrides?.staged_urls ??
    slides.map((s) => s.staged_url || s.source_image_url || '')
  const parts = [
    overrides?.reel_url !== undefined ? overrides.reel_url || '' : post.reel_url || '',
    overrides?.image_url !== undefined ? overrides.image_url || '' : post.image_url || '',
    ...staged.map((u) => u || ''),
  ]
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex')
  return `assets:${digest}`
}

/** Throws 409 unless copy + media approvals exist for the current version (and artifact hash matches). */
export function assertPublishApprovals(postId: string | number): void {
  const post = getPost(postId)
  if (!post) throw new ApiError(404, 'post not found')
  const ver = currentPostVersion(post)
  if (!hasApproval(postId, 'copy', ver)) {
    throw new ApiError(
      409,
      `Cannot publish: missing copy approval for version ${ver}`,
    )
  }
  const media = latestApproval(postId, 'media', ver)
  if (!media) {
    throw new ApiError(
      409,
      `Cannot publish: missing media approval for version ${ver}`,
    )
  }
  if (media.artifact_hash) {
    const current = computeArtifactHash(postId)
    if (media.artifact_hash !== current) {
      throw new ApiError(
        409,
        `Cannot publish: media artifact changed since approval (re-approve media)`,
      )
    }
  }
}

/** Gate for media_ready → staged. */
export function assertMediaApprovalForStage(postId: string | number): void {
  const post = getPost(postId)
  if (!post) throw new ApiError(404, 'post not found')
  const ver = currentPostVersion(post)
  if (!hasApproval(postId, 'media', ver)) {
    throw new ApiError(
      409,
      `Cannot stage: missing media approval for version ${ver}`,
    )
  }
}

export function judgeFailedRequiresOverride(postId: string | number): boolean {
  const post = getPost(postId)
  if (!post) return false
  const ver = currentPostVersion(post)
  const row = db
    .prepare(
      `SELECT passed FROM post_reviews
       WHERE post_id = ? AND post_version = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(Number(postId), ver) as { passed: number } | undefined
  if (!row) return false
  return row.passed !== 1
}

function ensureArtifactHashColumn(): void {
  try {
    db.exec('ALTER TABLE approvals ADD COLUMN artifact_hash TEXT')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('duplicate column')) {
      // column may already exist — ignore other "already" style errors from IF semantics
      if (!/duplicate|exists/i.test(msg)) {
        /* swallow — migrations may have added it */
      }
    }
  }
}
