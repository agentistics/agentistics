/**
 * An owner session is spoken to through the structured protocol only. When the harness comes up as a
 * terminal (no driver, flag off) `spawnManaged` must stop it, remove its row and refuse the start —
 * the engine then keeps its own private conversation. The backend here is a recorder (no real binary).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnManaged } from '../cli-start'
import { cliStrings } from '../cli-i18n'
import { __setSessionBackendForTest } from './index'
import { readRegistry, removeSession } from './registry'
import { resetHarnessAvailability } from './harness-available'
import type { BackendSpawn, SessionBackend } from './types'
import { isolateAgentEnv } from './agent-env.testing'

isolateAgentEnv({})

let dir = ''
let savedPath: string | undefined
const created: string[] = []
const killed: string[] = []
let structured = false

const backend = {
  id: 'tmux',
  unavailable: async () => undefined,
  spawn: async (req: BackendSpawn) => { created.push(req.id) },
  list: async () => created.map(id => ({ id, createdMs: 1, attached: false, alive: true, lastActivityMs: 1 })),
  capture: async () => [], kill: async (id: string) => { killed.push(id) }, detachHint: async () => 'C-b d',
  isStructured: () => structured,
} as unknown as SessionBackend

async function quiet<T>(f: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error
  console.log = () => {}; console.error = () => {}
  try { return await f() } finally { console.log = log; console.error = err }
}

const open = () => quiet(() => spawnManaged(
  { harness: 'hermes', cwd: dir, attach: false, origin: 'background', skipAdmission: true, ownerSession: {} },
  cliStrings('en'), 'en',
))

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-tui-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'hermes'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'hermes'), 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${bin}:${savedPath ?? ''}`
  resetHarnessAvailability()
  __setSessionBackendForTest(backend)
})
afterEach(async () => {
  for (const id of created.splice(0)) await removeSession(id).catch(() => {})
  killed.length = 0
  structured = false
})
afterAll(() => {
  __setSessionBackendForTest(null)
  if (savedPath !== undefined) process.env.PATH = savedPath
  resetHarnessAvailability()
  rmSync(dir, { recursive: true, force: true })
})

describe('owner session over a terminal harness', () => {
  test('a harness that came up as a terminal is killed, its row removed, and the start refused', async () => {
    structured = false
    const out = await open()
    expect(out.ok).toBe(false)
    expect(out.message).toContain('structured protocol')
    expect(created).toHaveLength(1)
    expect(killed).toEqual(created)
    expect((await readRegistry()).some(r => r.id === created[0])).toBe(false)
  }, 30_000)

  test('a structured one is kept (the refusal is only for the terminal fallback)', async () => {
    structured = true
    const out = await open()
    expect(out.ok).toBe(true)
    expect(killed).toEqual([])
    expect((await readRegistry()).some(r => r.id === created[0])).toBe(true)
  }, 30_000)
})
