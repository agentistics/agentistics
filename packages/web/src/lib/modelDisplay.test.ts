import { describe, expect, test } from 'bun:test'
import { bandModel, modelDisplay } from './modelDisplay'

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

describe('bandModel', () => {
  test('a model the protocol states NOW beats the transcript (a switch from the menu shows at once)', () => {
    expect(bandModel('opencode', 'ollama/qwen2.5:0.5b', 'opencode/big-pickle', 'ollama/qwen2.5:0.5b')).toBe('ollama/qwen2.5:0.5b')
  })
  test('without a stated model the transcript still beats the spawn alias', () => {
    expect(bandModel('claude', undefined, 'claude-opus-5-5', 'opus')).toBe('Opus 5.5')
    expect(bandModel('claude', null, undefined, 'opus')).toBe('opus')
  })
})
