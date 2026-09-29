import { describe, expect, it } from 'bun:test'
import { modelsFor } from '@agentistics/core'
import { webHarnesses } from './spawn-web'

const host = {
  async startableHarnesses() {
    return [{
      id: 'claude', label: 'Claude Code',
      modelSuggestions: ['fable', 'opus', 'sonnet', 'haiku'],
      supportsModel: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }]
  },
} as never

/** The fallback table, as the catalog answers where the CLI publishes no list. */
const tableCatalog = async (h: string) => ({ models: modelsFor(h), source: 'table' as const, freeText: true })

describe('webHarnesses', () => {
  it('carries the labelled models beside the ids, so the picker can print a name', async () => {
    const [claude] = await webHarnesses(host, tableCatalog)
    expect(claude!.models.map(m => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(claude!.models.find(m => m.id === 'opus')!.label).toBe('Opus 5')
    expect(claude!.modelFreeText).toBe(true)
  })

  it('keeps modelSuggestions, so an older client is unaffected', async () => {
    const [claude] = await webHarnesses(host, tableCatalog)
    expect(claude!.modelSuggestions).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })

  it('offers the CLI\'s own list when it publishes one — the ids it sends and the names it reads', async () => {
    const cli = async () => ({
      models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', verifiedAt: '2026-09-29', source: 'test' }],
      source: 'cli' as const, freeText: false,
    })
    const [claude] = await webHarnesses(host, cli)
    expect(claude!.modelSuggestions).toEqual(['claude-opus-5-5'])
    expect(claude!.models.map(m => m.label)).toEqual(['Opus 5.5'])
    expect(claude!.modelsSource).toBe('cli')
    expect(claude!.modelFreeText).toBe(false)
  })
})
