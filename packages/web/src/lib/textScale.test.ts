import { describe, expect, test } from 'bun:test'
import { applyTextScale, clampTextScale } from './textScale'

describe('text scale', () => {
  test('clamps invalid and out-of-range values', () => {
    expect(clampTextScale(undefined)).toBe(1)
    expect(clampTextScale(Number.NaN)).toBe(1)
    expect(clampTextScale(0.2)).toBe(0.85)
    expect(clampTextScale(2)).toBe(1.5)
    expect(clampTextScale(1.125)).toBe(1.125)
  })

  test('applies the preference to the document root', () => {
    const root = { style: { zoom: '' } }
    expect(applyTextScale(root, 1.4)).toBe(1.4)
    expect(root.style.zoom).toBe('1.4')
  })
})
