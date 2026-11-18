// Imports are relative to packages/server/server/ — this file belongs beside cli-start.ts.
import { afterEach, expect, test } from 'bun:test'
import { createControlHost } from './cli-start'
import { __setSessionBackendForTest } from './sessions/index'
import { addSession, removeSession } from './sessions/registry'
import type { SessionBackend } from './sessions/types'

// The cockpit's rename verb is the path the leader's `agentistics_session_role` takes
// (session-roles.ts → fleet action 'rename' → host.renameSession). cli-rename-guard.test.ts covers
// the CLI; this covers the cockpit.
const ID = 'agentop-cockpitrn01'

afterEach(async () => {
  __setSessionBackendForTest(null)
  await removeSession(ID).catch(() => {})
})

/** A backend whose pane may be alive or not; records every line typed into it. */
function fake(alive: boolean, typed: string[]): SessionBackend {
  return {
    id: 'tmux',
    unavailable: async () => null,
    list: async () => [{ id: ID, alive }],
    capture: async () => ['● idle', '> '],
    sendText: async (_id: string, line: string) => { typed.push(line); return true },
  } as unknown as SessionBackend
}

test('cockpit renameSession: a repeat of a confirmed title types /rename once; a skipped one is retried; a repeat after success is a no-op', async () => {
    await addSession({ id: ID, harness: 'claude', cwd: '/tmp', createdAt: new Date().toISOString() } as never)
    const typed: string[] = []
    __setSessionBackendForTest(fake(true, typed))
    const host = createControlHost('en', { suspend: async (fn: () => unknown) => fn() } as never)

    // Confirmed title: sent once, the repeat is a no-op.
    await host.renameSession!(ID, '[ LÍDER ] - Jarvis')
    await host.renameSession!(ID, '[ LÍDER ] - Jarvis')
    expect(typed.length).toBe(1)

    // Harness not running: skipped, so the next request must reach the harness.
    __setSessionBackendForTest(fake(false, typed))
    await host.renameSession!(ID, 'B')
    expect(typed.length).toBe(1)

    // Running again: the retry is sent...
    __setSessionBackendForTest(fake(true, typed))
    await host.renameSession!(ID, 'B')
    expect(typed.length).toBe(2)

    // ...and a repeat of that confirmed title is a no-op.
    await host.renameSession!(ID, 'B')
    expect(typed.length).toBe(2)
})
