import { resolveToken, type SceneDoc } from '@instagram-agent/shared'

/** Profile-grid style preview of the current scene page. */
export function FeedView({ doc, pageIndex }: { doc: SceneDoc; pageIndex: number }) {
  const page = doc.pages[pageIndex]
  if (!page) return null

  const bg =
    page.background.kind === 'color'
      ? resolveToken(page.background.color, doc.tokens)
      : '#1a1a2e'

  const tiles = Array.from({ length: 9 }, (_, i) => i)

  return (
    <div className="p-3" data-testid="feed-view">
      <p className="text-xs font-semibold text-[var(--text)] mb-2">Feed preview</p>
      <div className="grid grid-cols-3 gap-0.5 rounded-[var(--radius-control)] overflow-hidden border border-[var(--border)]">
        {tiles.map((i) => (
          <div
            key={i}
            className="aspect-square"
            style={{
              background: i === 4 ? bg : 'var(--raised)',
              backgroundImage:
                i === 4 && page.background.kind === 'image'
                  ? `url(${page.background.assetId})`
                  : undefined,
              backgroundSize: 'cover',
            }}
          >
            {i === 4 &&
              page.layers
                .filter((l) => l.type === 'text')
                .slice(0, 1)
                .map((l) =>
                  l.type === 'text' ? (
                    <p
                      key={l.id}
                      className="text-[7px] text-white p-1 leading-tight line-clamp-3"
                      style={{ color: resolveToken(l.color, doc.tokens) }}
                    >
                      {l.text}
                    </p>
                  ) : null,
                )}
          </div>
        ))}
      </div>
    </div>
  )
}
