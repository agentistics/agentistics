import { describe, expect, test } from 'bun:test'
import { modeLabel, modeTitle, onlyModeNote } from './modeLabel'

const agy = { id: 'skip-permissions', label: 'skip permissions', canonical: 'no-questions' as const }

describe('modeLabel', () => {
  test('a canonical mode is shown in the product words, translated', () => {
    expect(modeLabel(agy, 'pt')).toBe('Sem perguntas')
    expect(modeLabel(agy, 'en')).toBe('No questions')
  })
  test('a mode with no canonical meaning keeps the harness word', () => {
    expect(modeLabel({ label: 'auto mode' }, 'pt')).toBe('auto mode')
  })
  test('the tooltip keeps the harness word', () => {
    expect(modeTitle(agy, 'pt')).toContain('skip permissions')
  })
  test('a lone no-questions option explains itself; others do not', () => {
    expect(onlyModeNote([agy], 'pt')).toContain('único modo')
    expect(onlyModeNote([agy, { canonical: 'plan' }], 'pt')).toBeNull()
    expect(onlyModeNote([{ canonical: 'plan' }], 'en')).toBeNull()
  })
})
