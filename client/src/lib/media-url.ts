/** Prefer same-origin /assets path so Vite proxy avoids CORS-tainted media. */
export function bakeSourceUrl(src: string): string {
  try {
    const u = new URL(src, window.location.origin)
    if (u.pathname.startsWith('/assets/')) {
      return `${u.pathname}${u.search}`
    }
    if (u.pathname.includes('/assets/')) {
      const idx = u.pathname.indexOf('/assets/')
      return `${u.pathname.slice(idx)}${u.search}`
    }
  } catch {
    /* keep src */
  }
  return src
}
