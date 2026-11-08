/** Trigram near-duplicate helpers (shared by evals + idea generation). */

/** 3-char shingles of a normalized string. */
export function trigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim()
  const out = new Set<string>()
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return inter / (a.size + b.size - inter)
}

export function isNearDuplicate(a: string, b: string, threshold = 0.6): boolean {
  return jaccard(trigrams(a), trigrams(b)) > threshold
}
