import { beforeEach, describe, expect, test } from 'bun:test'
import type { AccountBudget } from '@agentistics/core'
import type { ResumeSessionRequest } from '@agentistics/tui/control'
import { switchSessionAccountImpl, type SwitchHostDeps } from './account-switch-host'
import { detectLimitInTail } from './account-switch'
import { runAutoSwitchTick, MAX_MOVES_PER_TICK, type AutoSwitchDeps, type EpisodeRead, type EpisodeStore, type LimitRead } from './auto-switch-io'
import type { AutoEpisode } from './auto-switch'
import { withResumeLock } from './resume-lock'
import type { SpawnAccountRow } from './spawn-account'
import type { ManagedSession } from './types'

const NOW = Date.UTC(2026, 9, 30, 12, 0)
const acc = (id: string, root: string | null = null): SpawnAccountRow => ({ id, harness: 'claude', root, bound: true, available: true, firstSeen: 1 })
const budget = (account: string, o: Partial<AccountBudget> = {}): AccountBudget => ({
  harness: 'claude', plan: 'max', account, fiveHourPct: 20, weekPct: 30, weekResetsAt: NOW + 3 * 86_400_000, daysToWeekReset: 3, dailyBudgetPct: 20,
  status: 'ok', updatedAt: NOW, stale: false, spawnable: true, ...o,
}) as AccountBudget

/** `acc_b` is the better target, `acc_c` the fallback. */
const oneTarget = [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 5 }), budget('acc_c', { fiveHourPct: 50 })]

/** A fleet of fake rows driven through the REAL switch implementation (`switchSessionAccountImpl`). */
function world(o: { hold?: import('./retire-plan').HoldObservation; enabled?: boolean; limited?: (row: ManagedSession) => { resetsAt?: number; at?: number; pendingPrompt?: string } | null; limitRead?: (row: ManagedSession) => LimitRead; idle?: (row: ManagedSession) => number | undefined; corrupt?: boolean; sentPrompts?: string[]; budgets?: AccountBudget[]; refuseTarget?: string[]; rowsInit?: ManagedSession[]; harness?: string } = {}) {
  let n = 0
  const rows: ManagedSession[] = o.rowsInit ?? [{ id: 'm1', harness: (o.harness ?? 'claude') as never, cwd: '/w', createdAt: '2026-10-30T00:00:00Z', conversationId: 'conv1', accountId: 'acc_a', label: 'Líder Motor', taskId: 't-1', subtaskId: 's-1' }]
  const alive = new Set(rows.map(r => r.id))
  const resumed: ResumeSessionRequest[] = []
  const notices: Array<{ code: string; meta: Record<string, unknown>; message: string }> = []
  const comments: Array<{ taskId: string; subtaskId?: string; body: string }> = []
  const accounts = [acc('acc_a'), acc('acc_b', '/r/b'), acc('acc_c', '/r/c')]
  const labels: Record<string, string> = { acc_a: 'Conta A', acc_b: 'Conta B', acc_c: 'Conta C' }
  const pending = 'continue o trabalho'
  const switchDeps = (): SwitchHostDeps => ({
    lang: 'pt',
    backend: { list: async () => [...alive].map(id => ({ id, alive: true })) as never, kill: async id => { alive.delete(id); return true } },
    withLock: withResumeLock,
    resume: async r => {
      resumed.push(r)
      if (r.switchToAccount && o.refuseTarget?.includes(r.switchToAccount)) return { ok: false, message: 'the session exited as soon as it started: claude: boom' }
      const prev = rows.find(m => m.id === r.replaces)
      if (prev) prev.endedAt = prev.endedAt ?? 'now'
      const id = `m${++n + 1}`
      rows.push({ ...prev!, id, endedAt: undefined, accountId: r.switchToAccount ?? prev?.accountId })
      alive.add(id)
      return { ok: true, message: 'ok', id }
    },
    io: {
      readRows: async () => rows.map(r => ({ ...r })),
      context: async () => ({ enabled: true, accounts }),
      findFiles: async () => ({ transcript: '/home/u/.claude/projects/-w/conv1.jsonl' }),
      copy: async () => {},
      limit: async () => ({ pendingPrompt: pending }),
      killAndRetire: async (id, kill) => { rows.find(m => m.id === id)!.endedAt = 'now'; return kill() },
      hold: async () => o.hold ?? { state: 'none' },
    },
  })
  let episodes: Record<string, AutoEpisode> = {}
  let corrupt = o.corrupt === true
  const clockRef = { now: NOW }
  const store: EpisodeStore = {
    read: async (): Promise<EpisodeRead> => { const c = corrupt; corrupt = false; return { episodes: structuredClone(episodes), corrupt: c } },
    update: async fn => { const d = structuredClone(episodes); fn(d); episodes = d },
  }
  const deps: AutoSwitchDeps = {
    lang: 'pt', now: () => clockRef.now, timeZone: 'UTC',
    ...(o.idle ? { idleMs: async (row: ManagedSession) => o.idle!(row) } : {}),
    sendPrompt: async (id, text) => { (o.sentPrompts ??= []).push(`${id}:${text}`); return true },
    enabled: async () => o.enabled !== false,
    rows: async () => rows.map(r => ({ ...r })),
    alive: async () => new Set(alive),
    currentAccount: async row => row.accountId,
    limitOf: async row => {
      if (o.limitRead) return o.limitRead(row)
      const l = o.limited ? o.limited(row) : { resetsAt: NOW + 3 * 3_600_000 }
      return l ? { kind: 'limited', ...l } : { kind: 'clear' }
    },
    budgets: async () => o.budgets ?? [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b'), budget('acc_c', { fiveHourPct: 60 })],
    options: async (_row, current) => accounts.filter(a => a.id !== current).map(a => ({ id: a.id, harness: 'claude', label: labels[a.id]! })) as never,
    switchAccount: async req => { const r = await switchSessionAccountImpl(req, switchDeps()); return { ok: r.ok, message: r.message, ...(r.id ? { id: r.id } : {}), ...(r.code ? { code: r.code } : {}), ...(r.ended ? { ended: true } : {}), ...(r.deferred ? { deferred: true } : {}) } },
    label: async (_h, id) => (id ? labels[id] : undefined),
    notify: n => { notices.push({ code: n.code, meta: n.meta, message: n.message }) },
    comment: async (taskId, subtaskId, body) => { comments.push({ taskId, ...(subtaskId ? { subtaskId } : {}), body }) },
    store,
  }
  return { deps, rows, resumed, notices, comments, clock: clockRef, sent: () => o.sentPrompts ?? [], live: () => rows.filter(r => !r.endedAt), episodes: () => episodes }
}

describe('runAutoSwitchTick — a limit-blocked row through the real switch', () => {
  test('moves it ONCE to the account with room, re-sends the refused message, tells the owner and the board', async () => {
    const w = world()
    const r = await runAutoSwitchTick(w.deps)
    expect(r.moved).toHaveLength(1)
    expect(w.resumed).toHaveLength(1)
    expect(w.resumed[0]).toMatchObject({ sessionId: 'conv1', replaces: 'm1', prompt: 'continue o trabalho', force: true })
    expect(['acc_b', 'acc_c']).toContain(w.resumed[0]!.switchToAccount!)
    expect(w.live()).toHaveLength(1)
    expect(w.live()[0]!.accountId).toBe(w.resumed[0]!.switchToAccount)
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_switched'])
    expect(w.notices[0]!.message).toContain('Conta A')
    expect(w.comments).toHaveLength(1)
    expect(w.comments[0]).toMatchObject({ taskId: 't-1', subtaskId: 's-1' })
    expect(w.comments[0]!.body).toMatch(/^Conta trocada de Conta A para Conta [BC]: limite até 15:00 UTC$/)
    expect(w.episodes().conv1).toMatchObject({ handled: false })
  })

  test('the new row is not limited: the episode is over; a limit later is a NEW episode', async () => {
    let limited = true
    const w = world({ limited: () => (limited ? { resetsAt: NOW + 3 * 3_600_000 } : null) })
    await runAutoSwitchTick(w.deps)
    limited = false
    await runAutoSwitchTick(w.deps)
    expect(w.episodes().conv1).toBeUndefined()
    limited = true
    const r = await runAutoSwitchTick(w.deps)
    expect(r.moved).toHaveLength(1) // a fresh limit on the new account moves again (it is a different episode)
  })

  test('never loops: the new account limits too → the third account, never back to the first; then nobody is left and it says so once', async () => {
    const w = world({ budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 10 }), budget('acc_c', { fiveHourPct: 50 })] })
    const seen: Array<string | undefined> = []
    for (let i = 0; i < 5; i++) {
      w.clock.now = NOW + i * 6 * 60_000 // past the settle window: a limit with no timestamp may be decided again
      await runAutoSwitchTick(w.deps)
      seen.push(w.live()[0]?.accountId)
    }
    expect(w.resumed.map(r => r.switchToAccount)).toEqual(['acc_b', 'acc_c']) // a → b → c, and no further move
    expect(seen.at(-1)).toBe('acc_c')
    expect(w.notices.filter(n => n.code === 'account.auto_none')).toHaveLength(1) // said ONCE, not every minute
    expect(w.live()).toHaveLength(1)
  })

  test('no candidate (nobody under the thresholds): leaves it, says so once', async () => {
    const w = world({ budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 90 }), budget('acc_c', { weekPct: 96 })] })
    await runAutoSwitchTick(w.deps)
    await runAutoSwitchTick(w.deps)
    expect(w.resumed).toEqual([])
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_none'])
    expect(w.comments).toEqual([])
  })

  test('a reset within ten minutes, the switch turned off, or a harness that cannot move a conversation: nothing happens', async () => {
    const soon = world({ limited: () => ({ resetsAt: NOW + 5 * 60_000 }) })
    await runAutoSwitchTick(soon.deps)
    expect(soon.resumed).toEqual([])
    const off = world({ enabled: false })
    await runAutoSwitchTick(off.deps)
    expect(off.resumed).toEqual([])
    const gem = world({ harness: 'gemini' })
    await runAutoSwitchTick(gem.deps)
    expect(gem.resumed).toEqual([])
  })

  test('a target that refuses to start gives the session back on its own account; the next tick tries ANOTHER account', async () => {
    const w = world({ refuseTarget: ['acc_b'], budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 5 }), budget('acc_c', { fiveHourPct: 50 })] })
    const first = await runAutoSwitchTick(w.deps)
    expect(first.failed).toHaveLength(1)
    expect(w.live()[0]!.accountId).toBe('acc_a') // given back
    await runAutoSwitchTick(w.deps)
    expect(w.resumed.map(r => r.switchToAccount).filter(Boolean)).toEqual(['acc_b', undefined, 'acc_c'].filter(Boolean) as string[])
    expect(w.live().map(r => r.accountId)).toEqual(['acc_c'])
  })

  test('a fleet-wide limit is worked through, not stampeded: at most three moves a tick, one entry per account', async () => {
    const rowsInit: ManagedSession[] = Array.from({ length: 5 }, (_, i) => ({ id: `m${i + 1}`, harness: 'claude' as never, cwd: '/w', createdAt: '2026-10-30T00:00:00Z', conversationId: `conv${i + 1}`, accountId: 'acc_a', label: `s${i + 1}` }))
    const w = world({ rowsInit })
    const r = await runAutoSwitchTick(w.deps)
    expect(r.moved.length).toBeLessThanOrEqual(MAX_MOVES_PER_TICK)
    expect(r.moved).toHaveLength(2) // acc_b and acc_c: one session each; the rest wait for the next tick (the budgets are read once)
  })
})

describe('a failed switch is said, with its reason (CONTA.AUTO ressalvas)', () => {
  test('a target that refuses to start: notice and board comment carry the reason, and the ledger keeps it', async () => {
    const w = world({ refuseTarget: ['acc_b'], budgets: oneTarget })
    await runAutoSwitchTick(w.deps)
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_failed'])
    expect(w.notices[0]!.message).toContain('Conta B')
    expect(w.notices[0]!.message).toContain('não conseguiu iniciar na outra conta')
    // the notice's id is the row that carries the session now: the one given back on the old account
    expect(w.notices[0]!.meta).toMatchObject({ id: w.live()[0]!.id, from: 'Conta A', to: 'Conta B', reasonKind: 'start_failed', outcome: 'kept' })
    expect(String(w.notices[0]!.meta.reason)).toContain('não conseguiu iniciar na outra conta')
    expect(w.comments).toHaveLength(1)
    expect(w.comments[0]).toMatchObject({ taskId: 't-1', subtaskId: 's-1' })
    expect(w.comments[0]!.body).toContain('não conseguiu iniciar na outra conta')
    expect(w.episodes().conv1!.failure).toMatchObject({ target: 'acc_b', at: NOW })
    expect(w.episodes().conv1!.failure!.message).toContain('terminou assim que começou')
  })

  test('the session could not be given back either: the notice says it was ENDED and points at Reopen', async () => {
    const w = world({ refuseTarget: ['acc_b'], budgets: oneTarget })
    w.deps.switchAccount = async () => ({ ok: false, ended: true, message: 'A sessão foi encerrada: ela não iniciou na outra conta nem pôde ser reaberta na conta de antes.' })
    await runAutoSwitchTick(w.deps)
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_failed'])
    expect(w.notices[0]!.message).toContain('use Reabrir')
    expect(w.notices[0]!.meta.outcome).toBe('ended')
  })

  test('"reopen" is said only when the session was really closed: given back says it carries on, untouched says neither', async () => {
    const back = world({ refuseTarget: ['acc_b'], budgets: oneTarget })
    await runAutoSwitchTick(back.deps)
    expect(back.notices[0]!.message).toContain('Ela continua na conta de antes')
    expect(back.notices[0]!.message).not.toContain('Reabrir')
    const refused = world({ budgets: oneTarget })
    refused.deps.switchAccount = async () => ({ ok: false, code: 'account_signed_out', message: 'refused' })
    await runAutoSwitchTick(refused.deps)
    expect(refused.notices[0]!.message).toContain('O login da conta de destino')
    expect(refused.notices[0]!.message).not.toMatch(/Reabrir|continua na conta de antes/)
  })

  test('nobody left to try: the failures and the one "no room" notice are said once, never again every tick', async () => {
    for (const at of [undefined, NOW - 60_000]) {
      const w = world({ refuseTarget: ['acc_b', 'acc_c'], budgets: oneTarget, limited: () => ({ resetsAt: NOW + 3 * 3_600_000, ...(at !== undefined ? { at } : {}) }) })
      for (let i = 0; i < 8; i++) {
        w.clock.now = NOW + i * 6 * 60_000
        await runAutoSwitchTick(w.deps)
      }
      expect(w.notices.map(n => n.code)).toEqual(['account.auto_failed', 'account.auto_failed', 'account.auto_none'])
      expect(w.comments).toHaveLength(2)
    }
  })

  test('a switch that THROWS is reported once and its target counted as tried, not retried every tick', async () => {
    const w = world({ budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 5 }), budget('acc_c', { fiveHourPct: 90 })] })
    let calls = 0
    w.deps.switchAccount = async () => { calls++; throw new Error('kaboom') }
    await runAutoSwitchTick(w.deps)
    await runAutoSwitchTick(w.deps)
    expect(calls).toBe(1)
    expect(w.notices.filter(n => n.code === 'account.auto_failed')).toHaveLength(1)
    expect(w.notices[0]!.message).not.toContain('kaboom') // raw text never reaches the notice
    expect(w.episodes().conv1!.failure!.message).toBe('kaboom') // it is kept where an operator looks
  })
})

describe('no id, path or command ever reaches an auto-switch notice or board comment', () => {
  const RAW = [
    'codex: command not found',
    "ENOENT: no such file or directory, open '/home/mithrandir/.agentistics/managed-sessions.json'",
    'Error: spawn claude ENOENT',
    'Please run /login · token expired for acc_9f8e7d',
    'the session exited as soon as it started: claude: boom at /usr/lib/x.js:3',
    'TypeError: cannot read properties of undefined (a1b2c3d4e5)',
  ]
  const CODES = ['accounts_disabled', 'unknown_account', 'account_unavailable', 'account_signed_out', 'account_retired', 'harness_unavailable', 'no_transcript', 'no_conversation', 'switch_unsupported', 'same_account', 'no_target', 'not_running_here']
  const FORBIDDEN = /acc_|a1b2c3d4e5|f0e1d2c3b4|\/home|\/usr|\/login|ENOENT|command not found|spawn|TypeError|\.json|undefined|\{\w+\}/

  for (const lang of ['pt', 'en'] as const) {
    test(`unnamed session, unnamed accounts, every reason (${lang})`, async () => {
      const failures = [...RAW.map(message => ({ message })), ...CODES.map(code => ({ message: `account "acc_9f8e7d" refused (${code})`, code }))]
      for (const f of failures) {
        for (const state of [{ ended: true }, { id: 'f0e1d2c3b4' }, {}]) {
          const w = world({ rowsInit: [{ id: 'a1b2c3d4e5', harness: 'claude' as never, cwd: '/w', createdAt: '2026-10-30T00:00:00Z', conversationId: 'conv1', accountId: 'acc_a', taskId: 't-1' }], budgets: oneTarget })
          w.deps.lang = lang
          w.deps.label = async () => undefined
          w.deps.options = async () => [{ id: 'acc_b', harness: 'claude', label: 'acc_b' }] as never
          w.deps.switchAccount = async () => ({ ok: false, ...f, ...state })
          await runAutoSwitchTick(w.deps)
          expect(w.notices.map(n => n.code)).toEqual(['account.auto_failed'])
          for (const words of [w.notices[0]!.message, w.comments[0]!.body, String(w.notices[0]!.meta.reason)]) expect(words).not.toMatch(FORBIDDEN)
          expect(w.notices[0]!.message).toContain(lang === 'pt' ? 'Uma sessão do Claude Code' : 'A Claude Code session')
          expect(w.notices[0]!.meta.session).toBe('')
        }
      }
    })

    test(`the other notices of an unnamed session: moved, no room, deferred (${lang})`, async () => {
      const row: ManagedSession = { id: 'a1b2c3d4e5', harness: 'claude' as never, cwd: '/w', createdAt: '2026-10-30T00:00:00Z', conversationId: 'conv1', accountId: 'acc_a' }
      const moved = world({ rowsInit: [{ ...row }] })
      const none = world({ rowsInit: [{ ...row }], budgets: [budget('acc_a', { fiveHourPct: 100 })] })
      // its own id per language: the deferral is told once per session for the life of the process
      const held = world({ rowsInit: [{ ...row, id: `f0e1d2c3b4${lang}` }], hold: { state: 'held', since: NOW, sentence: { en: 'x', pt: 'x' } } })
      for (const w of [moved, none, held]) {
        w.deps.lang = lang
        w.deps.label = async () => undefined
        await runAutoSwitchTick(w.deps)
        expect(w.notices).toHaveLength(1)
        expect(w.notices[0]!.message).not.toMatch(FORBIDDEN)
      }
    })
  }
})

describe('an account whose login the harness refused is never a move target', () => {
  test('room in the budget, offered by the switch, but expired: nothing is resumed', async () => {
    const w = world({ budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 5 }), budget('acc_c', { fiveHourPct: 90 })] })
    w.deps.expired = async () => new Set(['acc_b'])
    await runAutoSwitchTick(w.deps)
    expect(w.resumed).toEqual([])
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_none'])
  })
})

describe('HIGH-1: a limit-blocked held session is DEFERRED, never switched', () => {
  test('nothing is killed or resumed; the target is not counted as tried; told once; the next tick moves it when the hold is over', async () => {
    const w = world({ hold: { state: 'held', since: NOW - 60_000, sentence: { en: 'engine words', pt: 'palavras do engine' } } })
    const first = await runAutoSwitchTick(w.deps)
    expect(first.deferred).toEqual(['m1'])
    expect(first.failed).toEqual([])
    expect(w.resumed).toEqual([])
    expect(w.live().map(r => r.id)).toEqual(['m1'])
    expect(w.episodes().conv1).toBeUndefined() // no target was tried
    const second = await runAutoSwitchTick(w.deps)
    expect(second.deferred).toEqual(['m1'])
    expect(w.notices.filter(n => n.code === 'account.auto_deferred')).toHaveLength(1)
    expect(w.notices.find(n => n.code === 'account.auto_deferred')!.message).toContain('em uso agora')
    // once the call is over the same session moves (a world with no hold): the deferral cost nothing
    expect((await runAutoSwitchTick(world().deps)).moved).toHaveLength(1)
  })
})

describe('QA fixes through the tick', () => {
  const claudeLimit = (atMs: number, resetsAtMs: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(atMs).toISOString(), apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { resetsAt: Math.floor(resetsAtMs / 1000) } }, message: { content: [{ text: "You've hit your limit" }] } })
  const claudeUser = (atMs: number, text: string) => JSON.stringify({ type: 'user', timestamp: new Date(atMs).toISOString(), message: { content: text } })

  test('F1 — the cascade A→D→C→B: the copied transcript still ends with the OLD limit and the resumed session has not answered; one move, then nothing', async () => {
    // The transcript the target account got by copy: the limit that stopped account A, then the re-sent prompt. No assistant line yet.
    const lines = [claudeUser(NOW - 4_000_000, 'continue o trabalho'), claudeLimit(NOW - 3_600_000, NOW + 3 * 3_600_000), claudeUser(NOW + 1_000, 'continue o trabalho')]
    const w = world({
      budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 10 }), budget('acc_c', { fiveHourPct: 20 }), budget('acc_d', { fiveHourPct: 30 })],
      limitRead: () => {
        const s = detectLimitInTail('claude', lines)
        return s ? { kind: 'limited', ...(s.resetsAt !== undefined ? { resetsAt: s.resetsAt } : {}), ...(s.at !== undefined ? { at: s.at } : {}) } : { kind: 'clear' }
      },
    })
    expect(detectLimitInTail('claude', lines)).toMatchObject({ at: NOW - 3_600_000 }) // the detector reads the old line as limited (that is the trap)
    const moves: string[] = []
    for (let i = 0; i < 5; i++) {
      w.clock.now = NOW + i * 60_000
      const r = await runAutoSwitchTick(w.deps)
      moves.push(...r.moved.map(m => `${m.from}→${m.to}`))
    }
    expect(moves).toHaveLength(1)
    expect(w.resumed).toHaveLength(1)
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_switched']) // and no false "nobody has room"
  })

  test('F1 — a genuinely NEW limit on the new account (a later entry) does move again, to an untried account', async () => {
    const w = world({ budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 10 }), budget('acc_c', { fiveHourPct: 20 })] })
    let lines = [claudeLimit(NOW - 3_600_000, NOW + 3 * 3_600_000)]
    w.deps.limitOf = async () => { const s = detectLimitInTail('claude', lines); return s ? { kind: 'limited', ...(s.resetsAt ? { resetsAt: s.resetsAt } : {}), ...(s.at ? { at: s.at } : {}) } : { kind: 'clear' } }
    await runAutoSwitchTick(w.deps)
    expect(w.resumed).toHaveLength(1)
    lines = [...lines, claudeUser(NOW + 10_000, 'x'), claudeLimit(NOW + 120_000, NOW + 4 * 3_600_000)]
    w.clock.now = NOW + 180_000
    await runAutoSwitchTick(w.deps)
    expect([...w.resumed.map(r => r.switchToAccount)].sort()).toEqual(['acc_b', 'acc_c']) // two DIFFERENT untried accounts, never back to a
  })

  test('F2 — nobody has room: the pending message is re-sent ONCE at reset + 1 min, on the same account, and the notice says exactly that', async () => {
    const reset = NOW + 2 * 3_600_000
    const w = world({ limited: () => ({ resetsAt: reset, at: NOW - 60_000, pendingPrompt: 'continue o trabalho' }), budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 95 }), budget('acc_c', { weekPct: 99 })] })
    await runAutoSwitchTick(w.deps)
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_none'])
    expect(w.notices[0]!.message).toContain('reenvia a última mensagem, uma única vez')
    expect(w.episodes().conv1).toMatchObject({ handled: true, resumeAt: reset + 60_000 })
    w.clock.now = reset + 30_000
    await runAutoSwitchTick(w.deps)
    expect(w.sent()).toEqual([])
    w.clock.now = reset + 60_000
    await runAutoSwitchTick(w.deps)
    await runAutoSwitchTick(w.deps)
    expect(w.sent()).toEqual(['m1:continue o trabalho']) // once
    expect(w.resumed).toEqual([]) // never moved
  })

  test('F2 — an UNKNOWN reset: the notice does not promise anything and nothing is scheduled', async () => {
    const w = world({ limited: () => ({}), budgets: [budget('acc_a', { fiveHourPct: 100 })] })
    await runAutoSwitchTick(w.deps)
    expect(w.notices.map(n => n.code)).toEqual(['account.auto_none_manual'])
    expect(w.notices[0]!.message).toContain('só continua quando você mandar uma mensagem')
    expect(w.episodes().conv1!.resumeAt).toBeUndefined()
  })

  test('F3 — three stopped sessions, one account with room: not all three land on it in one tick', async () => {
    const rowsInit: ManagedSession[] = Array.from({ length: 3 }, (_, i) => ({ id: `m${i + 1}`, harness: 'claude' as never, cwd: '/w', createdAt: '2026-10-30T00:00:00Z', conversationId: `conv${i + 1}`, accountId: 'acc_a', label: `s${i + 1}` }))
    const w = world({ rowsInit, budgets: [budget('acc_a', { fiveHourPct: 100 }), budget('acc_b', { fiveHourPct: 10 }), budget('acc_c', { fiveHourPct: 40 })] })
    const r = await runAutoSwitchTick(w.deps)
    const targets = r.moved.map(m => m.to)
    expect(new Set(targets).size).toBe(targets.length)
    expect(targets).toHaveLength(2) // b and c, one each; the third waits for the next tick
  })

  test('F4 — a session whose account is unknown is left alone', async () => {
    const w = world({ rowsInit: [{ id: 'm1', harness: 'claude' as never, cwd: '/w', createdAt: '2026-10-30T00:00:00Z', conversationId: 'conv1', label: 'x' }] })
    w.deps.currentAccount = async () => undefined
    const r = await runAutoSwitchTick(w.deps)
    expect(r.moved).toEqual([])
    expect(w.resumed).toEqual([])
  })

  test('F5 — an unreadable episode file: this tick acts on nothing, the stopped session is recorded as handled, and a copy of an old limit is not mistaken for a new one', async () => {
    const w = world({ corrupt: true, limited: () => ({ resetsAt: NOW + 3 * 3_600_000, at: NOW - 3_600_000 }) })
    const r = await runAutoSwitchTick(w.deps)
    expect(r.moved).toEqual([])
    expect(w.resumed).toEqual([])
    expect(w.episodes().conv1).toMatchObject({ handled: true, seenAt: NOW - 3_600_000 })
    await runAutoSwitchTick(w.deps) // the same old limit entry: still nothing
    expect(w.resumed).toEqual([])
  })

  test('F5 — "could not read the transcript" proves nothing: the episode (the loop guard) stays; only a positive "not limited" read ends it', async () => {
    let read: LimitRead = { kind: 'limited', resetsAt: NOW + 3 * 3_600_000, at: NOW - 60_000 }
    const w = world({ limitRead: () => read, budgets: [budget('acc_a', { fiveHourPct: 100 })] })
    await runAutoSwitchTick(w.deps)
    expect(w.episodes().conv1).toBeDefined()
    read = { kind: 'unread' }
    await runAutoSwitchTick(w.deps)
    expect(w.episodes().conv1).toBeDefined()
    read = { kind: 'clear' }
    await runAutoSwitchTick(w.deps)
    expect(w.episodes().conv1).toBeUndefined()
  })

  test('F7 — a session that produced output a moment ago is working: its transcript is not even read', async () => {
    let reads = 0
    const w = world({ idle: () => 5_000, limitRead: () => { reads++; return { kind: 'limited', resetsAt: NOW + 3 * 3_600_000 } } })
    await runAutoSwitchTick(w.deps)
    expect(reads).toBe(0)
    const idle = world({ idle: () => 120_000, limitRead: () => { reads++; return { kind: 'limited', resetsAt: NOW + 3 * 3_600_000 } } })
    await runAutoSwitchTick(idle.deps)
    expect(reads).toBe(1)
  })
})
