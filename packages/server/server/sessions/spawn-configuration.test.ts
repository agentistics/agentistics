import { describe, expect, test } from 'bun:test'
import { applySpawnConfiguration, configurationPendingMessage } from './spawn-configuration'

describe('ORQ.FORA configuration outcome', () => {
  test('retries only failed filing/folder/pin steps, without duplicating applied steps', async () => {
    let filing = 0, folder = 0, preferences = 0
    const result = await applySpawnConfiguration([
      { item: 'filing', apply: async () => { filing++ } },
      { item: 'folder', apply: async () => ++folder > 1 },
      { item: 'handoff-preferences', apply: async () => { if (++preferences === 1) throw new Error('locked') } },
    ])
    expect(result).toEqual({ ready: true, applied: ['filing', 'folder', 'handoff-preferences'], pending: [] })
    expect([filing, folder, preferences]).toEqual([1, 2, 2])
  })
  test('persistent failures report applied and pending, retaining the existing session id', async () => {
    const result = await applySpawnConfiguration([
      { item: 'filing', apply: async () => {} },
      { item: 'folder', apply: async () => { throw new Error('preferences unavailable') } },
    ])
    expect(result).toEqual({ ready: false, applied: ['filing'], pending: [{ item: 'folder', reason: 'preferences unavailable' }] })
    expect(configurationPendingMessage('child-1', result)).toContain('Session child-1 is running with configuration pending')
    expect(configurationPendingMessage('child-1', result)).toContain('Do not spawn a duplicate')
  })
})
