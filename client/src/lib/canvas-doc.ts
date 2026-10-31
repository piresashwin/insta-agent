import type { CanvasDoc, PostFormat } from '@instagram-agent/shared'

/** Export pixel sizes per format (carousel uses feed size per slide). */
export const FORMAT_EXPORT: Record<
  PostFormat,
  { width: number; height: number; aspect: string }
> = {
  feed: { width: 1080, height: 1350, aspect: '4 / 5' },
  reel: { width: 1080, height: 1920, aspect: '9 / 16' },
  carousel: { width: 1080, height: 1350, aspect: '4 / 5' },
}

export function defaultCanvasDoc(format: PostFormat, hook?: string | null): CanvasDoc {
  return {
    version: 1,
    format,
    background: { fit: 'cover', focusX: 0.5, focusY: 0.5 },
    scrim: 'bottom',
    layers: [
      {
        id: 'hook',
        type: 'hook',
        text: (hook || '').trim() || 'Your hook',
        x: 0.08,
        y: 0.72,
        w: 0.84,
        fontSize: 0.045,
        align: 'center',
        color: '#ffffff',
        weight: 700,
        shadow: true,
      },
    ],
    safeZone: true,
  }
}

export const TEXT_COLORS = [
  '#ffffff',
  '#15191e',
  '#f2f5f8',
  '#c9184a',
  '#3d6ea8',
  '#0f7a4a',
  '#f5d76e',
] as const
