import { describe, expect, test } from 'bun:test'
import { modelDisplay } from './modelDisplay'

describe('modelDisplay', () => {
  test('the observed model beats the spawn alias', () => {
    expect(modelDisplay('claude', 'claude-opus-5-5', 'opus')).toBe('Opus 5.5')
  })
  test('falls back to the alias when nothing was observed', () => {
    expect(modelDisplay('claude', undefined, 'opus')).toBe('opus')
  })
  test('nothing at all is undefined', () => expect(modelDisplay('claude')).toBeUndefined())
  test('an unlisted observed id is shown as is', () => expect(modelDisplay('claude', 'zzz-1')).toBe('zzz-1'))
})
