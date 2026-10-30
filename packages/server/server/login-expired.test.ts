/**
 * HOTFIX.LOGIN-EXPIRADO — an account whose login the harness refused is marked, never a target, and
 * "Sign in again" re-binds the SAME account (id, nickname, plan, agent switch kept) in its own folder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountBudget } from '@agentistics/core'
import { accountLoginState, createHarnessAccounts, type AccountIdentity } from './harness-accounts'
import { createAccountRoots, reloginRoot, reloginSupported, type AccountRootsDeps } from './account-roots'
import { LOGIN_ADAPTERS, type LoginInfo } from './account-login'
import { withLoginState } from './accounts-web'
import { spawnRowsOf } from './sessions/spawn-account-io'
import { decideSpawnAccount } from './sessions/spawn-account'
import { allSwitchOptions, detectAuthInTail, unavailableSwitchTargets } from './sessions/account-switch'
import { decideAutoSwitch } from './sessions/auto-switch'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'login-expired-')) })
afterEach(() => rm(tmp, { recursive: true, force: true }))

const NAYARA: AccountIdentity = { key: 'org1:nayara@example.com', label: 'nayara@example.com', plan: 'pro' }

/** A registry with one account signed in to its own root under `<tmp>/accounts/claude/r_nay`. */
async function setup(probe: (h: string, root: string | null) => Promise<AccountIdentity> = async () => NAYARA) {
  let clock = 1_000
  const store = createHarnessAccounts({ file: join(tmp, 'accounts.json'), probe: probe as never, now: () => clock })
  const root = join(tmp, 'accounts', 'claude', 'r_nay')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const { account } = await store.bind(root, { harness: 'claude', ...NAYARA })
  await store.update(account.id, { nickname: 'Nayara', available: false })
  return { store, root, id: account.id, tick: (ms: number) => { clock += ms } }
}

describe('the registry mark', () => {
  test('a refusal marks the account expired; the binding stays (the files are still there)', async () => {
    const { store, id, root } = await setup()
    await store.markLoginExpired(id, 5_000)
    const file = await store.readAccounts()
    const a = file.accounts.find(x => x.id === id)!
    expect(a.loginExpiredAt).toBe(5_000)
    expect(file.bindings[`claude:${root}`]).toBe(id)
    const row = spawnRowsOf(file).find(r => r.id === id)!
    expect(row).toMatchObject({ bound: true, expired: true })
    expect(accountLoginState(a, row.bound)).toBe('expired')
  })

  test('a sign-in that finishes re-binds the SAME id and keeps nickname, plan and the agent switch', async () => {
    const { store, id, root, tick } = await setup()
    await store.markLoginExpired(id, 5_000)
    tick(10_000)
    const { account } = await store.bind(root, { harness: 'claude', ...NAYARA })
    expect(account.id).toBe(id)
    expect(account.nickname).toBe('Nayara')
    expect(account.plan).toBe('pro')
    expect(account.available).toBe(false)
    expect(account.loginExpiredAt).toBeUndefined()
    expect(account.loginRenewedAt).toBe(11_000)
  })

  test('a routine re-probe (current) proves nothing: the mark survives it', async () => {
    const { store, id, root } = await setup()
    await store.markLoginExpired(id, 5_000)
    await store.current('claude', root)
    expect((await store.byId(id))!.loginExpiredAt).toBe(5_000)
  })

  test('the old token\'s refusal, written before the new sign-in, does not mark again', async () => {
    const { store, id, root, tick } = await setup()
    tick(10_000)
    await store.bind(root, { harness: 'claude', ...NAYARA }) // renewed at 11_000
    await store.markLoginExpired(id, 9_000)
    expect((await store.byId(id))!.loginExpiredAt).toBeUndefined()
    await store.markLoginExpired(id, 12_000)
    expect((await store.byId(id))!.loginExpiredAt).toBe(12_000)
    await store.clearLoginExpired(id)
    expect((await store.byId(id))!.loginExpiredAt).toBeUndefined()
  })

  test('GET /api/accounts carries the state and whether "Sign in again" can run', async () => {
    const { store, id } = await setup()
    await store.markLoginExpired(id, 5_000)
    const file = await store.readAccounts()
    const [a] = withLoginState(file.accounts, file)
    expect(a).toMatchObject({ id, login: 'expired', relogin: true })
    await store.clearLoginExpired(id)
    const again = await store.readAccounts()
    expect(withLoginState(again.accounts, again)[0]).toMatchObject({ login: 'ok' })
    expect(withLoginState(again.accounts, again)[0]!.relogin).toBeUndefined()
  })
})

describe('reloginSupported / reloginRoot', () => {
  test('own root: any harness that can move its folder and has a recipe; default folder: probed harnesses but gemini', () => {
    expect(reloginSupported({ harness: 'claude', root: '/r' })).toBe(true)
    expect(reloginSupported({ harness: 'codex', root: null })).toBe(true)
    expect(reloginSupported({ harness: 'gemini', root: null })).toBe(false)
    expect(reloginSupported({ harness: 'gemini', root: '/r' })).toBe(true)
    expect(reloginSupported({ harness: 'antigravity', root: null })).toBe(false)
    expect(reloginSupported({ harness: 'claude', root: '/r', retired: true })).toBe(false)
  })
  test('the binding names the folder; its own root wins over the default one', () => {
    const a = { id: 'x', harness: 'claude' as const, root: '/r' }
    expect(reloginRoot({ bindings: { 'claude:': 'x', 'claude:/r': 'x' } }, a)).toBe('/r')
    expect(reloginRoot({ bindings: { 'claude:': 'x' } }, { ...a, root: null })).toBeNull()
    expect(reloginRoot({ bindings: {} }, a)).toBe('/r')
  })
})

describe('Sign in again (account-roots)', () => {
  /** A fake CLI: the test decides when it exits, and with what. */
  function fakeLogin() {
    let exit!: (code: number) => void
    const exited = new Promise<number>(r => { exit = r })
    const requests: { root: string; env: Record<string, string> }[] = []
    const login: NonNullable<AccountRootsDeps['login']> = async (req, _onFailure, opts) => {
      requests.push({ root: req.root, env: req.env })
      // The real login goes through `opts.launch`; the fake does too, so the exit is observed.
      if (opts?.launch) await opts.launch(req)
      const info: LoginInfo = { kind: LOGIN_ADAPTERS.claude!.kind, url: 'https://claude.ai/oauth/authorize', expiresAt: Date.now() + 900_000 }
      return { ready: Promise.resolve(info), info: () => info, submit: async () => {}, stop: async () => {} }
    }
    return { login, exit: (c: number) => exit(c), requests, exited }
  }

  test('runs the login IN the account\'s folder and re-binds the same id once the CLI ends with 0', async () => {
    const { store, id, root } = await setup()
    await store.markLoginExpired(id, 5_000)
    const cli = fakeLogin()
    const roots = createAccountRoots({
      base: join(tmp, 'accounts'), flagOn: () => true,
      login: cli.login,
      loginOptions: { launch: async () => ({ read: async () => null, write: async () => {}, stop: async () => {}, exited: cli.exited }) },
      probe: async () => NAYARA, registerMcp: async () => {}, audit: async () => {},
      bind: (r, i) => store.bind(r, i), getAccount: x => store.byId(x), listAccounts: () => store.readAccounts(),
    })
    const out = await roots.relogin(id)
    expect(out.ok).toBe(true)
    expect(cli.requests[0]).toEqual({ root, env: { CLAUDE_CONFIG_DIR: root } })
    // The probe already names Nayara (an expired token still names its owner): not proof of a new login.
    await roots.pollRelogins()
    expect(roots.reloginStatus(id)?.status).toBe('pending')
    expect((await store.byId(id))!.loginExpiredAt).toBe(5_000)
    cli.exit(0)
    await Bun.sleep(5)
    await roots.pollRelogins()
    expect(roots.reloginStatus(id)).toEqual({ status: 'done', accountId: id, boundId: id, same: true })
    const after = (await store.readAccounts()).accounts
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id, nickname: 'Nayara', plan: 'pro', available: false, root })
    expect(after[0]!.loginExpiredAt).toBeUndefined()
    roots.stopPoller()
  })

  test('a CLI that fails never binds', async () => {
    const { store, id } = await setup()
    await store.markLoginExpired(id, 5_000)
    const cli = fakeLogin()
    const roots = createAccountRoots({
      base: join(tmp, 'accounts'), flagOn: () => true, login: cli.login,
      loginOptions: { launch: async () => ({ read: async () => null, write: async () => {}, stop: async () => {}, exited: cli.exited }) },
      probe: async () => NAYARA, registerMcp: async () => {}, audit: async () => {},
      bind: (r, i) => store.bind(r, i), getAccount: x => store.byId(x), listAccounts: () => store.readAccounts(),
    })
    await roots.relogin(id)
    cli.exit(1)
    await Bun.sleep(5)
    await roots.pollRelogins()
    expect(roots.reloginStatus(id)?.status).toBe('pending')
    expect((await store.byId(id))!.loginExpiredAt).toBe(5_000)
    expect(await roots.cancelRelogin(id)).toBe(true)
    expect(roots.reloginStatus(id)).toBeNull()
    roots.stopPoller()
  })

  test('refused in words: unknown, removed, or a folder that is not an account folder', async () => {
    const { store, id } = await setup()
    const roots = createAccountRoots({
      base: join(tmp, 'elsewhere'), flagOn: () => true, registerMcp: async () => {}, audit: async () => {},
      getAccount: x => store.byId(x), listAccounts: () => store.readAccounts(),
    })
    expect(await roots.relogin('acc_nobody')).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await roots.relogin(id)).toMatchObject({ ok: false, reason: 'unsafe_path' })
    await store.retire(id)
    expect(await roots.relogin(id)).toMatchObject({ ok: false, reason: 'retired' })
  })
})

describe('an expired account is never a target', () => {
  const rows = [
    { id: 'a', harness: 'claude' as const, root: null, bound: true, available: true, firstSeen: 1 },
    { id: 'nay', harness: 'claude' as const, root: '/r/nay', bound: true, available: true, expired: true as const, firstSeen: 2 },
    { id: 'c', harness: 'claude' as const, root: '/r/c', bound: true, available: true, firstSeen: 3 },
  ]
  const context = { enabled: true, accounts: rows }

  test('a spawn naming it is refused (signed out), an automatic one never lands on it', () => {
    expect(decideSpawnAccount({ harness: 'claude', requested: 'nay', agentCaller: false, context })).toMatchObject({ ok: false, reason: 'account_signed_out' })
    expect(decideSpawnAccount({ harness: 'claude', agentCaller: true, context: { ...context, picks: { claude: 'nay' } } })).toMatchObject({ ok: true, account: { id: 'a' } })
  })

  test('the switch does not offer it, and says why in its own word', () => {
    const offered = allSwitchOptions({ harness: 'claude', currentAccountId: 'a', agentCaller: false, context, meta: [], startable: ['claude'] })
    expect(offered.map(o => o.id)).toEqual(['c'])
    const why = unavailableSwitchTargets({ harness: 'claude', currentAccountId: 'a', context, meta: [], startable: ['claude'], offered })
    expect(why).toEqual([{ id: 'nay', harness: 'claude', label: 'nay', reason: 'login_expired' }])
  })

  test('auto-switch treats it as no room even when its budget shows room and a caller offers it', () => {
    const NOW = Date.parse('2026-10-30T12:00:00Z')
    const row = (account: string, o: Partial<AccountBudget> = {}) => ({
      harness: 'claude', plan: 'max', account, fiveHourPct: 5, weekPct: 5, weekResetsAt: NOW + 86_400_000, daysToWeekReset: 1, dailyBudgetPct: 20,
      status: 'ok', updatedAt: NOW, stale: false, spawnable: true, ...o,
    }) as AccountBudget
    const input = {
      enabled: true, now: NOW, harness: 'claude' as const, supported: true, currentAccount: 'a',
      limit: { resetsAt: NOW + 3 * 3_600_000 }, options: [{ id: 'nay', harness: 'claude' as const, label: 'Nayara' }],
      budgets: [row('a', { fiveHourPct: 100 }), row('nay')],
    }
    expect(decideAutoSwitch(input).kind).toBe('move')
    expect(decideAutoSwitch({ ...input, expired: new Set(['nay']) }).kind).toBe('none')
  })
})

describe('detectAuthInTail', () => {
  const user = (text: string, ts: string) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
  const reply = (ts: string) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'ok' }] } })
  const refused = (ts: string) => JSON.stringify({
    type: 'assistant', timestamp: ts, isApiErrorMessage: true, error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Your session has expired. Please run /login to sign in again.' }] },
  })

  test('claude: the last turn refused by the login, with the prompt it swallowed', () => {
    const out = detectAuthInTail('claude', [reply('2026-10-30T10:00:00Z'), user('faça X', '2026-10-30T10:01:00Z'), refused('2026-10-30T10:01:01Z')])
    expect(out.auth).toEqual({ at: Date.parse('2026-10-30T10:01:01Z'), message: 'Your session has expired. Please run /login to sign in again.', pendingPrompt: 'faça X' })
    expect(out.answeredAt).toBe(Date.parse('2026-10-30T10:00:00Z'))
  })

  test('claude: a real reply after it clears it (the person ran /login inside the session)', () => {
    const out = detectAuthInTail('claude', [refused('2026-10-30T10:01:01Z'), user('de novo', '2026-10-30T10:02:00Z'), reply('2026-10-30T10:02:05Z')])
    expect(out.auth).toBeNull()
    expect(out.answeredAt).toBe(Date.parse('2026-10-30T10:02:05Z'))
  })

  test('claude: a usage limit or a server error is not a login refusal', () => {
    const limit = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiError: 'usage_limit_reached', message: { content: [{ type: 'text', text: 'limit' }] } })
    expect(detectAuthInTail('claude', [limit]).auth).toBeNull()
  })

  test('codex: an unauthorized error, then a completed turn clears it', () => {
    const err = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-30T10:00:00Z', payload: { type: 'error', message: 'Your access token could not be refreshed. Please log out and sign in again.', error: { codex_error_info: 'unauthorized' } } })
    const prompt = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'rode os testes' } })
    expect(detectAuthInTail('codex', [prompt, err]).auth).toMatchObject({ pendingPrompt: 'rode os testes' })
    const done = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-30T10:05:00Z', payload: { type: 'task_complete' } })
    expect(detectAuthInTail('codex', [prompt, err, done]).auth).toBeNull()
  })

  test('a harness whose refusal was never captured never raises it', () => {
    expect(detectAuthInTail('gemini', [refused('2026-10-30T10:01:01Z')]).auth).toBeNull()
  })
})
