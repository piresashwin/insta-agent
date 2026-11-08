import type { SceneDoc, SceneLayer, SceneTextLayer } from '@instagram-agent/shared'

type Props = {
  doc: SceneDoc
  onChangeTimeline: (patch: { durationSec?: number; coverFrameSec?: number }) => void
  onChangeLayerTiming: (layerId: string, startSec: number, endSec: number) => void
}

function timedTextLayers(doc: SceneDoc): SceneTextLayer[] {
  const page = doc.pages[0]
  if (!page) return []
  return page.layers.filter((l): l is SceneTextLayer => l.type === 'text')
}

export function ReelTimeline({ doc, onChangeTimeline, onChangeLayerTiming }: Props) {
  const duration = doc.timeline?.durationSec ?? 8
  const cover = doc.timeline?.coverFrameSec ?? 0
  const layers = timedTextLayers(doc)

  return (
    <div className="p-3 space-y-3 border-t border-[var(--border)]" data-testid="reel-timeline">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-[var(--text)]">Reel timeline</p>
        <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
          <label className="flex items-center gap-1">
            Dur
            <input
              type="number"
              min={1}
              max={90}
              step={0.5}
              value={duration}
              onChange={(e) => onChangeTimeline({ durationSec: Number(e.target.value) })}
              className="w-14 h-6 px-1 border border-[var(--control)] rounded bg-[var(--surface)] text-[var(--text)]"
            />
            s
          </label>
          <label className="flex items-center gap-1">
            Cover
            <input
              type="number"
              min={0}
              max={duration}
              step={0.1}
              value={cover}
              onChange={(e) => onChangeTimeline({ coverFrameSec: Number(e.target.value) })}
              className="w-14 h-6 px-1 border border-[var(--control)] rounded bg-[var(--surface)] text-[var(--text)]"
            />
            s
          </label>
        </div>
      </div>

      {/* Cover scrubber */}
      <div className="relative h-2 rounded-full bg-[var(--raised)]">
        <input
          type="range"
          min={0}
          max={duration}
          step={0.05}
          value={cover}
          onChange={(e) => onChangeTimeline({ coverFrameSec: Number(e.target.value) })}
          className="absolute inset-0 w-full opacity-80 cursor-pointer"
          aria-label="Cover frame"
        />
      </div>

      <div className="space-y-2 max-h-40 overflow-y-auto">
        {layers.length === 0 && (
          <p className="text-[11px] text-[var(--muted)]">Add text layers to time them on the reel.</p>
        )}
        {layers.map((layer) => {
          const start = layer.startSec ?? 0
          const end = layer.endSec ?? Math.min(duration, start + 3)
          const left = (start / duration) * 100
          const width = (Math.max(0.1, end - start) / duration) * 100
          return (
            <div key={layer.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-[var(--text)] truncate flex-1">
                  {layer.name || layer.text.slice(0, 24)}
                </span>
                <span className="text-[10px] text-[var(--muted)] tabular-nums">
                  {start.toFixed(1)}–{end.toFixed(1)}s
                </span>
              </div>
              <div className="relative h-6 rounded bg-[var(--raised)] overflow-hidden">
                <div
                  className="absolute top-0 bottom-0 bg-[var(--accent)]/40 border border-[var(--accent)] rounded-sm"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </div>
              <div className="flex gap-2">
                <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
                  In
                  <input
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={start}
                    onChange={(e) =>
                      onChangeLayerTiming(layer.id, Number(e.target.value), Math.max(Number(e.target.value) + 0.1, end))
                    }
                    className="w-14 h-6 px-1 border border-[var(--control)] rounded bg-[var(--surface)] text-[var(--text)]"
                  />
                </label>
                <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
                  Out
                  <input
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={end}
                    onChange={(e) =>
                      onChangeLayerTiming(layer.id, start, Number(e.target.value))
                    }
                    className="w-14 h-6 px-1 border border-[var(--control)] rounded bg-[var(--surface)] text-[var(--text)]"
                  />
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export type { SceneLayer }
