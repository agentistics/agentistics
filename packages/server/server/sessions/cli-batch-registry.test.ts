import { describe, expect, test } from 'bun:test'
import { batch } from './cli-session'
import { readRegistry } from './registry'
import type { SessionBackend } from './types'

describe('batch — the registry row brackets the spawn', () => {
  test('the row exists BEFORE the pane is spawned, and is removed when the spawn fails', async () => {
    const seen: boolean[] = []
    const backend = {
      id: 'tmux',
      unavailable: async () => undefined,
      spawn: async (req: { id: string }) => {
        seen.push((await readRegistry()).some(m => m.id === req.id))
        throw new Error('pane refused')
      },
      list: async () => [],
      capture: async () => [],
      kill: async () => {},
    } as unknown as SessionBackend
    const before = (await readRegistry()).length
    const log = console.log
    console.log = () => {}
    try {
      const code = await batch({
        kind: 'batch', task: 'registry-order', json: true, force: true,
        specs: [{ harness: 'claude', prompt: 'x', cwd: process.cwd() }],
      } as Parameters<typeof batch>[0], backend)
      expect(code).not.toBe(0)
    } finally {
      console.log = log
    }
    expect(seen).toEqual([true])
    expect((await readRegistry()).length).toBe(before)
  })
})
