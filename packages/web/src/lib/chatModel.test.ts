import { describe, expect, test } from 'bun:test'
import { chatModelLabel, resolveChatModel, typedModelId } from './chatModel'

const claude = { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }], defaultModel: '' }
const copilot = { models: [{ id: 'auto', label: 'Auto' }], modelFreeText: true, defaultModel: '' }

describe('resolveChatModel', () => {
  test('a listed choice is kept', () => {
    expect(resolveChatModel('claude-sonnet-5-5', claude)).toBe('claude-sonnet-5-5')
  })
  test('a choice from another harness falls back to this one\'s default, then its first model', () => {
    expect(resolveChatModel('gpt-5.5', claude)).toBe('claude-opus-5-5')
    expect(resolveChatModel('gpt-5.5', { ...claude, defaultModel: 'opus[1m]' })).toBe('opus[1m]')
  })
  test('under a free-text list an unlisted choice is kept', () => {
    expect(resolveChatModel('gpt-4.1', copilot)).toBe('gpt-4.1')
  })
  test('a harness naming nothing yields the CLI default', () => {
    expect(resolveChatModel(null, { models: [], modelFreeText: true, defaultModel: '' })).toBe('')
  })
})

describe('chatModelLabel', () => {
  test('the harness label, else the id, and the empty id says default', () => {
    expect(chatModelLabel('claude-opus-5-5', [claude], 'en')).toBe('Opus 5.5')
    expect(chatModelLabel('gpt-9', [claude], 'en')).toBe('gpt-9')
    expect(chatModelLabel('', [claude], 'pt')).toBe('padrão do assistente')
  })
})

describe('typedModelId', () => {
  test('trims, and refuses spaces and flag-shaped values', () => {
    expect(typedModelId('  gpt-4.1 ')).toBe('gpt-4.1')
    expect(typedModelId('--yolo')).toBeNull()
    expect(typedModelId('gpt 4')).toBeNull()
    expect(typedModelId('')).toBeNull()
  })
})
