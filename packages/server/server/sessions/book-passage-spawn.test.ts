/**
 * LIVRO.SEAMS 3a (B6 / R1) — through the REAL spawn path (`createControlHost().spawnSession` → `spawnManaged`):
 * a hand-off-book passage keeps the successor's parent = the predecessor and does not retire the predecessor at spawn
 * (the book's own confirm step retires); an ordinary host-door hand-off is unchanged (re-rooted + retired); and a
 * rolled-back successor does not keep the leader role while the old leader carries no pending retire.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSession, readRegistry } from './registry'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { __setSessionBackendForTest } from './index'
import { resetHarnessAvailability } from './harness-available'
import { ensureSpawnRole, storedRoleFor } from './session-roles'
import { createControlHost } from '../cli-start'
import { createTask } from './task-web'
import { createBookHost, clearSessionRole } from '../engine/engine-book-host'
import { planFleetSpawn } from './fleet-spawn'
import { isolateAgentEnv } from './agent-env.testing'
import type { ManagedSession, SessionBackend } from './types'

isolateAgentEnv()
const stubBin = mkdtempSync(join(tmpdir(), 'bp-bin-'))
const pathBefore = process.env.PATH
beforeAll(() => {
  __setHarnessAgentsReaderForTest(async () => [])
  writeFileSync(join(stubBin, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(stubBin, 'claude'), 0o755)
  process.env.PATH = `${stubBin}:${pathBefore ?? ''}`
  resetHarnessAvailability()
})
afterAll(() => {
  __setHarnessAgentsReaderForTest(null); __setSessionBackendForTest(null)
  if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore
  resetHarnessAvailability()
  rmSync(stubBin, { recursive: true, force: true })
})
afterEach(() => { __setSessionBackendForTest(null) })

const mkBackend = () => ({
  id: 'tmux', unavailable: async () => undefined, list: async () => [],
  spawn: async () => {}, capture: async () => [], kill: async () => true,
}) as unknown as SessionBackend

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log; const err = console.error
  console.log = () => {}; console.error = () => {}
  try { return await fn() } finally { console.log = log; console.error = err }
}

async function addLeader(id: string): Promise<void> {
  const t = await createTask({ title: `bp task ${id}` })
  if (!t) throw new Error('no task')
  await addSession({
    id, harness: 'claude', cwd: process.cwd(), createdAt: new Date().toISOString(), label: `P ${id}`, conversationId: `conv-${id}`,
    mode: 'no-questions', taskId: t.id,
  } as ManagedSession)
  await ensureSpawnRole([`conv-${id}`, id], 'leader')
}

async function spawnSuccessor(parent: string, extra: Record<string, unknown>): Promise<ManagedSession> {
  __setSessionBackendForTest(mkBackend())
  const before = new Set((await readRegistry()).map(r => r.id))
  const host = createControlHost('en', { suspend: async (f: () => unknown) => f() } as never)
  const r = await quiet(() => host.spawnSession!({
    harness: 'claude', cwd: process.cwd(), attach: false, origin: 'background', prompt: 'x', force: true,
    parentSessionId: parent, parentVerified: true, handoff: true, ...extra,
  } as never))
  if (!r.ok) throw new Error(`spawnSession refused: ${r.message}`)
  return (await readRegistry()).find(x => !before.has(x.id))!
}

describe('a hand-off-book passage through the real spawn path', () => {
  test('the successor keeps the predecessor as parent, is a leader, and the predecessor is NOT retired at spawn', async () => {
    await addLeader('bp-old')
    const child = await spawnSuccessor('bp-old', { bookPassage: true })
    expect(child.parentSessionId).toBe('bp-old')
    expect(child.parentConversationId).toBe('conv-bp-old')
    expect(await storedRoleFor([child.conversationId, child.id])).toBe('leader')
    expect((await readRegistry()).find(r => r.id === 'bp-old')!.retire).toBeUndefined()
  }, 60_000)

  test('an ordinary host-door hand-off is unchanged: the leader successor is re-rooted and the predecessor retired', async () => {
    await addLeader('bp-plain')
    const child = await spawnSuccessor('bp-plain', {})
    expect(child.parentSessionId).toBeUndefined()
    expect((await readRegistry()).find(r => r.id === 'bp-plain')!.retire?.successorId).toBe(child.id)
  }, 60_000)

  test('a leader born by any OTHER spawn (explicit role, no passage) is still rooted at birth', async () => {
    await addSession({ id: 'bp-explicit', harness: 'claude', cwd: process.cwd(), createdAt: new Date().toISOString(), label: 'P bp-explicit', conversationId: 'conv-bp-explicit' } as ManagedSession)
    const child = await spawnSuccessor('bp-explicit', { handoff: undefined, role: 'leader' })
    expect(await storedRoleFor([child.conversationId, child.id])).toBe('leader')
    expect(child.parentSessionId).toBeUndefined()
    expect(child.parentConversationId).toBeUndefined()
  }, 60_000)

  test('R1: a rollback (stop) leaves no leader role on the dead successor and no pending retire on the old leader', async () => {
    await addLeader('bp-roll')
    const child = await spawnSuccessor('bp-roll', { bookPassage: true })
    expect(await storedRoleFor([child.conversationId, child.id])).toBe('leader')
    const host = createBookHost({
      registry: readRegistry, spawn: async () => ({ ok: false, message: 'unused' }),
      kill: async () => ({ ok: true }), requestRetire: async () => true,
      clearRole: clearSessionRole, verify: async () => null,
    })
    expect(await host.stop(child.id)).toEqual({ closed: true })
    expect(await storedRoleFor([child.conversationId, child.id])).toBeUndefined()
    expect(await storedRoleFor(['conv-bp-roll', 'bp-roll'])).toBe('leader')
    expect((await readRegistry()).find(r => r.id === 'bp-roll')!.retire).toBeUndefined()
  }, 60_000)

  test('3b (item 0): the book host moves the old leader\'s live workers to the confirmed successor (real registry)', async () => {
    await addLeader('bp-rp-old')
    await addLeader('bp-rp-new')
    const now = new Date().toISOString()
    await addSession({ id: 'bp-rp-w1', harness: 'claude', cwd: process.cwd(), createdAt: now, label: 'W1', parentSessionId: 'bp-rp-old' } as ManagedSession)
    await addSession({ id: 'bp-rp-w2', harness: 'claude', cwd: process.cwd(), createdAt: now, label: 'W2', parentSessionId: 'bp-rp-other' } as ManagedSession)
    const host = createBookHost({
      registry: readRegistry, spawn: async () => ({ ok: false, message: 'unused' }),
      kill: async () => ({ ok: true }), requestRetire: async () => true, verify: async () => null,
    })
    expect(await host.reparentWorkers!('bp-rp-old', 'bp-rp-new')).toEqual({ moved: 1 })
    const rows = await readRegistry()
    expect(rows.find(r => r.id === 'bp-rp-w1')!.parentSessionId).toBe('bp-rp-new')
    expect(rows.find(r => r.id === 'bp-rp-w2')!.parentSessionId).toBe('bp-rp-other')
    // Neither leader is re-rooted or retired by the move itself.
    expect(rows.find(r => r.id === 'bp-rp-old')!.retire).toBeUndefined()
  }, 60_000)

  test('a confirm (retire) clears the OLD leader\'s role under both keys and nobody else\'s (real clearRole)', async () => {
    await addLeader('bp-a')
    await addLeader('bp-b')
    const host = createBookHost({
      registry: readRegistry, spawn: async () => ({ ok: false, message: 'unused' }),
      kill: async () => ({ ok: true }), requestRetire: async () => true,
      clearRole: clearSessionRole, verify: async () => null,
    })
    expect(await host.retire('bp-a', 'succ')).toEqual({ retired: true })
    expect(await storedRoleFor(['conv-bp-a', 'bp-a'])).toBeUndefined()
    expect(await storedRoleFor(['conv-bp-b', 'bp-b'])).toBe('leader')
  }, 60_000)
})

describe('LIVRO.SEAMS 3b (M1): the engine spawn gate is told the task the successor is filed on', () => {
  test('a book-passage successor spawn hands `portao-de-spawn` the predecessor\'s task id', async () => {
    const load = await import('../engine/load')
    const { makeFakeEngine } = await import('../engine/fixtures/fake-engine')
    const asked: Array<Record<string, unknown>> = []
    const create = async (h: never) => ({
      ...(await makeFakeEngine()(h)),
      flows: {
        list: () => ['portao-de-spawn'],
        run: async (name: string, inputs?: Record<string, unknown>) => {
          if (name === 'portao-de-spawn') asked.push(inputs ?? {})
          // Refusing keeps the test from starting anything: what matters is what the gate was asked.
          return { runId: 'r-1', status: 'refused', refusal: { reason: 'stopped by the test gate' } }
        },
        status: async () => null,
      },
    })
    const prevFlows = process.env.AGENTISTICS_FLOWS
    load.resetEngineForTests()
    try {
      await load.loadEngine({ create: create as never, host: () => ({}) as never, env: {}, log: () => {} })
      process.env.AGENTISTICS_FLOWS = '1'
      await addLeader('bp-gate')
      const taskId = (await readRegistry()).find(r => r.id === 'bp-gate')!.taskId
      __setSessionBackendForTest(mkBackend())
      const host = createControlHost('en', { suspend: async (f: () => unknown) => f() } as never)
      const r = await quiet(() => host.spawnSession!({
        harness: 'claude', cwd: process.cwd(), attach: false, origin: 'background', prompt: 'x', force: true,
        parentSessionId: 'bp-gate', parentVerified: true, handoff: true, bookPassage: true,
      } as never))
      expect(r.ok).toBe(false)
      expect(r.message).toContain('stopped by the test gate')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ door: 'handoff', taskId })
    } finally {
      if (prevFlows === undefined) delete process.env.AGENTISTICS_FLOWS; else process.env.AGENTISTICS_FLOWS = prevFlows
      load.resetEngineForTests()
    }
  }, 60_000)

  test('an explicit `gateTaskId` outranks the task the spawn is filed on', async () => {
    const load = await import('../engine/load')
    const { makeFakeEngine } = await import('../engine/fixtures/fake-engine')
    const asked: Array<Record<string, unknown>> = []
    const create = async (h: never) => ({
      ...(await makeFakeEngine()(h)),
      flows: {
        list: () => ['portao-de-spawn'],
        run: async (name: string, inputs?: Record<string, unknown>) => {
          if (name === 'portao-de-spawn') asked.push(inputs ?? {})
          return { runId: 'r-2', status: 'refused', refusal: { reason: 'stopped by the test gate' } }
        },
        status: async () => null,
      },
    })
    const prevFlows = process.env.AGENTISTICS_FLOWS
    load.resetEngineForTests()
    try {
      await load.loadEngine({ create: create as never, host: () => ({}) as never, env: {}, log: () => {} })
      process.env.AGENTISTICS_FLOWS = '1'
      await addLeader('bp-gate2')
      const filedOn = (await readRegistry()).find(r => r.id === 'bp-gate2')!.taskId
      __setSessionBackendForTest(mkBackend())
      const host = createControlHost('en', { suspend: async (f: () => unknown) => f() } as never)
      await quiet(() => host.spawnSession!({
        harness: 'claude', cwd: process.cwd(), attach: false, origin: 'background', prompt: 'x', force: true,
        parentSessionId: 'bp-gate2', parentVerified: true, handoff: true, bookPassage: true,
        taskId: filedOn, gateTaskId: 'explicit-gate-task',
      } as never))
      expect(asked).toHaveLength(1)
      expect(filedOn).not.toBe('explicit-gate-task')
      expect(asked[0]!.taskId).toBe('explicit-gate-task')
    } finally {
      if (prevFlows === undefined) delete process.env.AGENTISTICS_FLOWS; else process.env.AGENTISTICS_FLOWS = prevFlows
      load.resetEngineForTests()
    }
  }, 60_000)
})

describe('bookPassage is the server\'s statement, never the wire\'s', () => {
  test('planFleetSpawn keeps it only on a hand-off with a parent', () => {
    const base = { harness: 'claude', cwd: process.cwd() }
    const read = (body: Record<string, unknown>) => planFleetSpawn(body as never, [{ id: 'claude', supportsModel: true, efforts: [] }])
    const yes = read({ ...base, parent: 'p', handoff: true, bookPassage: true })
    const noHandoff = read({ ...base, parent: 'p', bookPassage: true })
    const noParent = read({ ...base, handoff: true, bookPassage: true })
    expect(yes.ok && yes.plan.bookPassage).toBe(true)
    expect(noHandoff.ok && noHandoff.plan.bookPassage).toBeFalsy()
    expect(noParent.ok && noParent.plan.bookPassage).toBeFalsy()
  })
})
