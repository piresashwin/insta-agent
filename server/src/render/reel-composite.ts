/**
 * Scene-based reel compositing — pure filtergraph builders + ffmpeg runner.
 */

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SceneDoc, SceneTimeline } from '@instagram-agent/shared'
import { whichFfmpeg, extractReelCover } from '../media/reel-burn'
import { renderScenePage } from './scene-render'

export type OverlayWindow = {
  layerId: string
  start: number
  end: number
}

export type OverlayInput = {
  /** Input index in ffmpeg (0 = base video). Overlay PNGs start at 1. */
  inputIndex: number
  start: number
  end: number
}

/**
 * One overlay window per visible layer on the first page, timed by its
 * startSec/endSec and clamped to [0, durationSec]. This is exactly the set of
 * overlays `compositeReelFromScene` renders and composites — each visible layer
 * becomes one timed overlay (a layer with no timing shows for the whole clip).
 * Zero-length and hidden layers are dropped.
 */
export function overlayWindows(doc: SceneDoc): OverlayWindow[] {
  const timeline: SceneTimeline = doc.timeline ?? { durationSec: 8 }
  const duration = Math.max(0.1, timeline.durationSec)
  const page = doc.pages[0]
  if (!page) return []

  return page.layers
    .filter((l) => l.visible !== false)
    .map((l) => ({
      layerId: l.id,
      start: Math.max(0, l.startSec ?? 0),
      end: Math.min(duration, l.endSec ?? duration),
    }))
    .filter((w) => w.end > w.start)
}

/** Pure ffmpeg filtergraph: overlay each PNG input with enable='between(t,a,b)'. */
export function buildOverlayFilter(overlays: OverlayInput[]): string {
  if (overlays.length === 0) return 'null'

  let prev = '[0:v]'
  const parts: string[] = []
  overlays.forEach((o, i) => {
    const a = Number(o.start.toFixed(3))
    const b = Number(o.end.toFixed(3))
    const outLabel = i === overlays.length - 1 ? '[vout]' : `[v${i}]`
    parts.push(
      `${prev}[${o.inputIndex}:v]overlay=0:0:enable='between(t,${a},${b})'${outLabel}`,
    )
    prev = outLabel
  })
  return parts.join(';')
}

/**
 * Render each visible layer to a full-frame PNG (other layers hidden), then
 * composite over the base reel with ffmpeg overlay filters. The overlay set
 * and timing come from `overlayWindows` — the same pure function the tests cover.
 */
export async function compositeReelFromScene(opts: {
  reelUrl: string
  doc: SceneDoc
  outPath: string
}): Promise<{ outPath: string; coverPath: string | null }> {
  const ffmpeg = await whichFfmpeg()
  const windows = overlayWindows(opts.doc)
  const tmpDir = path.join(os.tmpdir(), `reel-comp-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const overlayPaths: string[] = []
  const overlayInputs: OverlayInput[] = []

  try {
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i]
      const solo: SceneDoc = {
        ...opts.doc,
        pages: [
          {
            ...opts.doc.pages[0],
            layers: opts.doc.pages[0].layers.map((l) =>
              l.id === win.layerId ? { ...l, visible: true } : { ...l, visible: false },
            ),
          },
        ],
      }
      // Transparent-ish: dark clear background so only the layer content shows.
      // For text/shapes on video we use a near-black bg and overlay with enable windows.
      const png = await renderScenePage(
        {
          ...solo,
          pages: [
            {
              ...solo.pages[0],
              background: { kind: 'color', color: '#00000000' },
            },
          ],
        },
        { pageIndex: 0 },
      )
      const pngPath = path.join(tmpDir, `ov-${i}.png`)
      fs.writeFileSync(pngPath, png)
      overlayPaths.push(pngPath)
      overlayInputs.push({
        inputIndex: i + 1,
        start: win.start,
        end: win.end,
      })
    }

    const filter =
      overlayInputs.length > 0 ? buildOverlayFilter(overlayInputs) : 'null'
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true })

    const args = ['-y', '-i', opts.reelUrl]
    for (const p of overlayPaths) {
      args.push('-i', p)
    }
    if (overlayInputs.length > 0) {
      // Map the composited video plus the base clip's audio (if any — `?` makes
      // it optional so a silent reel still succeeds). Without an explicit audio
      // map, using -map drops the original audio track entirely.
      args.push('-filter_complex', filter, '-map', '[vout]', '-map', '0:a?')
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy')
    } else {
      args.push('-c', 'copy')
    }
    args.push(opts.outPath)

    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpeg, args)
      let err = ''
      p.stderr.on('data', (d) => (err += String(d)))
      p.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg composite failed (code ${code}): ${err.slice(-800)}`))
      })
    })

    const coverSec = opts.doc.timeline?.coverFrameSec ?? 0
    const coverPath = path.join(tmpDir, 'cover.jpg')
    const cover = await extractReelCover({
      videoPath: opts.outPath,
      atSec: coverSec,
      outPath: coverPath,
    })

    return { outPath: opts.outPath, coverPath: cover }
  } finally {
    // Keep cover if returned; clean overlay PNGs
    for (const p of overlayPaths) {
      try {
        fs.unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  }
}
