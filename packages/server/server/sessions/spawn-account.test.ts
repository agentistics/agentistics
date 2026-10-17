import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER, type AccountBudget, type HarnessId } from '@agentistics/core'
import { spawnRowsOf } from './spawn-account-io'
import {
  decideRecordedAccount, decideSpawnAccount, routerPicks, spawnAccountMessage, spawnAccountStatus,
  type SpawnAccountContext, type SpawnAccountRow,
} from './spawn-account'

const row = (harness: HarnessId, id: string, root: string | null, extra: Partial<SpawnAccountRow> = {}): SpawnAccountRow =>
  ({ id, harness, root, bound: true, available: true, firstSeen: 1, ...extra })
const on = (accounts: SpawnAccountRow[], picks: SpawnAccountContext['picks'] = {}): SpawnAccountContext =>
  ({ enabled: true, accounts, picks })

describe('decideSpawnAccount — every harness alike', () => {
  for (const h of HARNESS_ORDER) {
    const home = row(h, `${h}-home`, null)
    const second = row(h, `${h}-2`, `/data/accounts/${h}/r_2`, { firstSeen: 2 })
    const hidden = row(h, `${h}-off`, `/data/accounts/${h}/r_3`, { available: false, firstSeen: 3 })

    test(`${h}: flag off resolves nothing and refuses an explicit account in words`, () => {
      expect(decideSpawnAccount({ harness: h, agentCaller: false, context: { enabled: false, accounts: [home, second] } })).toEqual({ ok: true })
      expect(decideSpawnAccount({ harness: h, requested: second.id, agentCaller: false, context: { enabled: false, accounts: [second] } }))
        .toEqual({ ok: false, reason: 'accounts_disabled', detail: second.id })
    })

    test(`${h}: an explicit account runs in its root`, () => {
      expect(decideSpawnAccount({ harness: h, requested: second.id, agentCaller: true, context: on([home, second]) }))
        .toEqual({ ok: true, account: { id: second.id, root: second.root } })
    })

    test(`${h}: an agent asking for a hidden account is refused 403, the owner is not`, () => {
      const agent = decideSpawnAccount({ harness: h, requested: hidden.id, agentCaller: true, context: on([home, hidden]) })
      expect(agent).toEqual({ ok: false, reason: 'account_unavailable', detail: hidden.id })
      expect(spawnAccountStatus('account_unavailable')).toBe(403)
      expect(decideSpawnAccount({ harness: h, requested: hidden.id, agentCaller: false, context: on([home, hidden]) }))
        .toEqual({ ok: true, account: { id: hidden.id, root: hidden.root } })
    })

    test(`${h}: an unknown id (or another harness's) is 422, never the default root`, () => {
      expect(decideSpawnAccount({ harness: h, requested: 'acc_nope', agentCaller: false, context: on([home]) }))
        .toEqual({ ok: false, reason: 'unknown_account', detail: 'acc_nope' })
      const other = HARNESS_ORDER.find(x => x !== h)!
      expect(decideSpawnAccount({ harness: other, requested: second.id, agentCaller: false, context: on([second]) }).ok).toBe(false)
      expect(spawnAccountStatus('unknown_account')).toBe(422)
    })

    test(`${h}: a retired account starts nothing`, () => {
      const gone = row(h, `${h}-gone`, `/data/accounts/${h}/r_9`, { retired: true })
      expect(decideSpawnAccount({ harness: h, requested: gone.id, agentCaller: false, context: on([home, gone]) }))
        .toEqual({ ok: false, reason: 'account_retired', detail: gone.id })
    })

    test(`${h}: no account → the router's pick when it is visible`, () => {
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([home, second], { [h]: second.id }) }))
        .toEqual({ ok: true, account: { id: second.id, root: second.root } })
    })

    test(`${h}: the automatic pick never lands on a hidden account`, () => {
      // A (stale) pick naming a hidden account is ignored; the visible default root wins.
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([home, hidden], { [h]: hidden.id }) }))
        .toEqual({ ok: true, account: { id: home.id, root: null } })
      // Default root hidden: the oldest visible account takes it.
      const homeOff = { ...home, available: false }
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([homeOff, hidden, second]) }))
        .toEqual({ ok: true, account: { id: second.id, root: second.root } })
      // Nothing visible: an agent is refused, the owner keeps the default root.
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([homeOff, hidden]) }))
        .toEqual({ ok: false, reason: 'account_unavailable', detail: home.id })
      expect(decideSpawnAccount({ harness: h, agentCaller: false, context: on([homeOff, hidden]) }))
        .toEqual({ ok: true, account: { id: home.id, root: null } })
    })

    test(`${h}: no registered account → the default root, nothing stamped`, () => {
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([]) })).toEqual({ ok: true })
    })

    test(`${h}: a signed-out account is refused in words, never run under another login (owner too)`, () => {
      const out = { ...second, root: null, bound: false }
      for (const agentCaller of [true, false]) {
        expect(decideSpawnAccount({ harness: h, requested: out.id, agentCaller, context: on([home, out]) }))
          .toEqual({ ok: false, reason: 'account_signed_out', detail: out.id })
      }
      // The automatic pick never lands on it either, even when the router names it.
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([home, out], { [h]: out.id }) }))
        .toEqual({ ok: true, account: { id: home.id, root: null } })
      expect(spawnAccountStatus('account_signed_out')).toBe(409)
    })

    test(`${h}: a visible secondary-only account is picked before an unregistered default root`, () => {
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([second]) }))
        .toEqual({ ok: true, account: { id: second.id, root: second.root } })
      expect(decideSpawnAccount({ harness: h, agentCaller: false, context: on([second]) }))
        .toEqual({ ok: true, account: { id: second.id, root: second.root } })
      // Known accounts with no allowed target: the agent is refused, the owner keeps the default root.
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: on([hidden]) }))
        .toEqual({ ok: false, reason: 'account_unavailable', detail: hidden.id })
      expect(decideSpawnAccount({ harness: h, agentCaller: false, context: on([hidden]) })).toEqual({ ok: true })
    })

    test(`${h}: flag off keeps the hidden-account rule for an agent, nothing else changes`, () => {
      const homeOff = { ...home, available: false }
      const off = { enabled: false, accounts: [homeOff, second] }
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: off }))
        .toEqual({ ok: false, reason: 'account_unavailable', detail: home.id })
      expect(decideSpawnAccount({ harness: h, agentCaller: false, context: off })).toEqual({ ok: true })
      expect(decideSpawnAccount({ harness: h, agentCaller: true, context: { enabled: false, accounts: [home] } })).toEqual({ ok: true })
    })
  }
})

describe('decideRecordedAccount — a reopen keeps its account', () => {
  const a = row('codex', 'acc_a', '/data/accounts/codex/r_a')
  test('no record → default root, as before accounts existed', () => {
    expect(decideRecordedAccount(undefined, [a])).toEqual({ ok: true })
  })
  test('an account now off for agents: an agent is refused in words, the owner reopens in that account', () => {
    const off = [{ ...a, available: false }]
    expect(decideRecordedAccount('acc_a', off, { agentCaller: true })).toEqual({ ok: false, reason: 'account_unavailable', detail: 'acc_a' })
    expect(decideRecordedAccount('acc_a', off)).toEqual({ ok: true, account: { id: 'acc_a', root: a.root } })
    expect(spawnAccountMessage('account_unavailable', 'acc_a', 'en', true)).toContain('only the owner can reopen')
    expect(spawnAccountMessage('account_unavailable', 'acc_a', 'pt', true)).toContain('só o dono pode reabri-la')
  })
  test('a signed-out recorded account is refused for everyone, never run in the default root', () => {
    const out = [{ ...a, root: null, bound: false }]
    expect(decideRecordedAccount('acc_a', out)).toEqual({ ok: false, reason: 'account_signed_out', detail: 'acc_a' })
    expect(decideRecordedAccount('acc_a', out, { agentCaller: true }).ok).toBe(false)
  })
  test('a row with no account: an agent is held to the default root\'s login', () => {
    const homeOff = row('codex', 'acc_home', null, { available: false })
    expect(decideRecordedAccount(undefined, [homeOff], { agentCaller: true, harness: 'codex' }))
      .toEqual({ ok: false, reason: 'account_unavailable', detail: 'acc_home' })
    expect(decideRecordedAccount(undefined, [homeOff], { harness: 'codex' })).toEqual({ ok: true })
    expect(decideRecordedAccount(undefined, [{ ...homeOff, available: true }], { agentCaller: true, harness: 'codex' })).toEqual({ ok: true })
  })
  test('retired → refused, unknown → refused (never the default root)', () => {
    expect(decideRecordedAccount('acc_a', [{ ...a, retired: true }])).toEqual({ ok: false, reason: 'account_retired', detail: 'acc_a' })
    expect(decideRecordedAccount('acc_a', [])).toEqual({ ok: false, reason: 'unknown_account', detail: 'acc_a' })
    expect(spawnAccountMessage('account_retired', 'acc_a', 'en', true)).toContain('belongs to an account that was removed')
    expect(spawnAccountMessage('account_retired', 'acc_a', 'pt', true)).toContain('conta que foi removida')
  })
})

describe('routerPicks', () => {
  const b = (account: string, extra: Record<string, unknown> = {}) => ({
    harness: 'claude' as const, account, plan: 'Max', status: 'ok', weekResetsAt: 10, fiveHourPct: 10, weekPct: 10, ...extra,
  }) as unknown as AccountBudget
  test('pickAccount policy over the eligible accounts only', () => {
    expect(routerPicks([b('acc_a', { weekResetsAt: 20 }), b('acc_b', { weekResetsAt: 5 })])).toEqual({ claude: 'acc_b' })
    expect(routerPicks([b('acc_a'), b('acc_b', { status: 'hold', weekResetsAt: 1 })])).toEqual({ claude: 'acc_a' })
    expect(routerPicks([b('acc_a', { spawnable: false })])).toEqual({})
    expect(routerPicks([b('default')])).toEqual({})
  })
})

describe('spawnRowsOf — where an account runs comes from the bindings', () => {
  const acc = (id: string, harness: HarnessId, root: string | null, available = true) =>
    ({ id, harness, root, available, key: id, label: id, firstSeen: 1, lastSeen: 1 })
  test('an account whose default root was taken by another login is signed out, not the default login', () => {
    // A was bound to the default root; the owner signed in as B there (registry adoption nulls A's root).
    const rows = spawnRowsOf({
      accounts: [acc('acc_a', 'claude', null), acc('acc_b', 'claude', null, false)],
      bindings: { 'claude:': 'acc_b' },
    })
    expect(rows.find(r => r.id === 'acc_a')).toMatchObject({ bound: false })
    expect(rows.find(r => r.id === 'acc_b')).toMatchObject({ bound: true, root: null })
    // Naming A never launches B's login, for an agent or the owner.
    const context = { enabled: true, accounts: rows }
    for (const agentCaller of [true, false]) {
      expect(decideSpawnAccount({ harness: 'claude', requested: 'acc_a', agentCaller, context }))
        .toEqual({ ok: false, reason: 'account_signed_out', detail: 'acc_a' })
      expect(decideRecordedAccount('acc_a', rows, { agentCaller }).ok).toBe(false)
    }
    // And the automatic pick does not hand an agent the hidden default either.
    expect(decideSpawnAccount({ harness: 'claude', agentCaller: true, context }))
      .toEqual({ ok: false, reason: 'account_signed_out', detail: 'acc_a' })
  })
  test('a secondary root binding gives the root from the binding key', () => {
    const rows = spawnRowsOf({ accounts: [acc('acc_k', 'kimi', '/r/2')], bindings: { 'kimi:/r/2': 'acc_k' } })
    expect(rows).toEqual([{ id: 'acc_k', harness: 'kimi', root: '/r/2', bound: true, available: true, firstSeen: 1 }])
    // A login change in that secondary root signs the old account out; it never falls to the default root.
    const changed = spawnRowsOf({ accounts: [acc('acc_k', 'kimi', null), acc('acc_j', 'kimi', '/r/2')], bindings: { 'kimi:/r/2': 'acc_j' } })
    expect(changed.find(r => r.id === 'acc_k')).toMatchObject({ bound: false })
  })
})
