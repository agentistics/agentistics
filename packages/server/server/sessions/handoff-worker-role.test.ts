import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { start } from './cli-session'
import { parseSessionArgs } from './cli-parse'
import { addSession, readRegistry } from './registry'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { __setSessionBackendForTest } from './index'
import { ensureSpawnRole, storedRoleFor } from './session-roles'
import { createControlHost } from '../cli-start'
import { createTask, addSubtask } from './task-web'
import { updatePreferences, readPreferences } from '../preferences'
import { isolateAgentEnv } from './agent-env.testing'
import type { ManagedSession, SessionBackend } from './types'

// Worker vs leader hand-off, through BOTH real doors (`session start --handoff` and `spawnManaged`).
isolateAgentEnv()
const saved = process.env.AGENTOP_MANAGED_ID
beforeAll(() => __setHarnessAgentsReaderForTest(async () => []))
afterAll(() => { __setHarnessAgentsReaderForTest(null); __setSessionBackendForTest(null) })
afterEach(() => { __setSessionBackendForTest(null); if (saved === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = saved })

const mkBackend = () => ({
  id: 'tmux', unavailable: async () => undefined, list: async () => [],
  spawn: async () => {}, capture: async () => [], kill: async () => true,
}) as unknown as SessionBackend

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (process.env.HW_DEBUG) return fn()
  const log = console.log; const err = console.error
  console.log = () => {}; console.error = () => {}
  try { return await fn() } finally { console.log = log; console.error = err }
}

async function addParent(id: string, kind: 'worker' | 'leader'): Promise<{ taskId: string; subtaskId: string | null }> {
  const t = await createTask({ title: `hw task ${id}` })
  if (!t) throw new Error('no task')
  const subtaskId = kind === 'worker' ? await addSubtask(t.id, `hw sub ${id}`) : null
  await updatePreferences(() => ({ sessionGroups: { groups: [{ id: `g-${id}`, name: `G ${id}`, sessionKeys: [`conv-${id}`] }] } }) as never)
  await addSession({
    id, harness: 'claude', cwd: process.cwd(), createdAt: new Date().toISOString(), label: `P ${id}`, conversationId: `conv-${id}`,
    mode: 'no-questions', taskId: t.id, ...(subtaskId ? { subtaskId } : {}),
    ...(kind === 'worker' ? { parentSessionId: 'lead-of-team', parentConversationId: 'conv-lead-of-team' } : {}),
  } as ManagedSession)
  if (kind === 'worker') await ensureSpawnRole([`conv-${id}`, id], 'worker')
  return { taskId: t.id, subtaskId }
}

const viaCli = async (parent: string): Promise<number> => {
  __setSessionBackendForTest(mkBackend())
  process.env.AGENTOP_MANAGED_ID = parent
  const cmd = parseSessionArgs(['claude', '--bg', '--force', '--handoff', '--cwd', process.cwd(), '-p', 'x'])
  if (cmd.kind !== 'start') throw new Error('not a start')
  return quiet(() => start(cmd, mkBackend(), { settleMs: 50, provesCaller: async () => true }))
}
const viaHost = async (parent: string): Promise<void> => {
  __setSessionBackendForTest(mkBackend())
  const host = createControlHost('en', { suspend: async (f: () => unknown) => f() } as never)
  const r = await quiet(() => host.spawnSession!({
    harness: 'claude', cwd: process.cwd(), attach: false, origin: 'background', prompt: 'x', force: true,
    parentSessionId: parent, parentVerified: true, handoff: true,
  } as never))
  if (!r.ok) throw new Error(`spawnSession refused: ${r.message}`)
}

const doors: Array<[string, (p: string) => Promise<unknown>]> = [['session start', viaCli], ['spawnManaged', viaHost]]

for (const [door, run] of doors) {
  describe(`hand-off through ${door}`, () => {
    test('a WORKER successor stays a worker in its parent\'s team; the predecessor is not retired', async () => {
      const p = `hw-${door.replace(/\W/g, '')}-w`
      const filed = await addParent(p, 'worker')
      const before = new Set((await readRegistry()).map(r => r.id))
      await run(p)
      const rows = await readRegistry()
      const fresh = rows.filter(r => !before.has(r.id))
      expect(fresh).toHaveLength(1)
      const child = fresh[0]!
      expect(child.handoffFrom).toBeUndefined()
      expect(child).toBeDefined()
      expect(await storedRoleFor([child.conversationId, child.id])).toBe('worker')
      expect(child.parentSessionId).toBe('lead-of-team')
      expect(child.parentConversationId).toBe('conv-lead-of-team')
      expect(child.mode).toBe('no-questions')
      expect(child.taskId).toBe(filed.taskId)
      if (filed.subtaskId) expect(child.subtaskId).toBe(filed.subtaskId)
      expect((await readPreferences()).sessionGroups?.groups.find(g => g.id === `g-${p}`)?.sessionKeys).toContain(child.conversationId!)
      expect(rows.find(r => r.id === p)!.retire).toBeUndefined()
    }, 60_000)

    test('a LEADER successor sits at the root and the predecessor is retired', async () => {
      const p = `hw-${door.replace(/\W/g, '')}-l`
      await addParent(p, 'leader')
      await run(p)
      const rows = await readRegistry()
      const child = rows.find(r => r.handoffFrom === p)!
      expect(child).toBeDefined()
      expect(child.parentSessionId).toBeUndefined()
      expect(await storedRoleFor([child.conversationId, child.id])).toBe('leader')
      expect(rows.find(r => r.id === p)!.retire?.successorId).toBe(child.id)
    }, 60_000)
  })
}

describe('a reopened worker (new managed id, role keyed by conversation) keeps its role through session start', () => {
  test('role looked up by the parent row\'s conversationId', async () => {
    await addParent('hw-reopen', 'leader')
    await ensureSpawnRole(['conv-hw-reopen'], 'worker')
    // The role lives under the conversation only (a reopen mints a new managed id).
    const before = new Set((await readRegistry()).map(r => r.id))
    expect(await viaCli('hw-reopen')).toBe(0)
    const child = (await readRegistry()).find(r => !before.has(r.id))!
    expect(await storedRoleFor([child.conversationId, child.id])).toBe('worker')
  }, 60_000)
})

describe('a reopened worker handed off through the HOST door', () => {
  test('reopened worker (role keyed by conversation only) handed off through the HOST door stays a worker, not re-rooted, predecessor not retired', async () => {
    await addParent('hw-reopen-host', 'leader')
    // A reopen mints a new managed id: the role lives under the conversation only.
    await ensureSpawnRole(['conv-hw-reopen-host'], 'worker')
    const before = new Set((await readRegistry()).map(r => r.id))
    await viaHost('hw-reopen-host')
    const rows = await readRegistry()
    const child = rows.find(r => !before.has(r.id))!
    expect(child).toBeDefined()
    expect(child.handoffFrom).toBeUndefined()
    expect(await storedRoleFor([child.conversationId, child.id])).toBe('worker')
    expect(rows.find(r => r.id === 'hw-reopen-host')!.retire).toBeUndefined()
  }, 60_000)
})
