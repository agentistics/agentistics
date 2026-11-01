/**
 * FALLBACK.STRUCTURED — the one-shot "back to the new mode" (`host.backToStructured`): a row that runs as
 * a TUI is ended and its SAME conversation resumed structured (`origin: 'web'`, `resumeId`), inheriting
 * what the row carries. Driven through the real host with a recording backend and an isolated registry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlHost } from '../cli-start'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { __setSessionBackendForTest } from './index'
import { addSession, readRegistry, removeSession } from './registry'
import { __setSpawnBudgetForTest } from './memory-probe'
import { resetHarnessAvailability } from './harness-available'
import { runFleetAction, __setFleetHostForTest } from './fleet-web'
import type { BackendSpawn, ManagedSession, SessionBackend } from './types'

let dir = ''
let pathBefore: string | undefined
const NO_TERMINAL = { async suspend<T>(_fn: () => Promise<T>): Promise<T> { throw new Error('no terminal') } }

/** A backend where `alive` rows are tmux's, `structured` rows are driven, and a spawn can be told to land either way. */
function recordingBackend(o: { alive: string[]; structured?: string[]; landsStructured: boolean }) {
  const alive = new Set(o.alive)
  const structured = new Set(o.structured ?? [])
  const killed: string[] = []
  const spawned: BackendSpawn[] = []
  const b = {
    id: 'tmux', unavailable: async () => undefined,
    spawn: async (req: BackendSpawn) => {
      spawned.push(req)
      alive.add(req.id)
      if (o.landsStructured) structured.add(req.id)
      return {}
    },
    list: async () => [...alive].map(id => ({ id, createdMs: 1, attached: false, alive: true, lastActivityMs: 1 })),
    capture: async () => [], kill: async (id: string) => { killed.push(id); alive.delete(id); return true },
    isStructured: (id: string) => structured.has(id),
    detachHint: async () => 'C-b d', attachCommand: () => ['true'],
  } as unknown as SessionBackend
  return { b, killed, spawned }
}

const tmuxRow = (extra: Partial<ManagedSession> = {}): ManagedSession =>
  ({ id: `m-${Math.random().toString(16).slice(2, 10)}`, harness: 'claude', cwd: dir, label: 'Motor', createdAt: new Date().toISOString(), conversationId: '7d3f0a52-6b1e-4c8a-9f21-0a5b3c4d5e6f', ...extra }) as ManagedSession

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'back-structured-'))
  // The resume checks the harness can be executed; CI has no `claude`, so a stub binary stands in.
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'opencode'), 0o755)
  pathBefore = process.env.PATH
  process.env.PATH = `${bin}:${pathBefore ?? ''}`
  __setHarnessAgentsReaderForTest(async () => [])
  __setSpawnBudgetForTest({ value: null })
  resetHarnessAvailability()
})
afterAll(() => {
  if (pathBefore === undefined) delete process.env.PATH
  else process.env.PATH = pathBefore
  resetHarnessAvailability()
  __setSessionBackendForTest(null)
  __setHarnessAgentsReaderForTest(null)
  __setSpawnBudgetForTest(null)
  __setFleetHostForTest('en', null)
  rmSync(dir, { recursive: true, force: true })
})

describe('backToStructured', () => {
  test('a tmux row is ended and its same conversation resumed structured, the old row retired', async () => {
    const m = tmuxRow({ task: 't-1' })
    await addSession(m)
    const rec = recordingBackend({ alive: [m.id], landsStructured: true })
    __setSessionBackendForTest(rec.b)
    try {
      const out = await createControlHost('en', NO_TERMINAL).backToStructured!(m.id)
      expect(out.ok).toBe(true)
      expect(rec.killed).toEqual([m.id])
      expect(rec.spawned.length).toBe(1)
      expect(rec.spawned[0]!.structured).toMatchObject({ harness: 'claude', origin: 'web', resumeId: m.conversationId })
      const rows = await readRegistry()
      expect(rows.find(r => r.id === m.id)?.endedAt).toBeTruthy()
      const fresh = rows.find(r => r.id === rec.spawned[0]!.id)
      expect(fresh).toMatchObject({ conversationId: m.conversationId, task: 't-1' })
    } finally {
      for (const r of await readRegistry()) if (r.cwd === dir) await removeSession(r.id)
    }
  })

  test('the driver refusing the relaunch leaves the conversation in tmux and says so', async () => {
    const m = tmuxRow()
    await addSession(m)
    const rec = recordingBackend({ alive: [m.id], landsStructured: false })
    __setSessionBackendForTest(rec.b)
    try {
      const out = await createControlHost('en', NO_TERMINAL).backToStructured!(m.id)
      expect(out.ok).toBe(true)
      expect(out.message).toContain('did not start')
      expect(rec.spawned.length).toBe(1)
    } finally {
      for (const r of await readRegistry()) if (r.cwd === dir) await removeSession(r.id)
    }
  })

  test('a row already structured is left alone; a row with no conversation is refused', async () => {
    const live = tmuxRow()
    const blind = tmuxRow({ conversationId: undefined as never })
    await addSession(live)
    await addSession(blind)
    const rec = recordingBackend({ alive: [live.id, blind.id], structured: [live.id], landsStructured: true })
    __setSessionBackendForTest(rec.b)
    try {
      const host = createControlHost('en', NO_TERMINAL)
      expect(await host.backToStructured!(live.id)).toMatchObject({ ok: true, message: expect.stringContaining('already') })
      expect(await host.backToStructured!(blind.id)).toMatchObject({ ok: false })
      expect(await host.backToStructured!('m-nobody')).toMatchObject({ ok: false })
      expect(rec.killed).toEqual([])
      expect(rec.spawned).toEqual([])
    } finally {
      for (const r of await readRegistry()) if (r.cwd === dir) await removeSession(r.id)
    }
  })

  test('the fleet action `structured` reaches the host', async () => {
    const seen: string[] = []
    __setFleetHostForTest('en', { async backToStructured(id: string) { seen.push(id); return { ok: true, message: 'ok' } } } as never)
    expect(await runFleetAction('en', { action: 'structured', id: 'm-1' } as never)).toMatchObject({ ok: true })
    expect(seen).toEqual(['m-1'])
  })

  test('the fleet action `fork` reaches the host and carries the new row id back', async () => {
    const seen: string[] = []
    __setFleetHostForTest('en', { async forkSession(id: string) { seen.push(id); return { ok: true, message: 'ok', id: 'm-2' } } } as never)
    expect(await runFleetAction('en', { action: 'fork', id: 'm-1' } as never)).toMatchObject({ ok: true, id: 'm-2' })
    expect(seen).toEqual(['m-1'])
  })

  test('a fork starts a NEW row beside the original, linked to its conversation, and leaves the original alone', async () => {
    const m = tmuxRow({ harness: 'opencode', label: 'Docs', conversationId: 'ses_e70797397ffeSYPpraVLuN7l9J', task: 't-7' })
    await addSession(m)
    const rec = recordingBackend({ alive: [m.id], structured: [m.id], landsStructured: true })
    __setSessionBackendForTest(rec.b)
    try {
      const out = await createControlHost('en', NO_TERMINAL).forkSession!(m.id)
      expect(out.ok).toBe(true)
      expect(rec.spawned.length).toBe(1)
      expect(rec.killed).toEqual([])
      expect(rec.spawned[0]!.structured).toMatchObject({ harness: 'opencode', origin: 'web', forkOf: m.conversationId })
      const rows = await readRegistry()
      expect(rows.find(r => r.id === m.id)?.endedAt).toBeUndefined()
      const fresh = rows.find(r => r.id === rec.spawned[0]!.id)
      expect(fresh).toBeDefined()
      expect(fresh!.id).not.toBe(m.id)
      expect(fresh).toMatchObject({ harness: 'opencode', label: 'Docs (fork)', task: 't-7' })
      expect(out.id).toBe(fresh!.id)
    } finally {
      for (const r of await readRegistry()) if (r.cwd === dir) await removeSession(r.id)
    }
  }, 30_000)

  test('the fleet action `fork` honours `force` and, on a memory refusal, answers memoryBudget with the queue entry', async () => {
    const seen: Array<[string, boolean, boolean]> = []
    __setFleetHostForTest('en', {
      async forkSession(id: string, verified?: boolean, force?: boolean) {
        seen.push([id, verified === true, force === true])
        return force ? { ok: true, message: 'ok', id: 'm-3' } : { ok: false, message: 'low memory', memoryRefusal: { queuedId: 'q-9' } }
      },
    } as never)
    expect(await runFleetAction('en', { action: 'fork', id: 'm-1' } as never)).toMatchObject({ ok: false, memoryBudget: true, queuedId: 'q-9' })
    expect(await runFleetAction('en', { action: 'fork', id: 'm-1', force: true } as never)).toMatchObject({ ok: true, id: 'm-3' })
    expect(seen).toEqual([['m-1', false, false], ['m-1', false, true]])
  })
})
