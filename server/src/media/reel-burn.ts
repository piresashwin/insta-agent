/**
 * Burn timed text overlays onto reel MP4 via ffmpeg ASS subtitles.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CanvasDoc, CanvasLayer } from '@instagram-agent/shared'
import { layerVisibleAt } from '@instagram-agent/shared'
import { readLocalAssetBytes } from './r2'
import { FORMAT_EXPORT } from '@instagram-agent/shared'

export function whichFfmpeg(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('which', ['ffmpeg'])
    let out = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.on('close', (code) => {
      const bin = out.trim()
      if (code === 0 && bin) resolve(bin)
      else reject(new Error('ffmpeg not found on PATH — install ffmpeg to bake reel text'))
    })
  })
}

function assEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N')
}

function toAssTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rem = s % 60
  const whole = Math.floor(rem)
  const cs = Math.round((rem - whole) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function layersToAss(doc: CanvasDoc, width: number, height: number): string {
  const font = doc.layers[0]?.fontFamily || 'Arial'
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const events: string[] = []
  for (const layer of doc.layers) {
    if (!layer.text?.trim()) continue
    const start = layer.startSec != null ? Number(layer.startSec) : 0
    const end =
      layer.endSec != null && Number.isFinite(layer.endSec)
        ? Number(layer.endSec)
        : start + 4
    if (end <= start) continue
    // Sanity: skip layers that never show in first 60s window
    if (!layerVisibleAt({ ...layer, startSec: start, endSec: end } as CanvasLayer, start + 0.01)) {
      continue
    }
    const y = Math.round((layer.y + 0.02) * height)
    const text = assEscape(layer.text.trim())
    events.push(
      `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,{\\pos(${Math.round(width / 2)},${y})}${text}`
    )
  }
  return header + events.join('\n') + '\n'
}

async function resolveVideoPath(reelUrl: string): Promise<{ path: string; cleanup?: string }> {
  const bytes = readLocalAssetBytes(reelUrl)
  if (bytes) {
    // Prefer writing a temp copy only if we can't resolve absolute path
    const idx = reelUrl.indexOf('/assets/')
    if (idx >= 0) {
      const rel = reelUrl.slice(idx + '/assets/'.length).split('?')[0]
      const abs = path.join(__dirname, '..', '..', 'assets', ...rel.split('/'))
      if (fs.existsSync(abs)) return { path: abs }
    }
  }
  const res = await fetch(reelUrl)
  if (!res.ok) throw new Error(`Cannot download reel for burn: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = path.join(os.tmpdir(), `reel-in-${Date.now()}.mp4`)
  fs.writeFileSync(tmp, buf)
  return { path: tmp, cleanup: tmp }
}

export async function burnReelOverlays(opts: {
  reelUrl: string
  doc: CanvasDoc
  outPath: string
}): Promise<{ outPath: string }> {
  const ffmpeg = await whichFfmpeg()
  const { width, height } = FORMAT_EXPORT.reel
  const assBody = layersToAss(opts.doc, width, height)
  const assPath = path.join(os.tmpdir(), `reel-${Date.now()}.ass`)
  fs.writeFileSync(assPath, assBody, 'utf8')

  const input = await resolveVideoPath(opts.reelUrl)
  const outDir = path.dirname(opts.outPath)
  fs.mkdirSync(outDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    // Escape path for ass filter (colons / special chars)
    const assEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
    const args = [
      '-y',
      '-i',
      input.path,
      '-vf',
      `ass='${assEsc}'`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'copy',
      opts.outPath,
    ]
    const p = spawn(ffmpeg, args)
    let err = ''
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (code) => {
      try {
        fs.unlinkSync(assPath)
      } catch {
        /* ignore */
      }
      if (input.cleanup) {
        try {
          fs.unlinkSync(input.cleanup)
        } catch {
          /* ignore */
        }
      }
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg burn failed (code ${code}): ${err.slice(-800)}`))
    })
  })

  return { outPath: opts.outPath }
}

/**
 * Extract one frame (default: where the hook is fully on screen) as a 1080×1920 JPEG
 * cover for Graph `cover_url`. Returns null when ffmpeg is missing or extraction fails —
 * publish then falls back to `thumb_offset`.
 */
export async function extractReelCover(opts: {
  videoPath: string
  atSec: number
  outPath: string
}): Promise<string | null> {
  let ffmpeg: string
  try {
    ffmpeg = await whichFfmpeg()
  } catch {
    return null
  }
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true })
  const { width, height } = FORMAT_EXPORT.reel
  const ok = await new Promise<boolean>((resolve) => {
    const args = [
      '-y',
      '-ss',
      Math.max(0, opts.atSec).toFixed(2),
      '-i',
      opts.videoPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      '-q:v',
      '3',
      opts.outPath,
    ]
    const p = spawn(ffmpeg, args)
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0 && fs.existsSync(opts.outPath)))
  })
  return ok ? opts.outPath : null
}
