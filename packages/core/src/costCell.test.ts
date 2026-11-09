import { describe, expect, test } from 'bun:test'
import { costCellText, costState } from './costCell'

const f = (n: number) => `$${n.toFixed(2)}`
describe('costCell', () => {
  test('states', () => {
    expect(costState(0, 100)).toBe('priced')
    expect(costState(40, 100)).toBe('partial')
    expect(costState(100, 100)).toBe('unknown')
  })
  test('text', () => {
    expect(costCellText(0, 100, 100, 'en', f)).toBe('not recorded')
    expect(costCellText(0, 100, 100, 'pt', f)).toBe('não registrado')
    expect(costCellText(1.5, 40, 100, 'en', f)).toBe('$1.50 + unpriced usage')
    expect(costCellText(1.5, 0, 100, 'en', f)).toBe('$1.50')
  })
})
