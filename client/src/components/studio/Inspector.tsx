import type { SceneLayer, SceneTextLayer, SceneShapeLayer, SceneImageLayer, BrandTokens } from '@instagram-agent/shared'
import { offBrandColors, type SceneDoc } from '@instagram-agent/shared'

export function Inspector({
  layer,
  doc,
  tokens,
  onUpdate,
}: {
  layer: SceneLayer | null
  doc: SceneDoc
  tokens: BrandTokens
  onUpdate: (id: string, patch: Partial<SceneLayer>) => void
}) {
  const offBrand = layer
    ? offBrandColors(
        {
          ...doc,
          pages: doc.pages.map((p) => ({
            ...p,
            layers: p.layers.filter((l) => l.id === layer.id),
          })),
        },
        tokens,
      )
    : []

  if (!layer) {
    return (
      <div className="p-4" data-testid="inspector-empty">
        <p className="text-xs text-[var(--muted)]">Select a layer to inspect it.</p>
      </div>
    )
  }

  function row(label: string, el: React.ReactNode) {
    return (
      <div key={label} className="flex items-center gap-2 py-1.5 border-b border-[var(--rule)]">
        <span className="w-16 shrink-0 text-xs text-[var(--muted)]">{label}</span>
        {el}
      </div>
    )
  }

  const numInput = (val: number | undefined, onChange: (v: number) => void, step = 1) => (
    <input
      type="number"
      step={step}
      value={val ?? 0}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full h-7 px-2 text-xs border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
    />
  )

  const colorTokens = Object.keys(tokens.colors)

  return (
    <div className="p-3 text-xs overflow-y-auto" data-testid="inspector">
      <p className="font-semibold text-[var(--text)] mb-2 capitalize">{layer.type} layer</p>
      {offBrand.length > 0 && (
        <div className="mb-2 px-2 py-1.5 rounded-[var(--radius-control)] bg-[var(--warning-track,rgba(234,179,8,0.15))] text-[var(--warning,#a16207)] text-[11px]" data-testid="off-brand-warning">
          Off-brand color — prefer token: refs from the brand kit.
        </div>
      )}
      {row('X', numInput(layer.x, (v) => onUpdate(layer.id, { x: v })))}
      {row('Y', numInput(layer.y, (v) => onUpdate(layer.id, { y: v })))}
      {row('W', numInput(layer.w, (v) => onUpdate(layer.id, { w: v })))}
      {row('H', numInput(layer.h, (v) => onUpdate(layer.id, { h: v })))}
      {row('Opacity', numInput((layer.opacity ?? 1) * 100, (v) => onUpdate(layer.id, { opacity: v / 100 }), 5))}
      {layer.type === 'text' && (
        <>
          {row('Text', (
            <input
              data-testid="inspector-text"
              value={(layer as SceneTextLayer).text}
              onChange={(e) => onUpdate(layer.id, { text: e.target.value } as Partial<SceneTextLayer>)}
              className="w-full h-7 px-2 text-xs border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
            />
          ))}
          {row('Size', numInput((layer as SceneTextLayer).fontSize, (v) => onUpdate(layer.id, { fontSize: v } as Partial<SceneTextLayer>)))}
          {row('Color', (
            <div className="flex gap-1 w-full">
              <input
                type="color"
                value={(layer as SceneTextLayer).color.startsWith('#') ? (layer as SceneTextLayer).color : '#ffffff'}
                onChange={(e) => onUpdate(layer.id, { color: e.target.value } as Partial<SceneTextLayer>)}
                className="h-7 w-10 border border-[var(--control)] rounded cursor-pointer"
              />
              <select
                value={(layer as SceneTextLayer).color.startsWith('token:') ? (layer as SceneTextLayer).color : ''}
                onChange={(e) => {
                  if (e.target.value) onUpdate(layer.id, { color: e.target.value } as Partial<SceneTextLayer>)
                }}
                className="flex-1 h-7 px-1 text-xs border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
              >
                <option value="">Custom</option>
                {colorTokens.map((n) => (
                  <option key={n} value={`token:${n}`}>{n}</option>
                ))}
              </select>
            </div>
          ))}
          {row('Align', (
            <select
              value={(layer as SceneTextLayer).align ?? 'center'}
              onChange={(e) => onUpdate(layer.id, { align: e.target.value as 'left' | 'center' | 'right' } as Partial<SceneTextLayer>)}
              className="w-full h-7 px-1 text-xs border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          ))}
        </>
      )}
      {layer.type === 'shape' && (
        row('Fill', (
          <input
            value={(layer as SceneShapeLayer).fill ?? ''}
            onChange={(e) => onUpdate(layer.id, { fill: e.target.value } as Partial<SceneShapeLayer>)}
            className="w-full h-7 px-2 text-xs border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
          />
        ))
      )}
      {layer.type === 'image' && (
        row('URL', (
          <input
            value={(layer as SceneImageLayer).url ?? ''}
            onChange={(e) => onUpdate(layer.id, { url: e.target.value } as Partial<SceneImageLayer>)}
            className="w-full h-7 px-2 text-xs border border-[var(--control)] rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--text)]"
          />
        ))
      )}
    </div>
  )
}
