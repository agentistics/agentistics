import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createControlHost } from '../cli-start'
import { __setSessionBackendForTest } from './index'
import { addSession, readRegistry, removeSession } from './registry'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { __setSpawnBudgetForTest } from './memory-probe'
import { resetHarnessAvailability } from './harness-available'
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
