/**
 * PLAN.ACCOUNTS D3 (fix2) — the HOST doors a static re-QA found still open, driven through the real
 * host with a recording backend and an isolated registry:
 *  1. a GROUP reopen carries the verified caller to every spawn (an agent cannot reopen an OFF account);
 *  2. a resume with no `replaces` (external continuation / resume) takes the account of the newest
 *     registry row of that conversation — a signed-out one refuses, never the default root;
 *  3. a retired account still bound to the default root is that root's login: an agent is refused;
 *  4. an account refusal keeps its code through host/fleet results (the route maps it to a status).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlHost, reopenRowRequest, spawnManaged } from '../cli-start'
import { cliStrings } from '../cli-i18n'
import { __setHarnessAccountsForTest, createHarnessAccounts } from '../harness-accounts'
import { __setSessionBackendForTest } from './index'
import { __setFleetHostForTest, runFleetAction, runFleetSpawn } from './fleet-web'
import { addSession, removeSession } from './registry'
import { newestRowOfConversation } from './spawn-account-io'
import { __setSpawnBudgetForTest } from './memory-probe'
import { exactLinksOnDisk } from './reopen-link'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { resetHarnessAvailability } from './harness-available'
import { spawnAccountStatus } from './spawn-account'
import type { ManagedSession, SessionBackend } from './types'

let dir = ''
let savedFlag: string | undefined
const spawned: string[] = []

const backend = {
  id: 'tmux', unavailable: async () => undefined,
  spawn: async (req: { id: string }) => { spawned.push(req.id); throw new Error('pane refused') },
  list: async () => [], capture: async () => [], kill: async () => {},
} as unknown as SessionBackend

const NO_TERMINAL = { async suspend<T>(_fn: () => Promise<T>): Promise<T> { throw new Error('no terminal') } }

/** A fresh registry of accounts for one scenario. */
async function accounts(build: (store: ReturnType<typeof createHarnessAccounts>) => Promise<void>) {
  const store = createHarnessAccounts({ file: join(mkdtempSync(join(dir, 'acc-')), 'accounts.json'), probe: async () => ({ key: 'default', label: 'x' }) })
  __setHarnessAccountsForTest(store)
  await build(store)
  return store
}

const row = (extra: Partial<ManagedSession>): ManagedSession =>
  ({ id: `m-${Math.random().toString(16).slice(2, 10)}`, harness: 'claude', cwd: dir, createdAt: new Date().toISOString(), ...extra }) as ManagedSession

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'acct-d3-fix2-'))
  savedFlag = process.env.AGENTISTICS_MULTI_ACCOUNT
  process.env.AGENTISTICS_MULTI_ACCOUNT = '1'
  __setSessionBackendForTest(backend)
  // The reopen lock asks `claude agents --json`; the machine's real CLI is not part of this test.
  __setHarnessAgentsReaderForTest(async () => [])
})
afterEach(() => { spawned.length = 0 })
afterAll(() => {
  __setSessionBackendForTest(null)
  __setHarnessAgentsReaderForTest(null)
  __setFleetHostForTest('en', null)
  if (savedFlag === undefined) delete process.env.AGENTISTICS_MULTI_ACCOUNT
  else process.env.AGENTISTICS_MULTI_ACCOUNT = savedFlag
  rmSync(dir, { recursive: true, force: true })
})

describe('1 · group reopen carries the verified caller to every spawn', () => {
  test('each row\'s spawn request carries the caller and the record (its account)', () => {
    const m = row({ accountId: 'acc_a', task: 't' })
    const agent = reopenRowRequest(m, { resumeId: 'c-1', label: 'L' }, { callerVerified: true })
    expect(agent.callerVerified).toBe(true)
    expect(agent.inherit).toBe(m)
    expect(reopenRowRequest(m, { resumeId: 'c-1', label: 'L' }).callerVerified).toBeUndefined()
  })

  test('an agent reopening a row on an account now OFF for agents is refused; the owner is not', async () => {
    let offId = ''
    await accounts(async store => {
      await store.bind(null, { harness: 'claude', key: 'org:home', label: 'home' })
      offId = (await store.bind(join(dir, 'r_off'), { harness: 'claude', key: 'org:off', label: 'off' })).account.id
      await store.update(offId, { available: false })
    })
    const m = row({ accountId: offId, conversationId: 'c-off' })
    const s = cliStrings('en')
    const agent = await spawnManaged(reopenRowRequest(m, { resumeId: 'c-off', label: 'L' }, { callerVerified: true }), s, 'en')
    expect(agent).toMatchObject({ ok: false, accountRefusal: 'account_unavailable' })
    expect(spawned).toEqual([])
    const owner = await spawnManaged(reopenRowRequest(m, { resumeId: 'c-off', label: 'L' }), s, 'en')
    expect(owner.accountRefusal).toBeUndefined()
  })

  test('the fleet route hands the verified caller to the group reopen and keeps the refusal code', async () => {
    const seen: unknown[] = []
    const host = {
      async reopenFell(ids?: readonly string[], caller?: { callerVerified?: boolean }) {
        seen.push({ ids, caller })
        return { ok: false, message: 'refused', accountRefusal: 'account_unavailable' as const }
      },
    }
    __setFleetHostForTest('en', host as never)
    const out = await runFleetAction('en', { action: 'reopenFell', id: '', ids: ['a'], callerVerified: true } as never)
    expect(seen).toEqual([{ ids: ['a'], caller: { callerVerified: true } }])
    expect(out).toMatchObject({ ok: false, code: 'account_unavailable' })
    expect('accountRefusal' in out).toBe(false)
    await runFleetAction('en', { action: 'reopenFell', id: '', ids: ['a'] } as never)
    expect(seen[1]).toEqual({ ids: ['a'], caller: {} })
    __setFleetHostForTest('en', null)
  })
})

describe('2 · a resume with no `replaces` takes the conversation\'s recorded account', () => {
  test('the newest row of the conversation is the record', () => {
    const older = row({ conversationId: 'c', accountId: 'old', createdAt: '2026-10-01T00:00:00Z' })
    const newer = row({ conversationId: 'c', accountId: 'new', createdAt: '2026-10-02T00:00:00Z' })
    const other = row({ conversationId: 'c', harness: 'codex', accountId: 'x', createdAt: '2026-10-03T00:00:00Z' })
    expect(newestRowOfConversation([older, newer, other], 'c', 'claude')?.accountId).toBe('new')
    expect(newestRowOfConversation([older], 'nope')).toBeUndefined()
  })

  test('a signed-out recorded account refuses (agent and owner) before anything is ended or spawned', async () => {
    let aId = ''
    await accounts(async store => {
      await store.bind(null, { harness: 'claude', key: 'org:home', label: 'home' })
      aId = (await store.bind(join(dir, 'r_a'), { harness: 'claude', key: 'org:a', label: 'a' })).account.id
      // Another login takes A's root: A is signed out everywhere, the default stays signed in.
      await store.bind(join(dir, 'r_a'), { harness: 'claude', key: 'org:b', label: 'b' })
    })
    const conversationId = `c-${Date.now()}`
    const recorded = row({ conversationId, accountId: aId, endedAt: new Date().toISOString() })
    await addSession(recorded)
    try {
      const host = createControlHost('en', NO_TERMINAL)
      for (const callerVerified of [true, false]) {
        const out = await host.resumeSession!({
          sessionId: conversationId, harness: 'claude', cwd: dir, label: 'L', attach: false, prompt: 'go',
          ...(callerVerified ? { callerVerified } : {}),
        })
        expect(out).toMatchObject({ ok: false, accountRefusal: 'account_signed_out' })
      }
      expect(spawned).toEqual([])
    } finally { await removeSession(recorded.id) }
  })

  test('a conversation agentop never ran keeps the default root (no account refusal for the owner)', async () => {
    await accounts(async store => { await store.bind(null, { harness: 'claude', key: 'org:home', label: 'home' }) })
    const host = createControlHost('en', NO_TERMINAL)
    const out = await host.resumeSession!({ sessionId: `c-unrec-${Date.now()}`, harness: 'claude', cwd: dir, label: 'L', attach: false })
    expect(out.accountRefusal).toBeUndefined()
  })

  test('an external continuation answers the refusal code', async () => {
    const host = {
      async promptSession() { throw new Error('an external row has no pane') },
      async sessions() { return { sessions: [{ id: 'external:1', harness: 'claude', cwd: dir, title: 'x', conversationId: 'c-ext' }] } },
      async resumeSession() { return { ok: false, message: 'signed out', accountRefusal: 'account_signed_out' as const } },
    }
    __setFleetHostForTest('en', host as never)
    const out = await runFleetAction('en', { action: 'prompt', id: 'external:1', text: 'hi', confirm: true, callerVerified: true } as never)
    expect(out).toMatchObject({ ok: false, code: 'account_signed_out' })
    __setFleetHostForTest('en', null)
  })
})

describe('3 · a retired account bound to the default root is that root\'s login', () => {
  for (const flag of ['1', '0']) {
    test(`flag ${flag === '1' ? 'on' : 'off'}: an agent's default launch is refused; the owner's is not`, async () => {
      process.env.AGENTISTICS_MULTI_ACCOUNT = flag
      try {
        let aId = ''
        await accounts(async store => {
          aId = (await store.bind(null, { harness: 'claude', key: 'org:a', label: 'a' })).account.id
          await store.retire(aId)
        })
        const s = cliStrings('en')
        const agent = await spawnManaged({ harness: 'claude', cwd: dir, attach: false, skipAdmission: true, callerVerified: true }, s, 'en')
        expect(agent).toMatchObject({ ok: false, accountRefusal: 'account_unavailable' })
        expect(spawned).toEqual([])
        const owner = await spawnManaged({ harness: 'claude', cwd: dir, attach: false, skipAdmission: true }, s, 'en')
        expect(owner.accountRefusal).toBeUndefined()
        const { hostSpawnAccount } = await import('./spawn-account-io')
        expect(await hostSpawnAccount({ harness: 'claude', callerVerified: true }, 'en')).toMatchObject({ ok: false, reason: 'account_unavailable' })
        // A pre-account row reopened by an agent meets the same login.
        const old = row({ conversationId: 'c-pre' })
        expect((await spawnManaged(reopenRowRequest(old, { resumeId: 'c-pre', label: 'L' }, { callerVerified: true }), s, 'en')).accountRefusal).toBe('account_unavailable')
      } finally { process.env.AGENTISTICS_MULTI_ACCOUNT = '1' }
    })
  }
})

describe('4 · account refusals keep their code through the fleet results', () => {
  test('resume returns the code', async () => {
    const host = {
      async sessions() { return { sessions: [{ id: 'm1', harness: 'claude', cwd: dir, title: 'x', named: false, actionable: true, resume: { sessionId: 'c', title: 't' } }] } },
      async resumeSession() { return { ok: false, message: 'signed out', accountRefusal: 'account_signed_out' as const } },
    }
    __setFleetHostForTest('en', host as never)
    expect(await runFleetAction('en', { action: 'resume', id: 'm1' } as never)).toMatchObject({ ok: false, code: 'account_signed_out' })
    __setFleetHostForTest('en', null)
  })

  test('a fresh spawn refused by the host\'s final recheck (Nay included) returns the code', async () => {
    const host = {
      async startableHarnesses() { return [{ id: 'claude', supportsModel: true, efforts: [] }] },
      async spawnSession() { return { ok: false, message: 'signed out', accountRefusal: 'account_signed_out' as const } },
    }
    __setFleetHostForTest('en', host as never)
    expect(await runFleetSpawn('en', { harness: 'claude', cwd: dir } as never)).toMatchObject({ ok: false, code: 'account_signed_out' })
    __setFleetHostForTest('en', null)
  })
})

describe('5 · a group reopen with mixed results keeps every typed refusal (D3 fix3)', () => {
  test('the real host: one row refused for its account, one reopened — an explicit partial result', async () => {
    let aId = ''
    let cId = ''
    await accounts(async store => {
      await store.bind(null, { harness: 'claude', key: 'org:home', label: 'home' })
      aId = (await store.bind(join(dir, 'r_a5'), { harness: 'claude', key: 'org:a5', label: 'a5' })).account.id
      await store.bind(join(dir, 'r_a5'), { harness: 'claude', key: 'org:b5', label: 'b5' }) // A signed out
      cId = (await store.bind(join(dir, 'r_c5'), { harness: 'claude', key: 'org:c5', label: 'c5' })).account.id
    })
    const stamp = Date.now()
    const convA = `c-mixA-${stamp}`
    const convC = `c-mixC-${stamp}`
    const rowA = row({ conversationId: convA, accountId: aId, lastSeenMs: stamp })
    const rowC = row({ conversationId: convC, accountId: cId, lastSeenMs: stamp })
    await addSession(rowA)
    await addSession(rowC)
    // Prime the reopen-link memo: both transcripts "exist", so the rows resolve without a tree on disk.
    await exactLinksOnDisk([rowA, rowC], [], Date.now(), async () => '/tmp/x.jsonl')
    const alive = new Set<string>()
    const live = {
      id: 'tmux', unavailable: async () => undefined,
      spawn: async (req: { id: string }) => { spawned.push(req.id); alive.add(req.id) },
      list: async () => [...alive].map(id => ({ id, alive: true, exited: false, status: 0 })),
      capture: async () => [], kill: async () => {},
      attachCommand: () => [], detachHint: async () => 'x',
    } as unknown as SessionBackend
    __setSessionBackendForTest(live)
    __setSpawnBudgetForTest({ value: null })
    // The reopen plans a real spawn, which needs the harness CLI on PATH: a stub, so the test does not
    // depend on the machine having `claude` installed (CI does not).
    const bin = join(dir, 'bin5')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, 'claude'), 0o755)
    const pathBefore = process.env.PATH
    process.env.PATH = `${bin}:${pathBefore ?? ''}`
    resetHarnessAvailability()
    try {
      const host = createControlHost('en', NO_TERMINAL)
      const out = await host.reopenFell!(undefined, { callerVerified: true })
      expect(spawned.length).toBe(1)
      expect(out.ok).toBe(false)
      expect(out.accountRefusal).toBe('account_signed_out')
      expect(out.fell?.opened).toEqual([rowC.id])
      expect(out.fell?.refused.map(r => [r.id, r.reason])).toEqual([[rowA.id, 'account_signed_out']])
      expect(out.fell?.refused[0]!.message).toBeTruthy()
      expect(out.message).toContain(out.fell!.refused[0]!.message)
    } finally {
      process.env.PATH = pathBefore
      resetHarnessAvailability()
      __setSessionBackendForTest(backend)
      __setSpawnBudgetForTest(null)
      await removeSession(rowA.id)
      await removeSession(rowC.id)
    }
  })

  test('the HTTP status mapping: the fleet result carries the code and the partial list; each code has its status', async () => {
    const fell = { opened: ['n1'], already: [], refused: [{ id: 'a', reason: 'account_signed_out' as const, message: 'm' }] }
    __setFleetHostForTest('en', { async reopenFell() { return { ok: false, message: 'p', accountRefusal: 'account_signed_out' as const, fell } } } as never)
    const out = await runFleetAction('en', { action: 'reopenFell', id: '' } as never)
    expect(out).toMatchObject({ ok: false, code: 'account_signed_out', fell })
    expect(spawnAccountStatus(out.code!)).toBe(409)
    expect(spawnAccountStatus('account_retired')).toBe(409)
    expect(spawnAccountStatus('account_unavailable')).toBe(403)
    __setFleetHostForTest('en', null)
  })
})
