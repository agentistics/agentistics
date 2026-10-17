import { afterEach, describe, expect, test } from 'bun:test'
import { start } from './cli-session'
import { parseSessionArgs } from './cli-parse'
import { addSession, patchSession, readRegistry } from './registry'
import { ancestorChain, callerRunsInSession, ensureSessionIdentityKey } from './session-identity'
import { passPinForKill } from './handoff-relay-io'
import { readPreferences, updatePreferences } from '../preferences'
import type { ManagedSession, SessionBackend } from './types'

const saved = process.env.AGENTOP_MANAGED_ID
afterEach(() => { if (saved === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = saved })

const mkBackend = (onSpawn: (id: string) => Promise<void> = async () => {}) => ({
  id: 'tmux', unavailable: async () => undefined, list: async () => [],
  spawn: async (req: { id: string }) => { await onSpawn(req.id) },
  capture: async () => [], kill: async () => true,
}) as unknown as SessionBackend

async function runHandoff(parent: string, harness: string, backend: SessionBackend, provesCaller?: (id: string) => Promise<boolean>) {
  process.env.AGENTOP_MANAGED_ID = parent
  const cmd = parseSessionArgs([harness, '--bg', '--force', '--handoff', '--cwd', process.cwd(), '-p', 'x'])
  if (cmd.kind !== 'start') throw new Error('not a start')
  const log = console.log; const err = console.error
  console.log = () => {}; console.error = () => {}
  try { return await start(cmd, backend, provesCaller ? { provesCaller } : {}) } finally { console.log = log; console.error = err }
}

const addLeader = async (id: string, conversationId: string) => {
  await addSession({ id, harness: 'claude', cwd: process.cwd(), createdAt: new Date().toISOString(), label: 'Leader', conversationId })
  await updatePreferences(() => ({ pinnedSessions: ['other', conversationId] }))
}
const successorOf = async (parent: string) => (await readRegistry()).find(r => r.parentSessionId === parent)

describe('agentop session --handoff — the CLI flow', () => {
  test('inherits the pin under the successor key', async () => {
    await addLeader('ho-p1', 'conv-ho-p1')
    expect(await runHandoff('ho-p1', 'claude', mkBackend(), async () => true)).toBe(0)
    const child = (await successorOf('ho-p1'))!
    expect(child.label).toContain('Leader')
    expect((await readPreferences()).pinnedSessions).toEqual(['other', child.conversationId!])
  }, 60_000)

  test('a forged AGENTOP_MANAGED_ID without the pane is refused, nothing starts', async () => {
    await addLeader('ho-p2', 'conv-ho-p2')
    const before = (await readRegistry()).length
    // real verifier: the (forged) env matches, but no pane pid is an ancestor of this process
    const backend = Object.assign(mkBackend(), { listPanePids: async () => new Map([['ho-p2', 2_000_000_000]]) })
    expect(await runHandoff('ho-p2', 'claude', backend)).toBe(1)
    expect((await readRegistry()).length).toBe(before)
    expect((await readPreferences()).pinnedSessions).toEqual(['other', 'conv-ho-p2'])
  }, 60_000)

  test('a conversation linked during the startup wait still gets the pin under its key', async () => {
    await addLeader('ho-p3', 'conv-ho-p3')
    const backend = mkBackend(async id => { await patchSession(id, { conversationId: 'late-conv' }) })
    expect(await runHandoff('ho-p3', 'codex', backend, async () => true)).toBe(0)
    expect((await readPreferences()).pinnedSessions).toEqual(['other', 'late-conv'])
  }, 60_000)
})

describe('caller proof', () => {
  test('the pane must be an ancestor of this process, and the env must name it', async () => {
    const env = { AGENTOP_MANAGED_ID: 'x' }
    const status = (pid: number) => (pid === 50 ? 'PPid:\t40\n' : pid === 40 ? 'PPid:\t1\n' : undefined)
    expect(ancestorChain(50, status)).toEqual([50, 40])
    const ok = (pane: number) => callerRunsInSession('x', async () => new Map([['x', pane]]), { env, pid: 50, readStatus: status })
    await ensureSessionIdentityKey()
    expect(await ok(40)).toBe(true)
    expect(await ok(999)).toBe(false)
    expect(await callerRunsInSession('x', async () => new Map([['x', 40]]), { env: {}, pid: 50, readStatus: status })).toBe(false)
  })
})

describe('kill into a folder — the pin goes to a LIVE successor only', () => {
  const row = (o: Partial<ManagedSession>) => ({ harness: 'claude', cwd: '/', createdAt: 'x', ...o }) as ManagedSession
  test('an ended successor does not inherit the pin', async () => {
    await updatePreferences(() => ({ pinnedSessions: ['conv-a'] }))
    const dying = row({ id: 'a', conversationId: 'conv-a', handoffTo: 'b' })
    const dead = row({ id: 'b', conversationId: 'conv-b', endedAt: new Date().toISOString() })
    expect(await passPinForKill(dying, [dying, dead], updatePreferences)).toBe(false)
    expect((await readPreferences()).pinnedSessions).toEqual(['conv-a'])
  })
  test('a live successor takes it', async () => {
    await updatePreferences(() => ({ pinnedSessions: ['conv-a'] }))
    const dying = row({ id: 'a', conversationId: 'conv-a', handoffTo: 'b' })
    const live = row({ id: 'b', conversationId: 'conv-b' })
    expect(await passPinForKill(dying, [dying, live], updatePreferences)).toBe(true)
    expect((await readPreferences()).pinnedSessions).toEqual(['conv-b'])
  })
})
