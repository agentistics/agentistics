/**
 * Hermes is structured-only (ACP), and that restriction is about the TERMINAL: a plan for Hermes must
 * still exist, because every structured door (`agentop session hermes --bg`, `POST /api/fleet/new`,
 * a reopen) plans first and only then hands the request to the structured backend. A guard inside
 * `planSpawn` refused all of them (2.207.0 regression); the refusal now lives where a plan would
 * become a tmux launch (`withStructured.spawn`).
 *
 * These tests drive the real functions down to a backend, with no real `hermes` binary: the structured
 * stage is a recorder, and the tmux stage is a recorder that must stay untouched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnManaged } from '../cli-start'
import { cliStrings } from '../cli-i18n'
import { start } from './cli-session'
import { __setFleetHostForTest, runFleetSpawn } from './fleet-web'
import { __setSessionBackendForTest } from './index'
import { readRegistry, removeSession } from './registry'
import { resetHarnessAvailability } from './harness-available'
import type { BackendSpawn, SessionBackend } from './types'
import { isolateAgentEnv } from './agent-env.testing'

isolateAgentEnv({})

let dir = ''
let savedPath: string | undefined
const created: string[] = []

/** What the structured stage received, and what a tmux launch would have received. */
const structuredSpawns: BackendSpawn[] = []
const tmuxSpawns: BackendSpawn[] = []

/**
 * A backend standing in for the whole composite: a request that carries a structured intent for a web or
 * background origin is "taken by the structured driver" (recorded, row stays); anything else is
 * recorded as a tmux launch. The attached refusal itself is proven on the REAL composite in
 * `structured-backend.test.ts` ("attached Hermes spawn refuses with the ACP-only sentence…"), so
 * it is not restated here against a fake.
 */
const backend = {
  id: 'tmux',
  unavailable: async () => undefined,
  spawn: async (req: BackendSpawn) => {
    created.push(req.id)
    const origin = req.structured?.origin
    if (origin === 'web' || origin === 'background') { structuredSpawns.push(req); return }
    tmuxSpawns.push(req)
  },
  list: async () => created.map(id => ({ id, createdMs: 1, attached: false, alive: true, lastActivityMs: 1 })),
  capture: async () => [], kill: async () => {}, detachHint: async () => 'C-b d',
} as unknown as SessionBackend


async function quiet<T>(f: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error
  console.log = () => {}; console.error = () => {}
  try { return await f() } finally { console.log = log; console.error = err }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-start-'))
  // A `hermes` the host can find on PATH, so the harness reads as startable. It is never executed.
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
  structuredSpawns.length = 0
  tmuxSpawns.length = 0
})
afterAll(() => {
  __setSessionBackendForTest(null)
  __setFleetHostForTest('en', null)
  if (savedPath !== undefined) process.env.PATH = savedPath
  resetHarnessAvailability()
  rmSync(dir, { recursive: true, force: true })
})

describe('Hermes structured doors', () => {
  test('hermes --bg plans a structured spawn and creates the session', async () => {
    const code = await quiet(() => start(
      { kind: 'start', harness: 'hermes', background: true, prompt: 'hello', cwd: dir, force: true, sharedCwd: true, json: true } as Parameters<typeof start>[0],
      backend, { settleMs: 0 },
    ))
    expect(code).toBe(0)
    expect(structuredSpawns).toHaveLength(1)
    expect(tmuxSpawns).toEqual([])
    expect(structuredSpawns[0]!.structured).toMatchObject({ harness: 'hermes', origin: 'background' })
    const row = (await readRegistry()).find(r => r.id === structuredSpawns[0]!.id)
    expect(row?.harness).toBe('hermes')
  })

  test('POST /api/fleet/new with harness hermes from the web starts a structured session', async () => {
    __setFleetHostForTest('en', null)
    const out = await quiet(() => runFleetSpawn('en', { harness: 'hermes', cwd: dir, prompt: 'hi' } as never))
    expect(out).toMatchObject({ ok: true })
    expect(structuredSpawns).toHaveLength(1)
    expect(structuredSpawns[0]!.structured).toMatchObject({ harness: 'hermes', origin: 'web' })
    expect(tmuxSpawns).toEqual([])
  }, 30_000)

  test('reopen of a structured Hermes row resumes through the structured backend', async () => {
    // Resume plans first (`planSpawn` with a resume id); a background reopen then goes to the structured
    // driver, never to a terminal. (The terminal route is refused by `withStructured.spawn`, tested in structured-backend.test.ts.)
    const out = await quiet(() => spawnManaged(
      { harness: 'hermes', cwd: dir, attach: false, origin: 'background', resumeId: 'hermes-conv-1', skipAdmission: true },
      cliStrings('en'), 'en',
    ))
    expect(out.ok).toBe(true)
    expect(structuredSpawns).toHaveLength(1)
    expect(structuredSpawns[0]!.structured).toMatchObject({ harness: 'hermes', resumeId: 'hermes-conv-1' })
    expect(tmuxSpawns).toEqual([])
  })
})
