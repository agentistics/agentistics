import { describe, expect, test } from 'bun:test'
import {
  parseAgyModels,
  parseClaudeModelCatalog,
  parseCodexModelsCache,
  parseKimiModelAliases,
  parseOpencodeModels,
  isSafeModelId,
  resolveChatModel,
} from './model-catalog-parse'
import { catalogFields } from './model-catalog-fields'

const SRC = { verifiedAt: '2026-09-29', source: 'test' }

function claudeFile(fetchedAt: number, models: { id: string; name: string; section: string }[]) {
  return JSON.stringify({ version: 2, fetchedAt, staleAt: fetchedAt + 1, catalog: { surface: 'cc', config: { id: 'cc', models }, state: {} } })
}

describe('parseClaudeModelCatalog', () => {
  test('the newest fetchedAt wins, and main is listed before overflow', () => {
    const older = claudeFile(100, [{ id: 'claude-opus-4-7', name: 'Opus 4.7', section: 'main' }])
    const newer = claudeFile(200, [
      { id: 'claude-opus-5', name: 'Opus 5', section: 'overflow' },
      { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main' },
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main' },
    ])
    expect(parseClaudeModelCatalog([older, newer], SRC)?.map(m => [m.id, m.label])).toEqual([
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-opus-5', 'Opus 5'],
    ])
  })

  test('junk, an unexpected shape and an empty list are NO answer, never a throw', () => {
    expect(parseClaudeModelCatalog(['{nope'], SRC)).toBeNull()
    expect(parseClaudeModelCatalog([JSON.stringify({ catalog: { config: {} } })], SRC)).toBeNull()
    expect(parseClaudeModelCatalog([claudeFile(1, [])], SRC)).toBeNull()
    expect(parseClaudeModelCatalog([], SRC)).toBeNull()
  })

  test('a corrupt newer file does not hide a good older one', () => {
    const good = claudeFile(100, [{ id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main' }])
    expect(parseClaudeModelCatalog([good, '{broken'], SRC)?.map(m => m.id)).toEqual(['claude-opus-5-5'])
  })

  test('a row without an id is skipped; a row without a name shows its id', () => {
    const f = claudeFile(1, [
      { id: '', name: 'X', section: 'main' },
      { id: 'claude-x', name: '', section: 'main' },
    ])
    expect(parseClaudeModelCatalog([f], SRC)?.map(m => [m.id, m.label])).toEqual([['claude-x', 'claude-x']])
  })
})

describe('parseCodexModelsCache', () => {
  test('only listed models are offered, with their display names', () => {
    const text = JSON.stringify({ models: [
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list' },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
    ] })
    expect(parseCodexModelsCache(text, SRC)?.map(m => [m.id, m.label])).toEqual([
      ['gpt-5.6-terra', 'GPT-5.6-Terra'],
      ['gpt-5.5', 'GPT-5.5'],
    ])
  })

  test('junk is no answer', () => {
    expect(parseCodexModelsCache('nope', SRC)).toBeNull()
    expect(parseCodexModelsCache(JSON.stringify({ models: [] }), SRC)).toBeNull()
  })
})

describe('parseAgyModels', () => {
  test('reads id<TAB>name lines and skips the banner', () => {
    const out = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n'
    expect(parseAgyModels(out, SRC)?.map(m => [m.id, m.label])).toEqual([
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
      ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
    ])
  })

  test('an error or empty output is no answer', () => {
    expect(parseAgyModels('Fetching available models...\n', SRC)).toBeNull()
    expect(parseAgyModels('', SRC)).toBeNull()
  })
})

describe('parseOpencodeModels', () => {
  test('one provider/model id per line; the label is the id', () => {
    expect(parseOpencodeModels('opencode/big-pickle\nollama/qwen-coder\n\n', SRC)?.map(m => [m.id, m.label])).toEqual([
      ['opencode/big-pickle', 'opencode/big-pickle'],
      ['ollama/qwen-coder', 'ollama/qwen-coder'],
    ])
  })

  test('a line that is not an id (an error sentence) makes it no answer', () => {
    expect(parseOpencodeModels('Error: something went wrong\n', SRC)).toBeNull()
  })
})

describe('parseKimiModelAliases', () => {
  test('the [models."alias"] headers, in file order', () => {
    const toml = [
      'default_model = "ollama-local/qwen2.5-3b-instruct"',
      '[providers.ollama-local]',
      'base_url = "http://localhost:11434/v1"',
      '[models."ollama-local/qwen2.5-3b-instruct"]',
      'provider = "ollama-local"',
      "[models.'single/quoted']",
      '[models.bare-alias]',
    ].join('\n')
    expect(parseKimiModelAliases(toml, SRC)?.map(m => m.id)).toEqual([
      'ollama-local/qwen2.5-3b-instruct', 'single/quoted', 'bare-alias',
    ])
  })

  test('no models table is no answer', () => {
    expect(parseKimiModelAliases('default_model = "x"\n', SRC)).toBeNull()
  })
})

describe('isSafeModelId / resolveChatModel', () => {
  test('flag-shaped, spaced and empty values are refused', () => {
    expect(isSafeModelId('claude-opus-5-5')).toBe(true)
    expect(isSafeModelId('opencode/big-pickle')).toBe(true)
    expect(isSafeModelId('opus[1m]')).toBe(true)
    expect(isSafeModelId('--dangerously-skip-permissions')).toBe(false)
    expect(isSafeModelId('gpt 5')).toBe(false)
    expect(isSafeModelId('')).toBe(false)
  })

  const cli = { models: [{ id: 'claude-opus-5-5' }], freeText: false }
  const table = { models: [{ id: 'auto' }], freeText: true }

  test('a listed id is taken as asked', () => {
    expect(resolveChatModel('claude-opus-5-5', cli, '')).toBe('claude-opus-5-5')
  })

  test('an unlisted id is taken only under a free-text (table) list, and only when safe', () => {
    expect(resolveChatModel('gpt-9', cli, '')).toBe('')
    expect(resolveChatModel('gpt-9', table, 'auto')).toBe('gpt-9')
    expect(resolveChatModel('--yolo', table, 'auto')).toBe('auto')
  })

  test('nothing asked falls back; an unsafe fallback becomes the CLI default', () => {
    expect(resolveChatModel(undefined, cli, 'claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(resolveChatModel(undefined, cli, '-x')).toBe('')
  })
})

describe('catalogFields', () => {
  const opt = (id: string) => ({ id, label: id.toUpperCase(), verifiedAt: '2026-09-29', source: 'test' })

  test('a CLI list drives both what is sent and what is read, and is closed', () => {
    expect(catalogFields(['opus'], { models: [opt('claude-opus-5-5')], source: 'cli', freeText: false })).toEqual({
      modelSuggestions: ['claude-opus-5-5'], models: [opt('claude-opus-5-5')], modelsSource: 'cli', modelFreeText: false,
    })
  })

  test('the table keeps the spawn spec ids and opens free text', () => {
    expect(catalogFields(['auto'], { models: [opt('auto')], source: 'table', freeText: true })).toEqual({
      modelSuggestions: ['auto'], models: [opt('auto')], modelsSource: 'table', modelFreeText: true,
    })
  })

  test('no catalog at all is the table with nothing named', () => {
    expect(catalogFields([], undefined)).toEqual({ modelSuggestions: [], models: [], modelsSource: 'table', modelFreeText: true })
  })
})
