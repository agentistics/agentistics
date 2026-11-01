import { test, expect } from 'bun:test'
import { getEnabledAdapters } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { geminiAdapter } from './gemini'
import { copilotAdapter } from './copilot'
import { antigravityAdapter } from './antigravity'
import { kimiAdapter } from './kimi'
import { opencodeAdapter } from './opencode'

const KNOWN_HARNESS_IDS = new Set(['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode'])

test('registry returns only known harness ids, always includes claude', async () => {
  const adapters = await getEnabledAdapters()
  const ids = adapters.map(a => a.id)

  // claude is always present (no directory requirement)
  expect(ids).toContain('claude')

  // no unexpected ids may appear
  for (const id of ids) {
    expect(KNOWN_HARNESS_IDS.has(id)).toBe(true)
  }
})

test('each adapter appears in getEnabledAdapters iff its isAvailable() returns true', async () => {
  const adapters = await getEnabledAdapters()
  const ids = adapters.map(a => a.id)

  for (const adapter of [claudeAdapter, codexAdapter, geminiAdapter, copilotAdapter, antigravityAdapter, kimiAdapter, opencodeAdapter]) {
    if (adapter.isAvailable()) {
      expect(ids).toContain(adapter.id)
    } else {
      expect(ids).not.toContain(adapter.id)
    }
  }
})

test('OpenCode is registered even when the test home has no OpenCode store', async () => {
  const available = opencodeAdapter.isAvailable
  try {
    opencodeAdapter.isAvailable = () => true
    expect((await getEnabledAdapters()).map(a => a.id)).toContain('opencode')
  } finally { opencodeAdapter.isAvailable = available }
})
