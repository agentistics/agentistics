import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createControlHost } from '../cli-start'
import { defaultDurableStore } from './structured-durable'
import { __setSessionBackendForTest } from './index'
import { addSession, readRegistry, removeSession } from './registry'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { __setSpawnBudgetForTest } from './memory-probe'
import { resetHarnessAvailability } from './harness-available'
import { ensureSpawnRole } from './session-roles'
import type { ManagedSession, SessionBackend } from './types'

const alive = new Set<string>()
const created: string[] = []
const delivered: [string, string][] = []
const backend = {
  id: 'tmux', unavailable: async () => undefined,
  spawn: async ({ id }: { id: string }) => { created.push(id); alive.add(id) },
  list: async () => [...alive].map(id => ({ id, alive: true, attached: false, createdMs: Date.now() })),
  capture: async () => [], kill: async () => true,
  sendText: async (id: string, text: string) => { delivered.push([id, text]); return true },
  attachCommand: () => [], detachHint: async () => 'test',
} as unknown as SessionBackend
const terminal = { async suspend<T>(_fn: () => Promise<T>): Promise<T> { throw new Error('no terminal') } }
const host = () => createControlHost('en', terminal)
let dir: string
let pathBefore: string | undefined
const owned = new Set<string>()
const row = async (conversationId: string, extra: Partial<ManagedSession> = {}) => {
  const m: ManagedSession = { id: randomUUID().slice(0, 10), harness: 'claude', cwd: dir, createdAt: new Date().toISOString(), conversationId, ...extra }
  owned.add(m.id)
  await addSession(m)
  return m
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'reopen-dup-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'claude'), 0o755)
  pathBefore = process.env.PATH
  process.env.PATH = `${bin}:${pathBefore ?? ''}`
  resetHarnessAvailability()
  __setSessionBackendForTest(backend)
  __setHarnessAgentsReaderForTest(async () => [])
  __setSpawnBudgetForTest({ value: null })
})
afterAll(async () => {
  for (const id of [...owned, ...created]) await removeSession(id)
  if (pathBefore === undefined) delete process.env.PATH
  else process.env.PATH = pathBefore
  resetHarnessAvailability()
  __setSessionBackendForTest(null)
  __setHarnessAgentsReaderForTest(null)
  __setSpawnBudgetForTest(null)
  rmSync(dir, { recursive: true, force: true })
})

test('parallel reopen replaces a dead row once and returns the same live id to both callers', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString(), label: 'worker', note: 'keep' })
  const h = host()
  const req = { sessionId: conversationId, harness: 'claude', cwd: dir, label: 'worker', attach: false, replaces: old.id }
  const before = created.length
  const [a, b] = await Promise.all([h.resumeSession!(req), h.resumeSession!(req)])
  expect(a.ok).toBe(true)
  expect(b).toMatchObject({ ok: true, id: a.id })
  expect(created.length - before).toBe(1)
  const rows = (await readRegistry()).filter(r => r.conversationId === conversationId)
  expect(rows.filter(r => !r.endedAt).map(r => r.id)).toEqual([a.id!])
  expect(rows.find(r => r.id === old.id)?.endedAt).toBeTruthy()
  expect(rows.find(r => r.id === a.id)?.note).toBe('keep')
  // Reopening the replacement itself must also reuse it (the former self-exclusion bug).
  expect(await h.resumeSession!({ ...req, replaces: a.id })).toMatchObject({ ok: true, id: a.id })
  expect(created.length - before).toBe(1)
}, 15_000)

test('a live CLI-owned relay listed by the backend is reused even with a stale ended stamp', async () => {
  const conversationId = randomUUID()
  const cli = await row(conversationId, { endedAt: new Date().toISOString() })
  // The composite backend lists a relay owned in another process exactly like this; no local chat.
  alive.add(cli.id)
  const before = created.length
  expect(await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'CLI', attach: false, replaces: cli.id })).toMatchObject({ ok: true, id: cli.id })
  expect(created.length).toBe(before)
})

test('sending through an ended row delivers to the live row and returns its id', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString() })
  const live = await row(conversationId)
  alive.add(live.id)
  const before = created.length
  expect(await host().promptSession!(old.id, 'owner message')).toMatchObject({ ok: true, id: live.id })
  expect(delivered.at(-1)).toEqual([live.id, 'owner message'])
  expect(created.length).toBe(before)
  // External continuation carries a prompt through resumeSession instead of the prompt verb.
  expect(await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'CLI', attach: false, prompt: 'continue' })).toMatchObject({ ok: true, id: live.id })
  expect(delivered.at(-1)).toEqual([live.id, 'continue'])
  expect(created.length).toBe(before)
})

test('unreadable backend liveness refuses a reopen without spawning', async () => {
  const conversationId = randomUUID()
  const before = created.length
  __setSessionBackendForTest({ ...backend, list: async () => { throw new Error('backend unreadable') } })
  try {
    expect(await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'worker', attach: false })).toMatchObject({ ok: false })
    expect(created.length).toBe(before)
  } finally { __setSessionBackendForTest(backend) }
})

// A crash leaves a leader row behind; restoring its role also goes through fleet rename.
test('reopening a fallen leader returns a result and keeps its role', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString(), label: '[ LEADER ] - Motor' })
  await ensureSpawnRole([old.id, conversationId], 'leader')
  const out = await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: old.label!, attach: false, origin: 'web', replaces: old.id })
  expect(out).toMatchObject({ ok: true, id: expect.any(String) })
}, 15_000)

test('an internal host resume failure is logged and returned in words', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  __setSessionBackendForTest({ ...backend, list: async () => { throw new TypeError('private backend diagnostic') } })
  try {
    const out = await host().resumeSession!({ sessionId: randomUUID(), harness: 'claude', cwd: dir, label: 'Motor', attach: false })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('Could not reopen')
    expect(out.message).not.toContain('private backend diagnostic')
    expect(log).toHaveBeenCalled()
  } finally {
    __setSessionBackendForTest(backend)
    log.mockRestore()
  }
})

// REABRIR.OPENCODE — an ENDED row that is its own holder (its backend entry outlived the assistant). The wiring in
// cli-start.ts decides on the structured record's liveness: a relay OR its recorded child still running is reused.
const killed: string[] = []
const withKillSpy = () => __setSessionBackendForTest({ ...backend, kill: async (id: string) => { killed.push(id); alive.delete(id); return true } })
const procs: { pid?: number; kill(): void }[] = []
/** A process whose argv names `dir`, as a real relay's does. */
const fakeRelay = (dir: string) => { const p = Bun.spawn(['sh', '-c', 'sleep 300', dir], { stdio: ['ignore', 'ignore', 'ignore'] }); procs.push(p); return p.pid }
const structuredRecord = (id: string, pids: { relay: number; child: number | null } | null) => {
  const store = defaultDurableStore()
  const dir = store.dirOf(id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'spawn.json'), JSON.stringify({ v: 1, harness: 'claude', spawn: {}, backend: { id: 'x', cwd: dir } }))
  writeFileSync(join(dir, 'launch.json'), '{}')
  if (pids) writeFileSync(join(dir, 'relay.pid'), JSON.stringify(pids))
  owned.add(id)
  return dir
}
afterAll(() => { for (const p of procs) { try { p.kill() } catch { /* gone */ } } for (const id of owned) rmSync(defaultDurableStore().dirOf(id), { recursive: true, force: true }) })

test('an ended row that is its own holder with an idle relay and no child: the leftover is ended and the reopen proceeds', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString(), label: 'oc' })
  structuredRecord(old.id, { relay: 2_147_000_000, child: null })
  alive.add(old.id)
  withKillSpy()
  try {
    const before = created.length
    const out = await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'oc', attach: false, replaces: old.id })
    expect(out.ok).toBe(true)
    expect(killed).toContain(old.id)
    expect(out.id).not.toBe(old.id)
    expect(created.length - before).toBe(1)
  } finally { __setSessionBackendForTest(backend) }
}, 15_000)

test('an ended row whose relay is still ALIVE is reused, nothing is killed', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString() })
  const d = structuredRecord(old.id, null)
  writeFileSync(join(d, 'relay.pid'), JSON.stringify({ relay: fakeRelay(d), child: null }))
  alive.add(old.id)
  withKillSpy()
  killed.length = 0
  try {
    const before = created.length
    expect(await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'oc', attach: false, replaces: old.id })).toMatchObject({ ok: true, id: old.id })
    expect(killed).toEqual([])
    expect(created.length).toBe(before)
  } finally { __setSessionBackendForTest(backend) }
}, 15_000)

test('an ended row whose relay died but whose CHILD survives is not idle: nothing is killed, no second assistant starts', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString() })
  const d = structuredRecord(old.id, null)
  writeFileSync(join(d, 'relay.pid'), JSON.stringify({ relay: 2_147_000_000, child: fakeRelay(d) }))
  alive.add(old.id)
  withKillSpy()
  killed.length = 0
  try {
    const before = created.length
    expect(await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'oc', attach: false, replaces: old.id })).toMatchObject({ ok: true, id: old.id })
    expect(killed).toEqual([])
    expect(created.length).toBe(before)
  } finally { __setSessionBackendForTest(backend) }
}, 15_000)

test('a row OUTSIDE alive whose relay died but whose CHILD runs refuses the reopen: no new row, nothing killed', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString() })
  const d = structuredRecord(old.id, null)
  writeFileSync(join(d, 'relay.pid'), JSON.stringify({ relay: 2_147_000_000, child: fakeRelay(d) }))
  withKillSpy()
  killed.length = 0
  try {
    const before = created.length
    const out = await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'oc', attach: false, replaces: old.id })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('still running')
    expect(killed).toEqual([])
    expect(created.length).toBe(before)
  } finally { __setSessionBackendForTest(backend) }
}, 15_000)

test('relay dead and child dead: the takeover still proceeds', async () => {
  const conversationId = randomUUID()
  const old = await row(conversationId, { endedAt: new Date().toISOString() })
  const d = structuredRecord(old.id, null)
  writeFileSync(join(d, 'relay.pid'), JSON.stringify({ relay: 2_147_000_000, child: 2_147_000_001 }))
  const before = created.length
  const out = await host().resumeSession!({ sessionId: conversationId, harness: 'claude', cwd: dir, label: 'oc', attach: false, replaces: old.id })
  expect(out.ok).toBe(true)
  expect(created.length - before).toBe(1)
}, 15_000)
