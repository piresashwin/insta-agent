import { describe, it, expect } from 'vitest'
import { isNearDuplicate, jaccard, trigrams } from '../generation/similarity'

describe('similarity', () => {
  it('identical strings are near-duplicates', () => {
    expect(isNearDuplicate('hello world', 'hello world')).toBe(true)
  })

  it('near-rewrites exceed 0.6', () => {
    expect(isNearDuplicate('5 morning habits for calm', 'Five morning habits for calm')).toBe(
      true,
    )
  })

  it('unrelated strings are not duplicates', () => {
    expect(isNearDuplicate('espresso dialing tips', 'weekend hiking packing list')).toBe(false)
  })

  it('empty strings are not duplicates', () => {
    expect(jaccard(trigrams(''), trigrams(''))).toBe(0)
    expect(isNearDuplicate('', '')).toBe(false)
  })
})
