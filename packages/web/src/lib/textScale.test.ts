import { describe, expect, test } from 'bun:test'
import { applyTextScale, clampTextScale, effectiveTextScale } from './textScale'
import { geometryZoom } from './zoomGeometry'

function fakeRoot() {
  const props: Record<string, string> = {}
  return { props, style: { zoom: '', setProperty(name: string, value: string) { props[name] = value } } }
}

describe('text scale', () => {
  test('clamps invalid and out-of-range values', () => {
    expect(clampTextScale(undefined)).toBe(1)
    expect(clampTextScale(Number.NaN)).toBe(1)
    expect(clampTextScale(0.2)).toBe(0.85)
    expect(clampTextScale(2)).toBe(1.5)
    expect(clampTextScale(1.125)).toBe(1.125)
  })

  test('zooms the document root and publishes the factor for viewport units', () => {
    const root = fakeRoot()
    expect(applyTextScale(root, 1.4, 1280)).toBe(1.4)
    expect(root.style.zoom).toBe('1.4')
    expect(root.props['--ui-zoom']).toBe('1.4')
    expect(geometryZoom()).toBe(1.4)
  })

  test('the default clears the zoom instead of writing zoom: 1', () => {
    const root = fakeRoot()
    applyTextScale(root, 1, 1280)
    expect(root.style.zoom).toBe('')
    expect(root.props['--ui-zoom']).toBe('1')
    expect(geometryZoom()).toBe(1)
  })
})

describe('narrow-screen ceiling', () => {
  test('a phone never zooms the layout below 320 CSS px', () => {
    expect(effectiveTextScale(1.5, 390)).toBe(1.21)
    expect(effectiveTextScale(1.25, 390)).toBe(1.21)
    expect(effectiveTextScale(1.12, 390)).toBe(1.12)
  })
  test('a wide screen and sizes below the default are never limited', () => {
    expect(effectiveTextScale(1.5, 1280)).toBe(1.5)
    expect(effectiveTextScale(0.85, 320)).toBe(0.85)
    expect(effectiveTextScale(1.5, 300)).toBe(1)
  })
  test('applying keeps the CHOSEN size and zooms by the shown one', () => {
    const root = fakeRoot()
    expect(applyTextScale(root, 1.5, 390)).toBe(1.5)
    expect(root.style.zoom).toBe('1.21')
  })
})
