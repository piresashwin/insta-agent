/**
 * Zod schemas for SceneDoc v2 — single source of truth for types + validation.
 */

import { z } from 'zod'

export const TextAnimSchema = z.enum(['none', 'fade', 'slideUp', 'slideDown', 'scaleIn'])

export const BrandTokensSchema = z.object({
  colors: z.record(z.string()),
  fonts: z.record(z.string()),
})

export const SceneBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('color'),
    color: z.string(),
  }),
  z.object({
    kind: z.literal('image'),
    assetId: z.string(),
    fit: z.enum(['cover', 'contain', 'fill']),
    focusX: z.number(),
    focusY: z.number(),
  }),
  z.object({
    kind: z.literal('gradient'),
    stops: z.array(
      z.object({
        offset: z.number(),
        color: z.string(),
      }),
    ),
    angle: z.number(),
  }),
])

const layerBase = {
  id: z.string().min(1),
  name: z.string().optional(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  lock: z.boolean().optional(),
  visible: z.boolean().optional(),
  startSec: z.number().nullable().optional(),
  endSec: z.number().nullable().optional(),
  enterAnim: TextAnimSchema.nullable().optional(),
  exitAnim: TextAnimSchema.nullable().optional(),
  animMs: z.number().nullable().optional(),
}

export const SceneTextLayerSchema = z.object({
  ...layerBase,
  type: z.literal('text'),
  text: z.string(),
  fontSize: z.number(),
  fontFamily: z.string().nullable().optional(),
  fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700)]).optional(),
  color: z.string(),
  align: z.enum(['left', 'center', 'right']).optional(),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  shadow: z.boolean().optional(),
  uppercase: z.boolean().optional(),
})

export const SceneImageLayerSchema = z.object({
  ...layerBase,
  type: z.literal('image'),
  assetId: z.string().optional(),
  url: z.string().optional(),
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
  cornerRadius: z.number().optional(),
})

export const SceneShapeLayerSchema = z.object({
  ...layerBase,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse']),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  cornerRadius: z.number().optional(),
  scrim: z.enum(['none', 'bottom', 'full']).optional(),
})

export type SceneTextLayer = z.infer<typeof SceneTextLayerSchema>
export type SceneImageLayer = z.infer<typeof SceneImageLayerSchema>
export type SceneShapeLayer = z.infer<typeof SceneShapeLayerSchema>

export type SceneGroupLayer = {
  id: string
  name?: string
  x: number
  y: number
  w: number
  h: number
  rotation?: number
  opacity?: number
  lock?: boolean
  visible?: boolean
  startSec?: number | null
  endSec?: number | null
  enterAnim?: z.infer<typeof TextAnimSchema> | null
  exitAnim?: z.infer<typeof TextAnimSchema> | null
  animMs?: number | null
  type: 'group'
  children: SceneLayer[]
}

export type SceneLayer =
  | SceneTextLayer
  | SceneImageLayer
  | SceneShapeLayer
  | SceneGroupLayer

export type SceneLayerBase = Omit<SceneTextLayer, 'type' | 'text' | 'fontSize' | 'color' | 'fontFamily' | 'fontWeight' | 'align' | 'lineHeight' | 'letterSpacing' | 'shadow' | 'uppercase'>

const SceneGroupLayerSchema: z.ZodType<SceneGroupLayer> = z.lazy(() =>
  z.object({
    ...layerBase,
    type: z.literal('group'),
    children: z.array(SceneLayerSchema),
  }),
)

export const SceneLayerSchema: z.ZodType<SceneLayer> = z.lazy(() =>
  z.union([
    SceneTextLayerSchema,
    SceneImageLayerSchema,
    SceneShapeLayerSchema,
    SceneGroupLayerSchema,
  ]),
)

export const ScenePageSchema = z.object({
  id: z.string().min(1),
  background: SceneBackgroundSchema,
  layers: z.array(SceneLayerSchema),
  thumbUrl: z.string().nullable().optional(),
})

export const SceneTimelineSchema = z.object({
  durationSec: z.number(),
  coverFrameSec: z.number().optional(),
})

export const SceneDocSchema = z.object({
  version: z.literal(2),
  format: z.enum(['feed', 'reel', 'carousel']),
  size: z.object({
    w: z.number(),
    h: z.number(),
  }),
  tokens: BrandTokensSchema,
  pages: z.array(ScenePageSchema).min(1),
  timeline: SceneTimelineSchema.optional(),
})

export type BrandTokens = z.infer<typeof BrandTokensSchema>
export type SceneBackground = z.infer<typeof SceneBackgroundSchema>
export type ScenePage = z.infer<typeof ScenePageSchema>
export type SceneTimeline = z.infer<typeof SceneTimelineSchema>
export type SceneDoc = z.infer<typeof SceneDocSchema>

export type SceneDocParseIssue = {
  path: string
  message: string
}

export class SceneDocParseError extends Error {
  readonly issues: SceneDocParseIssue[]

  constructor(issues: SceneDocParseIssue[]) {
    super('Invalid SceneDoc')
    this.name = 'SceneDocParseError'
    this.issues = issues
  }
}

function formatIssues(error: z.ZodError): SceneDocParseIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }))
}

/** Validate an unknown value as SceneDoc. Throws SceneDocParseError on failure. */
export function parseSceneDoc(raw: unknown): SceneDoc {
  const result = SceneDocSchema.safeParse(raw)
  if (!result.success) {
    throw new SceneDocParseError(formatIssues(result.error))
  }
  return result.data
}

/** Parse a JSON string into a SceneDoc. Throws on invalid JSON or schema failure. */
export function parseSceneDocJson(json: string): SceneDoc {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new SceneDocParseError([{ path: '(root)', message: 'scene_json must be valid JSON' }])
  }
  return parseSceneDoc(parsed)
}
