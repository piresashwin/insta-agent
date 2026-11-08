import type { BrandTokens, VisualIdentity } from '@instagram-agent/shared'

export function tokensFromIdentity(vi: VisualIdentity | null | undefined): BrandTokens {
  return {
    colors: {
      primary: vi?.palette?.primary ?? '#b8336a',
      secondary: vi?.palette?.secondary ?? '#4a4a4a',
      accent: vi?.palette?.accent ?? '#e8a838',
      background: vi?.palette?.background ?? '#1a1a2e',
    },
    fonts: {
      heading: vi?.typography?.heading_font ?? 'DM Sans',
      body: vi?.typography?.body_font ?? 'DM Sans',
    },
  }
}

export function parseVisualIdentity(raw: string | null | undefined): VisualIdentity | null {
  if (!raw?.trim()) return null
  try {
    return JSON.parse(raw) as VisualIdentity
  } catch {
    return null
  }
}
