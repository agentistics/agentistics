import { describe, expect, test } from 'bun:test'
import { applyTextScale, clampTextScale } from './textScale'
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
    expect(applyTextScale(root, 1.4)).toBe(1.4)
    expect(root.style.zoom).toBe('1.4')
    expect(root.props['--ui-zoom']).toBe('1.4')
    expect(geometryZoom()).toBe(1.4)
  })

  test('the default clears the zoom instead of writing zoom: 1', () => {
    const root = fakeRoot()
    applyTextScale(root, 1)
    expect(root.style.zoom).toBe('')
    expect(root.props['--ui-zoom']).toBe('1')
    expect(geometryZoom()).toBe(1)
  })
})
