/**
 * Curated Google Fonts for canvas text layers.
 * Loaded on demand via fonts.googleapis.com so export + preview match.
 * IDs must match shared CANVAS_GOOGLE_FONTS (LLM suggestions resolve there).
 */
import { DEFAULT_CANVAS_FONT as SHARED_DEFAULT } from '@instagram-agent/shared'

export type CanvasFont = {
  /** Stable id stored on CanvasLayer.fontFamily (CSS family name). */
  id: string
  label: string
  /** Stack used in CSS / canvas. */
  css: string
  /** Google Fonts family query segment (spaces → +). */
  google: string
  /** Weights we request from Google. */
  weights: number[]
}

export const DEFAULT_CANVAS_FONT = SHARED_DEFAULT

export const CANVAS_FONTS: CanvasFont[] = [
  {
    id: 'Source Sans 3',
    label: 'Source Sans 3',
    css: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
    google: 'Source+Sans+3',
    weights: [400, 600, 700],
  },
  {
    id: 'Inter',
    label: 'Inter',
    css: '"Inter", ui-sans-serif, system-ui, sans-serif',
    google: 'Inter',
    weights: [400, 600, 700],
  },
  {
    id: 'DM Sans',
    label: 'DM Sans',
    css: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
    google: 'DM+Sans',
    weights: [400, 600, 700],
  },
  {
    id: 'Poppins',
    label: 'Poppins',
    css: '"Poppins", ui-sans-serif, system-ui, sans-serif',
    google: 'Poppins',
    weights: [400, 600, 700],
  },
  {
    id: 'Montserrat',
    label: 'Montserrat',
    css: '"Montserrat", ui-sans-serif, system-ui, sans-serif',
    google: 'Montserrat',
    weights: [400, 600, 700],
  },
  {
    id: 'Oswald',
    label: 'Oswald',
    css: '"Oswald", ui-sans-serif, system-ui, sans-serif',
    google: 'Oswald',
    weights: [400, 600, 700],
  },
  {
    id: 'Playfair Display',
    label: 'Playfair Display',
    css: '"Playfair Display", ui-serif, Georgia, serif',
    google: 'Playfair+Display',
    weights: [400, 600, 700],
  },
  {
    id: 'Lora',
    label: 'Lora',
    css: '"Lora", ui-serif, Georgia, serif',
    google: 'Lora',
    weights: [400, 600, 700],
  },
  {
    id: 'Merriweather',
    label: 'Merriweather',
    css: '"Merriweather", ui-serif, Georgia, serif',
    google: 'Merriweather',
    weights: [400, 700],
  },
  {
    id: 'Libre Baskerville',
    label: 'Libre Baskerville',
    css: '"Libre Baskerville", ui-serif, Georgia, serif',
    google: 'Libre+Baskerville',
    weights: [400, 700],
  },
  {
    id: 'Roboto Slab',
    label: 'Roboto Slab',
    css: '"Roboto Slab", ui-serif, Georgia, serif',
    google: 'Roboto+Slab',
    weights: [400, 600, 700],
  },
  {
    id: 'Bebas Neue',
    label: 'Bebas Neue',
    css: '"Bebas Neue", ui-sans-serif, system-ui, sans-serif',
    google: 'Bebas+Neue',
    weights: [400],
  },
  {
    id: 'Anton',
    label: 'Anton',
    css: '"Anton", ui-sans-serif, system-ui, sans-serif',
    google: 'Anton',
    weights: [400],
  },
  {
    id: 'Pacifico',
    label: 'Pacifico',
    css: '"Pacifico", ui-cursive, cursive',
    google: 'Pacifico',
    weights: [400],
  },
  {
    id: 'Caveat',
    label: 'Caveat',
    css: '"Caveat", ui-cursive, cursive',
    google: 'Caveat',
    weights: [400, 600, 700],
  },
]

const loadedHref = new Set<string>()

function fontById(id: string | null | undefined): CanvasFont {
  const hit = CANVAS_FONTS.find((f) => f.id === id)
  return hit || CANVAS_FONTS[0]
}

export function canvasFontCss(id: string | null | undefined): string {
  return fontById(id).css
}

export function canvasFontFamilyName(id: string | null | undefined): string {
  return fontById(id).id
}

function googleCssHref(fonts: CanvasFont[]): string {
  const families = fonts
    .map((f) => {
      const weights = [...new Set(f.weights)].sort((a, b) => a - b).join(';')
      // Variable / multi-weight request: family=Name:wght@400;600;700
      return `family=${f.google}:wght@${weights}`
    })
    .join('&')
  return `https://fonts.googleapis.com/css2?${families}&display=swap`
}

/** Inject a stylesheet link for the given font ids (idempotent). */
export function ensureGoogleFontsLoaded(fontIds?: Array<string | null | undefined>): void {
  if (typeof document === 'undefined') return
  const wanted = (fontIds?.length ? fontIds : CANVAS_FONTS.map((f) => f.id))
    .map((id) => fontById(id))
    // Deduplicate by id
    .filter((f, i, arr) => arr.findIndex((x) => x.id === f.id) === i)

  const href = googleCssHref(wanted)
  if (loadedHref.has(href)) return
  const existing = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[data-canvas-fonts="1"]')
  ).find((el) => el.href === href || el.getAttribute('href') === href)
  if (existing) {
    loadedHref.add(href)
    return
  }
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.setAttribute('data-canvas-fonts', '1')
  document.head.appendChild(link)
  loadedHref.add(href)
}

/** Wait until a font family/weight is usable for canvas measureText / fillText. */
export async function waitForCanvasFont(
  fontId: string | null | undefined,
  weight: number,
  sizePx: number
): Promise<void> {
  ensureGoogleFontsLoaded([fontId])
  const family = canvasFontFamilyName(fontId)
  if (typeof document === 'undefined' || !document.fonts?.load) return
  try {
    await document.fonts.load(`${weight} ${Math.max(12, sizePx)}px "${family}"`)
  } catch {
    /* fall through — browser may still rasterize with fallback */
  }
}
