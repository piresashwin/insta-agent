/**
 * Studio AI action helpers — pure builders + inline runners.
 */

import { z } from 'zod'
import {
  parseSceneJson,
  type BrandTokens,
  type PostFormat,
  type SceneDoc,
  type SceneTextLayer,
  emptyTokens,
} from '@instagram-agent/shared'
import { autoLayout, buildBackgroundPrompt, type LayoutBrief } from './layout'
import { generateObject } from '../llm/adapter'
import db from '../db'
import { resolvePostScene } from '../scene/resolve'

export const STUDIO_ACTIONS = [
  'generate-background',
  'variations',
  'replace-from-stock',
  'rewrite-text',
  'punch-up-text',
  'alternate-hooks',
  'auto-layout',
] as const

export type StudioAction = (typeof STUDIO_ACTIONS)[number]

export function isStudioAction(value: string): value is StudioAction {
  return (STUDIO_ACTIONS as readonly string[]).includes(value)
}

export type StudioActionResult = {
  action: StudioAction
  costLabel: string
  scene_json?: string
  assets?: Array<{ url: string; sha256?: string | null; prompt?: string }>
  hooks?: string[]
  note?: string
  /** When set, client should poll GET /api/jobs/:id until done. */
  job_id?: number
}

export function punchUpText(text: string): string {
  const t = text.trim()
  if (!t) return t
  if (/[.!?]$/.test(t)) return t
  return `${t}.`
}

export function rewriteTextLocal(text: string): string {
  const t = text.trim()
  if (!t) return t
  // Lightweight deterministic rewrite for offline / tests.
  return t.replace(/\s+/g, ' ').replace(/\bvery\b/gi, '').replace(/\s{2,}/g, ' ').trim()
}

export function applyTextToSelected(
  doc: SceneDoc,
  layerId: string | undefined,
  nextText: string,
): SceneDoc {
  const pages = doc.pages.map((page) => ({
    ...page,
    layers: page.layers.map((l) => {
      if (l.type !== 'text') return l
      if (layerId && l.id !== layerId) return l
      if (!layerId && l.name !== 'Hook' && page.layers.find((x) => x.type === 'text' && x.name === 'Hook')) {
        return l
      }
      if (!layerId) {
        // First text layer if no id
        const firstText = page.layers.find((x) => x.type === 'text')
        if (firstText && l.id !== firstText.id) return l
      }
      return { ...l, text: nextText } as SceneTextLayer
    }),
  }))
  return { ...doc, pages }
}

export async function runAlternateHooks(opts: {
  hook: string
  postId?: number
}): Promise<string[]> {
  try {
    const result = await generateObject({
      role: 'writer',
      schema: z.object({ hooks: z.array(z.string()).min(3).max(5) }),
      system: 'You write short Instagram hooks. No hashtags. No emoji spam.',
      prompt: `Give 4 alternate hooks for: ${opts.hook}`,
      postId: opts.postId,
      skill: 'studio-alternate-hooks',
    })
    return result.data.hooks
  } catch {
    const base = opts.hook.trim() || 'New idea'
    return [
      `${base} — here's why`,
      `Stop scrolling: ${base}`,
      `What nobody tells you about ${base}`,
      `Try this instead of ${base}`,
    ]
  }
}

export function runAutoLayout(opts: {
  brief: LayoutBrief
  tokens?: BrandTokens
  format: PostFormat
}): SceneDoc {
  return autoLayout(opts.brief, opts.tokens ?? emptyTokens(), opts.format)
}

export function runGenerateBackgroundPrompt(opts: {
  brief: string
  renderStyle?: string | null
  negativePrompt?: string | null
  format: PostFormat
}) {
  return buildBackgroundPrompt(opts)
}

export function fourVariationBriefs(brief: string): string[] {
  const b = brief.trim() || 'brand scene'
  return [
    `${b}, morning light`,
    `${b}, dramatic contrast`,
    `${b}, soft minimal`,
    `${b}, bold color block`,
  ]
}

/** @deprecated Prefer resolvePostScene(db, postId) — keeps slide/prompt_vars upgrade. */
export function loadPostScene(
  sceneJson: string | null,
  canvasJson: string | null,
  format: string | null,
): SceneDoc {
  return parseSceneJson(sceneJson ?? canvasJson, (format as PostFormat) || 'feed')
}

/** Load scene for a post, upgrading from slides/prompt_vars and persisting when needed. */
export function loadPostSceneById(postId: number): SceneDoc {
  return resolvePostScene(db, postId).doc
}
