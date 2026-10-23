import { afterEach, describe, expect, test } from 'bun:test'
import { runSession } from './cli-session'
import { __setSessionBackendForTest } from './index'
import type { SessionBackend } from './types'

afterEach(() => { __setSessionBackendForTest(null) })

describe('session CLI permission failures', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    test(`${code} before launch prints one actionable sentence and starts nothing`, async () => {
      const path = '/read-only data/session-roles.json.tmp'
      const failure = Object.assign(new Error('filesystem write failed'), { code, path })
      let spawned = 0
      __setSessionBackendForTest({
        id: 'tmux',
        unavailable: async () => { throw failure },
        spawn: async () => { spawned++ },
      } as unknown as SessionBackend)
      const lines: string[] = []
      const original = console.error
      console.error = (...args: unknown[]) => { lines.push(args.join(' ')) }
      try {
        expect(await runSession(['claude', '--bg', '--force'])).toBe(1)
      } finally {
        console.error = original
      }
      expect(spawned).toBe(0)
      expect(lines).toEqual([
        `Could not complete the session command at ${JSON.stringify(path)} (${code}: ${code === 'EROFS' ? 'read-only filesystem' : 'permission denied'}); make the data directory writable by your user and retry.`,
      ])
    })
  }

  test('unrelated errors remain visible to the caller', async () => {
    const failure = new Error('unexpected backend failure')
    __setSessionBackendForTest({
      id: 'tmux', unavailable: async () => { throw failure },
    } as unknown as SessionBackend)
    await expect(runSession(['claude', '--bg'])).rejects.toBe(failure)
  })
})
