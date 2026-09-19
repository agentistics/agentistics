import { describe, test, expect } from 'bun:test'
import { costEstimateNote } from './costEstimateNote'

describe('costEstimateNote', () => {
  test('nothing estimated -> null, never a zero-day sentence', () => {
    expect(costEstimateNote(0, 'en')).toBeNull()
    expect(costEstimateNote(0, 'pt')).toBeNull()
  })

  test('a negative count (should never happen) is treated the same as zero', () => {
    expect(costEstimateNote(-1, 'en')).toBeNull()
  })

  test('singular day, EN', () => {
    expect(costEstimateNote(1, 'en')).toBe('1 day estimated (no exact session)')
  })

  test('singular day, PT', () => {
    expect(costEstimateNote(1, 'pt')).toBe('1 dia estimado (sessão exata indisponível)')
  })

  test('plural days, EN', () => {
    expect(costEstimateNote(3, 'en')).toBe('3 days estimated (no exact session)')
  })

  test('plural days, PT', () => {
    expect(costEstimateNote(3, 'pt')).toBe('3 dias estimados (sessão exata indisponível)')
  })
})
