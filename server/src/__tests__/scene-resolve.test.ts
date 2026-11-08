import { describe, it, expect } from 'vitest'
import { resolveToken, resolveColor, fitText, emptyTokens } from '@instagram-agent/shared'

describe('resolveToken', () => {
  const tokens = {
    colors: { primary: '#b8336a', background: '#fbf7f8' },
    fonts: { heading: '"DM Sans", sans-serif' },
  }

  it('resolves token:primary → hex', () => {
    expect(resolveToken('token:primary', tokens)).toBe('#b8336a')
  })

  it('leaves raw hex unchanged', () => {
    expect(resolveToken('#fff', tokens)).toBe('#fff')
  })

  it('returns unknown tokens verbatim', () => {
    expect(resolveToken('token:missing', tokens)).toBe('token:missing')
  })

  it('resolveColor mirrors resolveToken for colors', () => {
    expect(resolveColor('token:background', tokens)).toBe('#fbf7f8')
    expect(resolveColor('#abc', emptyTokens())).toBe('#abc')
  })
})

describe('fitText', () => {
  // Stub: each character is 10px wide at fontSize 10; scales linearly with fontSize.
  const measure = (text: string, fontSize: number) => text.length * fontSize

  it('wraps at word boundaries (never mid-word)', () => {
    const { lines, fontSize } = fitText({
      text: 'hello world friends',
      maxWidth: 60, // fits "hello" (5*10) and "world" (5*10) separately; not "hello world" (11*10)
      maxHeight: 1000,
      fontSize: 10,
      measure,
    })
    expect(fontSize).toBe(10)
    expect(lines).toEqual(['hello', 'world', 'friends'])
    for (const line of lines) {
      expect(line.includes(' ')).toBe(false)
    }
  })

  it('shrinks fontSize when text overflows maxHeight', () => {
    const { lines, fontSize } = fitText({
      text: 'alpha beta gamma delta',
      maxWidth: 100, // "alpha beta" is 10 chars → fits at size 10; three+ words wrap
      maxHeight: 25, // 2 lines at size 10 need 25; 3 lines force shrink
      fontSize: 20,
      lineHeight: 1.25,
      measure,
    })
    expect(fontSize).toBeLessThan(20)
    expect(fontSize).toBeGreaterThanOrEqual(8)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.length * fontSize * 1.25).toBeLessThanOrEqual(25)
  })

  it('is deterministic given a stub measure', () => {
    const input = {
      text: 'alpha beta gamma',
      maxWidth: 50,
      maxHeight: 200,
      fontSize: 12,
      measure,
    }
    expect(fitText(input)).toEqual(fitText(input))
  })
})
