import { expect, test } from 'bun:test'
import { parseOpencodeSession } from './opencode-parse'
import { configModels, mergeModels, parseJsonc } from './opencode-models'
import { opencodeModelSources } from './opencode'

const jsonc = `{
  // the owner's local route
  "provider": {
    "ollama": { "npm": "@ai-sdk/openai-compatible", /* inline */ "models": {
      "qwen-coder": { "name": "Qwen // not a comment", "limit": { "context": 32768, "output": 4096 }, },
      "no-limit": { "name": "x" }
    } }
  },
  "model": "ollama/qwen-coder",
}`

test('parseJsonc reads comments, trailing commas and keeps // inside strings', () => {
  const v = parseJsonc(jsonc) as { provider: { ollama: { models: Record<string, { name: string }> } } }
  expect(v.provider.ollama.models['qwen-coder']!.name).toBe('Qwen // not a comment')
})

test('configModels keeps only routes that state a positive window; config outranks the catalog', () => {
  const cfg = configModels(parseJsonc(jsonc))
  expect(cfg.ollama?.models?.['qwen-coder']?.limit?.context).toBe(32768)
  expect(cfg.ollama?.models?.['no-limit']).toBeUndefined()
  expect(configModels(null)).toEqual({}); expect(configModels({ provider: { x: 1 } })).toEqual({})
  const merged = mergeModels({ ollama: { models: { 'qwen-coder': { limit: { context: 1 } }, other: { limit: { context: 9 } } } } }, cfg)
  expect(merged.ollama?.models?.['qwen-coder']?.limit?.context).toBe(32768)
  expect(merged.ollama?.models?.other?.limit?.context).toBe(9)
})

test('a local OpenCode route gets its window from the user config end to end', () => {
  const at = Date.parse('2026-11-06T12:00:00Z')
  const row = { id: 'ses_local', directory: '/w', title: 't', time_created: at, time_updated: at + 5000 }
  const m = (id: string, data: object, o: number) => ({ id, session_id: row.id, time_created: at + o, time_updated: at + o + 10, data: JSON.stringify(data) })
  const messages = [
    m('u', { role: 'user' }, 0),
    m('a', { role: 'assistant', finish: 'stop', modelID: 'qwen-coder', providerID: 'ollama', tokens: { input: 16000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }, 100),
  ]
  const s = parseOpencodeSession(row, messages, [], mergeModels({}, configModels(parseJsonc(jsonc))))!
  expect(s.model).toBe('ollama/qwen-coder')
  expect(s.context_tokens).toBe(16000); expect(s.context_window).toBe(32768)
})

test('model sources honour XDG, the platform cache on macOS, and OPENCODE_CONFIG', () => {
  const s = opencodeModelSources({ XDG_CACHE_HOME: '/x/c', XDG_CONFIG_HOME: '/x/cfg', OPENCODE_CONFIG: '/y/o.json' }, '/home/u')
  expect(s.cache[0]).toBe('/x/c/opencode/models.json'); expect(s.cache).toContain('/home/u/Library/Caches/opencode/models.json')
  expect(s.config).toEqual(['/x/cfg/opencode/opencode.json', '/x/cfg/opencode/opencode.jsonc', '/y/o.json'])
})
