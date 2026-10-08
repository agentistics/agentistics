import { describe, expect, test } from 'bun:test'
import { defaultColumnWidth, defaultWidths, estimateHeaderWidth, sampleFor } from './columnDefaultWidth'
import { resolveWidths } from './columnWidths'

describe('defaultColumnWidth', () => {
  test('keeps the configured width when it already fits', () => {
    expect(defaultColumnWidth({ base: 300, label: 'ID' })).toBe(300)
  })
  test('grows to fit a long header with grip and sort arrow', () => {
    const w = defaultColumnWidth({ base: 80, label: 'DURAÇÃO', sortable: true, grip: true })
    expect(w).toBeGreaterThanOrEqual(estimateHeaderWidth('DURAÇÃO', { sortable: true, grip: true }))
    expect(w).toBeGreaterThan(80)
  })
  test('grows to fit a typical cell', () => {
    const w = defaultColumnWidth({ base: 80, label: 'X', samples: sampleFor('duration', 'pt') })
    expect(w).toBeGreaterThanOrEqual('ativo 12h 30min'.length * 7)
  })
})

describe('defaultWidths + resolveWidths', () => {
  const cols = [{ id: 'duration', width: 80 }, { id: 'cost', width: 88 }]
  const defaults = defaultWidths(cols, id => (id === 'duration' ? 'DURAÇÃO' : 'CUSTO'), 'pt')
  test('a never-resized column takes the computed default', () => {
    const out = resolveWidths(cols, {}, defaults)
    expect(out.duration).toBe(defaults.duration!)
    expect(out.duration!).toBeGreaterThan(80)
  })
  test('a saved width always wins', () => {
    expect(resolveWidths(cols, { duration: 100 }, defaults).duration).toBe(100)
  })
  test('without defaults the configured width is used', () => {
    expect(resolveWidths(cols, {}).duration).toBe(80)
  })
})
