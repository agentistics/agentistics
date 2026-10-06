import { describe, expect, it } from 'bun:test'
import { durationChipLabel, typeChipLabel } from './taskChipParts'

describe('task header chip parts', () => {
  it('keeps wall-clock and active duration on one line', () => {
    expect(durationChipLabel(
      '2026-09-26T16:25:00Z', '2026-09-29T18:25:00Z', 40, 'pt',
    )).toBe('3d 2h · ativo 40min')
  })

  it('names an empty type without pretending it has a value', () => {
    expect(typeChipLabel(undefined, [], 'Tipo', '—')).toBe('Tipo —')
  })

  it('includes the live type label', () => {
    expect(typeChipLabel('core', [{ id: 'core', label: 'CORE', color: '#d97706', order: 0 }], 'Type', '—'))
      .toBe('Type CORE')
  })
})
