import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER, type AccountBudget, type HarnessId } from '@agentistics/core'
import {
  decideRecordedAccount, decideSpawnAccount, routerPicks, spawnAccountMessage, spawnAccountStatus,
  type SpawnAccountContext, type SpawnAccountRow,
} from './spawn-account'

const row = (harness: HarnessId, id: string, root: string | null, extra: Partial<SpawnAccountRow> = {}): SpawnAccountRow =>
  ({ id, harness, root, available: true, firstSeen: 1, ...extra })
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
  }
})

describe('decideRecordedAccount — a reopen keeps its account', () => {
  const a = row('codex', 'acc_a', '/data/accounts/codex/r_a')
  test('no record → default root, as before accounts existed', () => {
    expect(decideRecordedAccount(undefined, [a])).toEqual({ ok: true })
  })
  test('the record wins, even when the account is now off for agents', () => {
    expect(decideRecordedAccount('acc_a', [{ ...a, available: false }])).toEqual({ ok: true, account: { id: 'acc_a', root: a.root } })
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
