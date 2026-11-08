import type { BrandTokens } from '@instagram-agent/shared'

export function BrandKitPanel({
  tokens,
  logoUrl,
  onApplyColor,
  onApplyFont,
  onApplyLogo,
}: {
  tokens: BrandTokens
  logoUrl?: string | null
  onApplyColor: (tokenRef: string) => void
  onApplyFont: (tokenRef: string) => void
  onApplyLogo: (url: string) => void
}) {
  const colors = Object.entries(tokens.colors)
  const fonts = Object.entries(tokens.fonts)

  return (
    <div className="p-3 space-y-4" data-testid="brand-kit-panel">
      <div>
        <p className="text-xs font-semibold text-[var(--text)] mb-2">Colors</p>
        <div className="grid grid-cols-4 gap-2">
          {colors.map(([name, hex]) => (
            <button
              key={name}
              title={`${name} · ${hex}`}
              onClick={() => onApplyColor(`token:${name}`)}
              className="flex flex-col items-center gap-1"
            >
              <span
                className="w-8 h-8 rounded-[var(--radius-control)] border border-[var(--border)]"
                style={{ background: hex }}
              />
              <span className="text-[10px] text-[var(--muted)] truncate w-full text-center">{name}</span>
            </button>
          ))}
          {colors.length === 0 && (
            <p className="col-span-4 text-xs text-[var(--muted)]">No brand colors yet.</p>
          )}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-[var(--text)] mb-2">Fonts</p>
        <div className="space-y-1">
          {fonts.map(([name, family]) => (
            <button
              key={name}
              onClick={() => onApplyFont(`token:${name}`)}
              className="w-full text-left px-2 py-1.5 rounded-[var(--radius-control)] border border-[var(--border)] text-xs hover:bg-[var(--raised)]"
              style={{ fontFamily: family }}
            >
              {name}
            </button>
          ))}
          {fonts.length === 0 && (
            <p className="text-xs text-[var(--muted)]">No brand fonts yet.</p>
          )}
        </div>
      </div>

      {logoUrl && (
        <div>
          <p className="text-xs font-semibold text-[var(--text)] mb-2">Logo</p>
          <button
            onClick={() => onApplyLogo(logoUrl)}
            className="w-full border border-[var(--border)] rounded-[var(--radius-control)] p-2 hover:bg-[var(--raised)]"
          >
            <img src={logoUrl} alt="Brand logo" className="max-h-16 mx-auto object-contain" />
          </button>
        </div>
      )}
    </div>
  )
}
