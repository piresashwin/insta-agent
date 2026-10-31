import type { BackgroundStyle } from '@instagram-agent/shared'

/** Mirrors shared BACKGROUND_STYLES — kept local so Vite can import ESM values. */
export const BACKGROUND_STYLES: Array<{
  id: BackgroundStyle
  label: string
  keywords: string
}> = [
  { id: 'flat_lay', label: 'Flat lay', keywords: 'flat lay overhead tabletop' },
  { id: 'lifestyle', label: 'Lifestyle', keywords: 'lifestyle candid natural light' },
  { id: 'outdoor_nature', label: 'Outdoor / nature', keywords: 'outdoor nature landscape greenery' },
  { id: 'cozy_indoor', label: 'Cozy indoor', keywords: 'cozy indoor warm home' },
  { id: 'studio_minimal', label: 'Studio minimal', keywords: 'studio minimal clean background' },
  { id: 'urban', label: 'Urban', keywords: 'urban city street architecture' },
  { id: 'workspace', label: 'Workspace', keywords: 'desk workspace laptop coffee' },
  { id: 'abstract_texture', label: 'Abstract texture', keywords: 'abstract texture pattern soft' },
]
