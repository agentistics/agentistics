import { afterEach, describe, expect, test } from 'bun:test'
import { runSession } from './cli-session'
import { __setSessionBackendForTest } from './index'
import { addSession, readRegistry, removeSession } from './registry'
import type { SessionBackend } from './types'

const ID = 'agentop-rnguard01'

afterEach(async () => {
  __setSessionBackendForTest(null)
  await removeSession(ID).catch(() => {})
})

/** A backend whose pane may be alive or not; counts every `/rename` typed into it. */
function fake(alive: boolean, typed: string[]): SessionBackend {
  return {
    id: 'tmux',
    unavailable: async () => null,
    list: async () => [{ id: ID, alive }],
    capture: async () => ['● idle', '> '],
    sendText: async (_id: string, line: string) => { typed.push(line); return true },
  } as unknown as SessionBackend
}

async function seed() {
  await addSession({
    id: ID, harness: 'claude', cwd: '/tmp', createdAt: new Date().toISOString(),
  } as never)
}

async function rename(label: string): Promise<void> {
  const original = console.log
  console.log = () => {}
  try { expect(await runSession(['rename', ID, label])).toBe(0) } finally { console.log = original }
}

describe('agentop session rename is idempotent once the harness confirmed the title', () => {
  test('repeating the same name types /rename ONCE', async () => {
    await seed()
    const typed: string[] = []
    __setSessionBackendForTest(fake(true, typed))
    await rename('[ LÍDER ] - Jarvis')
    await rename('[ LÍDER ] - Jarvis')
    expect(typed.length).toBe(1)
    expect((await readRegistry()).find(r => r.id === ID)?.renameSent).toBe('[ LÍDER ] - Jarvis')
  })

  test('a rename the harness never received (not running) is retried, not swallowed', async () => {
    await seed()
    const typed: string[] = []
    __setSessionBackendForTest(fake(false, typed))
    await rename('Same')
    expect(typed.length).toBe(0)
    expect((await readRegistry()).find(r => r.id === ID)?.renameSent).toBeUndefined()
    __setSessionBackendForTest(fake(true, typed))
    await rename('Same')
    expect(typed.length).toBe(1)
  })
})
