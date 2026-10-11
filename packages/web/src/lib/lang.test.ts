import { describe, expect, test } from 'bun:test'
import { initialLang } from './lang'

describe('initialLang', () => {
  test('follows the browser language on first run', () => {
    expect(initialLang({ getItem: () => null }, 'pt-BR')).toBe('pt')
    expect(initialLang({ getItem: () => null }, 'en-US')).toBe('en')
  })
  test('keeps an explicit browser choice', () => {
    expect(initialLang({ getItem: () => 'en' }, 'pt-BR')).toBe('en')
    expect(initialLang({ getItem: () => 'pt' }, 'en-US')).toBe('pt')
  })
})
