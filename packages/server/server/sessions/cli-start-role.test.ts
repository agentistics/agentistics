import { afterEach, describe, expect, test } from 'bun:test'
import { start } from './cli-session'
import { parseSessionArgs } from './cli-parse'
import { addSession, readRegistry } from './registry'
import { loadRoles, defaultRoleDeps } from './session-roles'
import type { SessionBackend } from './types'
import { isolateAgentEnv } from './agent-env.testing'

// A spawn door reads AGENTOP_*/AGENTISTICS_* from the shell it runs in (inside a managed session: the caller's identity and the feature
// switches): every test starts from a bare agent environment and gets it back.
isolateAgentEnv()

const backend = {
  id: 'tmux', unavailable: async () => undefined, spawn: async () => {}, list: async () => [],
  capture: async () => [], kill: async () => {},
} as unknown as SessionBackend

const saved = process.env.AGENTOP_MANAGED_ID
afterEach(() => { if (saved === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = saved })

async function run(argv: string[], parent?: string) {
  if (parent) {
    await addSession({ id: parent, harness: 'claude', cwd: process.cwd(), createdAt: new Date().toISOString() })
    process.env.AGENTOP_MANAGED_ID = parent
  } else delete process.env.AGENTOP_MANAGED_ID // hermetic: never the runner's own session
  const cmd = parseSessionArgs(argv)
  if (cmd.kind !== 'start') throw new Error('not a start')
  const log = console.log
  console.log = () => {}
  // DSL.TIPO-SESSAO: a parent is a PROVEN caller (its pane/relay); the test stands in for that proof.
  try { expect(await start(cmd, backend, parent ? { provesCaller: async id => id === parent } : {})).toBe(0) } finally { console.log = log }
  const rows = await readRegistry()
  const child = rows.find(r => r.id !== parent && r.parentSessionId === parent) ?? rows[rows.length - 1]!
  const doc = await loadRoles(await defaultRoleDeps())
  return { child, roles: doc.roles }
}

describe('agentop session <harness> --bg — the stored role', () => {
  test('a detected parent and no --role stores worker', async () => {
    const { child, roles } = await run(['claude', '--bg', '--force', '--cwd', process.cwd(), '--name', 'Motor', '-p', 'x'], 'parent-bg-1')
    expect(roles[child.id]).toBe('worker')
  }, 60_000)
  test('a --name wearing the leader prefix never silently becomes a worker', async () => {
    const { child, roles } = await run(['claude', '--bg', '--force', '--cwd', process.cwd(), '--name', '[ LÍDER ] - Motor', '-p', 'x'], 'parent-bg-3')
    expect(roles[child.id]).toBe('leader')
  }, 60_000)
  test('--role leader works with --bg', async () => {
    const { child, roles } = await run(['claude', '--bg', '--force', '--role', 'leader', '--cwd', process.cwd(), '--name', 'Motor', '-p', 'x'], 'parent-bg-2')
    expect(roles[child.id]).toBe('leader')
  }, 60_000)
})
