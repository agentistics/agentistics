import { describe, expect, it } from 'bun:test'
import { tokenLabel } from '@agentistics/core'
import { modelTableLabels } from './modelTableLabels'

describe('modelTableLabels', () => {
  it('speaks Portuguese in the pt UI — no English heading left', () => {
    const L = modelTableLabels('pt')
    expect([L.model.short, L.input.short, L.output.short, L.cacheRead.short, L.cacheWrite.short, L.cost.short])
      .toEqual(['Modelo', 'Entrada', 'Saída', 'L.Cache', 'E.Cache', 'Custo'])
    expect(L.estimatedTotal).toBe('Total estimado')
  })
  it('keeps the English headings in the en UI', () => {
    const L = modelTableLabels('en')
    expect([L.model.short, L.input.short, L.output.short, L.cacheRead.short, L.cacheWrite.short, L.cost.short])
      .toEqual(['Model', 'Input', 'Output', 'C.Read', 'C.Write', 'Cost'])
    expect(L.estimatedTotal).toBe('Estimated Total')
  })
  it('names each token column in full with the shared token term', () => {
    for (const lang of ['pt', 'en'] as const) {
      const L = modelTableLabels(lang)
      expect(L.cacheRead.full).toBe(tokenLabel('cacheRead', lang))
      expect(L.cacheWrite.full).toBe(tokenLabel('cacheWrite', lang))
      expect(L.input.full).toBe(tokenLabel('input', lang))
    }
  })
})
