/**
 * Token resolution and pure text-fit helpers shared by renderer + editor.
 */

import type { BrandTokens } from './schema'

/** Resolve a token ref like "token:primary" → hex/font, or return the value unchanged. */
export function resolveToken(value: string, tokens: BrandTokens): string {
  if (!value.startsWith('token:')) return value
  const name = value.slice(6)
  return tokens.colors[name] ?? tokens.fonts[name] ?? value
}

/** Resolve a color token (same rules as resolveToken; named for call-site clarity). */
export function resolveColor(value: string, tokens: BrandTokens): string {
  return resolveToken(value, tokens)
}

export type FitTextMeasure = (text: string, fontSize: number) => number

export type FitTextInput = {
  text: string
  maxWidth: number
  maxHeight: number
  fontSize: number
  lineHeight?: number
  measure: FitTextMeasure
}

export type FitTextResult = {
  lines: string[]
  fontSize: number
}

const MIN_FONT_SIZE = 8

/** Word-wrap `text` into lines that fit maxWidth; shrink fontSize until lines fit maxHeight. */
export function fitText(input: FitTextInput): FitTextResult {
  const { text, maxWidth, maxHeight, measure } = input
  const lineHeight = input.lineHeight ?? 1.25
  let fontSize = Math.max(MIN_FONT_SIZE, input.fontSize)

  const wrap = (size: number): string[] => {
    const words = text.split(' ')
    const lines: string[] = []
    let current = ''

    for (const word of words) {
      const test = current ? `${current} ${word}` : word
      if (measure(test, size) > maxWidth && current) {
        lines.push(current)
        current = word
      } else {
        current = test
      }
    }
    if (current) lines.push(current)
    return lines.length ? lines : ['']
  }

  let lines = wrap(fontSize)
  while (fontSize > MIN_FONT_SIZE) {
    const needed = lines.length * fontSize * lineHeight
    if (needed <= maxHeight) break
    fontSize -= 1
    lines = wrap(fontSize)
  }

  return { lines, fontSize }
}
