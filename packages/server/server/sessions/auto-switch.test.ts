import { describe, expect, test } from 'bun:test'
import type { AccountBudget } from '@agentistics/core'
import { AUTO_MIN_RESET_MS, RESUME_AFTER_RESET_MS, SETTLE_MS, autoSwitchWords, clock, decideAutoSwitch, handoffAccount, hasRoom, resumeDue, type AutoInput } from './auto-switch'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const row = (account: string, o: Partial<AccountBudget> = {}): AccountBudget => ({
  harness: 'claude', plan: 'max', account, fiveHourPct: 20, weekPct: 30, weekResetsAt: NOW + 3 * 86_400_000, daysToWeekReset: 3, dailyBudgetPct: 20,
  status: 'ok', updatedAt: NOW, stale: false, spawnable: true, ...o,
}) as AccountBudget
const opt = (id: string, harness = 'claude') => ({ id, harness, label: `Conta ${id}` }) as never
const base = (o: Partial<AutoInput> = {}): AutoInput => ({
  enabled: true, now: NOW, harness: 'claude', supported: true, currentAccount: 'a',
  limit: { resetsAt: NOW + 2 * 3_600_000 }, options: [opt('b'), opt('c')], budgets: [row('a', { fiveHourPct: 100 }), row('b'), row('c', { fiveHourPct: 40 })], ...o,
})

describe('decideAutoSwitch', () => {
  test('a limit far from its reset moves to the account the router picks', () => {
    const d = decideAutoSwitch(base())
    expect(d.kind).toBe('move')
    if (d.kind === 'move') {
      expect(['b', 'c']).toContain(d.target.id)
      expect(d.episode).toMatchObject({ account: d.target.id, handled: false })
      expect(d.episode.tried).toEqual(['a'])
    }
  })
  test('a reset within ten minutes waits (a move costs more); exactly ten also waits; an unknown reset counts as far', () => {
    expect(decideAutoSwitch(base({ limit: { resetsAt: NOW + 4 * 60_000 } }))).toEqual({ kind: 'skip', why: 'reset_soon' })
    expect(decideAutoSwitch(base({ limit: { resetsAt: NOW + AUTO_MIN_RESET_MS } }))).toEqual({ kind: 'skip', why: 'reset_soon' })
    expect(decideAutoSwitch(base({ limit: { resetsAt: NOW + AUTO_MIN_RESET_MS + 1 } })).kind).toBe('move')
    expect(decideAutoSwitch(base({ limit: {} })).kind).toBe('move')
  })
  test('not limit-blocked: nothing, and the episode is over', () => {
    expect(decideAutoSwitch(base({ limit: null }))).toEqual({ kind: 'clear' })
  })
  test('off, or a harness that cannot move a conversation: nothing', () => {
    expect(decideAutoSwitch(base({ enabled: false }))).toEqual({ kind: 'skip', why: 'disabled' })
    expect(decideAutoSwitch(base({ supported: false }))).toEqual({ kind: 'skip', why: 'unsupported' })
  })
  test('no candidate: stays, says so ONCE, and does not repeat', () => {
    const d = decideAutoSwitch(base({ options: [] }))
    expect(d).toMatchObject({ kind: 'none', episode: { handled: true, account: 'a' } })
    if (d.kind !== 'none') throw new Error('x')
    expect(decideAutoSwitch(base({ options: [], episode: d.episode }))).toEqual({ kind: 'skip', why: 'already_handled' })
  })
  test('cap exceeded (measured: no slot left), over a threshold, stale, held or unregistered are not candidates; unknown capacity is not room', () => {
    for (const bad of [{ freeSlots: 0, freeSlotsMeasured: true }, { fiveHourPct: 85 }, { weekPct: 95 }, { stale: true }, { status: 'hold' }, { plan: 'unregistered' }, { spawnable: false }]) {
      expect(hasRoom(row('x', bad as never))).toBe(false)
    }
    expect(hasRoom(row('x', { freeSlots: 0, freeSlotsMeasured: false } as never))).toBe(true) // an unmeasured burn is not a cap
    expect(decideAutoSwitch(base({ budgets: [row('a', { fiveHourPct: 100 }), row('b', { freeSlots: 0, freeSlotsMeasured: true } as never), row('c', { stale: true })] })).kind).toBe('none')
    expect(decideAutoSwitch(base({ budgets: [row('a', { fiveHourPct: 100 })] })).kind).toBe('none') // no row at all = unknown = not room
  })
  test('not agentic / signed out: the switch itself never offers them, so they are never a target', () => {
    // `options` is what `listSwitchTargets(..., agentCaller: true)` returns; an account it leaves out is not here.
    expect(decideAutoSwitch(base({ options: [opt('b')], budgets: [row('a', { fiveHourPct: 100 }), row('b', { fiveHourPct: 99 }), row('c')] })).kind).toBe('none')
  })
  test('same harness only: another harness\'s account is never a target', () => {
    expect(decideAutoSwitch(base({ options: [opt('z', 'codex')], budgets: [row('a', { fiveHourPct: 100 }), row('z', { harness: 'codex' } as never)] })).kind).toBe('none')
  })
  test('loop guard: an account that already limited this conversation in this episode is excluded, and the current one too', () => {
    const d = decideAutoSwitch(base({ currentAccount: 'b', options: [opt('a'), opt('c')], episode: { account: 'b', tried: ['a'], handled: false, at: NOW }, budgets: [row('a'), row('b', { fiveHourPct: 100 }), row('c', { fiveHourPct: 60 })] }))
    expect(d).toMatchObject({ kind: 'move', target: { id: 'c' } })
    const none = decideAutoSwitch(base({ currentAccount: 'c', options: [opt('a'), opt('b')], episode: { account: 'c', tried: ['a', 'b'], handled: false, at: NOW } }))
    expect(none.kind).toBe('none')
  })
  test('one move per episode: after a move the same (conversation, account) is not moved again until it is observed unblocked', () => {
    const first = decideAutoSwitch(base())
    if (first.kind !== 'move') throw new Error('x')
    // now running on the target and limit-blocked again → a fresh decision (new account), excluding what was tried
    const again = decideAutoSwitch(base({ currentAccount: first.target.id, episode: first.episode, options: [opt('a'), opt('b'), opt('c')].filter(o => (o as { id: string }).id !== first.target.id) }))
    expect(again.kind === 'move' ? (again.target as { id: string }).id : null).not.toBe('a')
  })
})

describe('handoffAccount (B)', () => {
  const budgets = [row('a', { fiveHourPct: 100 }), row('b'), row('c', { fiveHourPct: 50 })]
  test('never the predecessor\'s account when it is limit-blocked', () => {
    expect(handoffAccount({ harness: 'claude', usable: ['a', 'b', 'c'], budgets, predecessor: { account: 'b', limited: true } })).toEqual({ id: 'c', room: true })
  })
  test('the predecessor\'s account is not special when it is fine: the router decides among those with room', () => {
    expect(['b', 'c']).toContain(handoffAccount({ harness: 'claude', usable: ['a', 'b', 'c'], budgets, predecessor: { account: 'b', limited: false } })?.id ?? '')
  })
  test('nobody has room: the usable account whose window reopens first, flagged room:false — never the limited predecessor\'s', () => {
    const t = (d: number) => NOW + d * 86_400_000
    const all = [row('p', { fiveHourPct: 100, weekResetsAt: t(1) }), row('x', { fiveHourPct: 99, weekResetsAt: t(4) }), row('y', { weekPct: 97, weekResetsAt: t(2) })]
    expect(handoffAccount({ harness: 'claude', usable: ['p', 'x', 'y'], budgets: all, predecessor: { account: 'p', limited: true } })).toEqual({ id: 'y', room: false, resetsAt: t(2) })
    // a stale reading is no reading: not even a fallback
    expect(handoffAccount({ harness: 'claude', usable: ['x'], budgets: [row('x', { fiveHourPct: 99, stale: true })] })).toBeUndefined()
  })
  test('only the predecessor\'s limited account exists: no opinion', () => {
    expect(handoffAccount({ harness: 'claude', usable: ['p'], budgets: [row('p', { fiveHourPct: 100 })], predecessor: { account: 'p', limited: true } })).toBeUndefined()
  })
})

describe('words', () => {
  const T = new Date(Date.UTC(2026, 9, 30, 18, 30)).getTime()
  test('the time carries its zone, and the board comment follows the brief', () => {
    expect(clock(T, 'pt', 'UTC')).toBe('18:30 UTC')
    expect(clock(T, 'en', 'America/Sao_Paulo')).toBe('15:30 GMT-3')
    expect(clock(undefined, 'en')).toBe('no reset time given')
    expect(autoSwitchWords({ kind: 'move', lang: 'pt', session: 'Líder Motor', from: 'Conta A', to: 'Conta B', resetsAt: T, tz: 'UTC' }).comment).toBe('Conta trocada de Conta A para Conta B: limite até 18:30 UTC')
    expect(autoSwitchWords({ kind: 'move', lang: 'en', session: 's', from: 'A', to: 'B', resetsAt: T, tz: 'UTC' }).comment).toBe('Account switched from A to B: limit until 18:30 UTC')
  })
  test('"nobody has room" promises only what is done: a resume at the reset when it is known, nothing when it is not', () => {
    const known = autoSwitchWords({ kind: 'none', lang: 'en', session: 's', from: 'A', resetsAt: T, tz: 'UTC' }).message
    expect(known).toContain('18:30 UTC')
    expect(known).toContain('re-sends the last message, once')
    const unknown = autoSwitchWords({ kind: 'none', lang: 'pt', session: 's', from: 'A' }).message
    expect(unknown).toContain('Não há previsão')
    expect(unknown).not.toMatch(/segue sozinha|reenvia/)
  })
})

describe('QA fixes in the policy', () => {
  test('F1 — after a move, a limit entry that is not NEWER than the move is the copied old one: skipped; a newer one is a new limit', () => {
    const first = decideAutoSwitch(base())
    if (first.kind !== 'move') throw new Error('x')
    const onTarget = { currentAccount: first.target.id, episode: first.episode, options: [opt('a'), opt('b'), opt('c')].filter(o => (o as { id: string }).id !== first.target.id) }
    expect(decideAutoSwitch(base({ ...onTarget, limit: { resetsAt: NOW + 3 * 3_600_000, at: NOW - 3_600_000 } }))).toEqual({ kind: 'skip', why: 'stale_limit' })
    expect(decideAutoSwitch(base({ ...onTarget, limit: { resetsAt: NOW + 3 * 3_600_000, at: NOW } }))).toEqual({ kind: 'skip', why: 'stale_limit' })
    expect(decideAutoSwitch(base({ ...onTarget, now: NOW + 60_000, limit: { resetsAt: NOW + 3 * 3_600_000, at: NOW + 30_000 } })).kind).toBe('move')
  })
  test('F1 — with no timestamp on the line, the move is given a settle window', () => {
    const first = decideAutoSwitch(base())
    if (first.kind !== 'move') throw new Error('x')
    const onTarget = { currentAccount: first.target.id, episode: first.episode, options: [opt('a'), opt('b'), opt('c')].filter(o => (o as { id: string }).id !== first.target.id) }
    expect(decideAutoSwitch(base({ ...onTarget, now: NOW + 60_000, limit: { resetsAt: NOW + 4 * 3_600_000 } }))).toEqual({ kind: 'skip', why: 'stale_limit' })
    expect(decideAutoSwitch(base({ ...onTarget, now: NOW + SETTLE_MS + 1, limit: { resetsAt: NOW + 4 * 3_600_000 } })).kind).toBe('move')
  })
  test('F1 — a handled stop is not repeated, but a NEWER limit on the same account is decided afresh', () => {
    const none = decideAutoSwitch(base({ options: [], limit: { resetsAt: NOW + 2 * 3_600_000, at: NOW - 600_000 } }))
    if (none.kind !== 'none') throw new Error('x')
    expect(decideAutoSwitch(base({ options: [], episode: none.episode, limit: { resetsAt: NOW + 2 * 3_600_000, at: NOW - 600_000 } }))).toEqual({ kind: 'skip', why: 'already_handled' })
    expect(decideAutoSwitch(base({ episode: none.episode, limit: { resetsAt: NOW + 2 * 3_600_000, at: NOW + 5_000 } })).kind).toBe('move')
  })
  test('F2 — a "none" with a known reset schedules ONE resume at reset + 1 min; with an unknown reset, none', () => {
    const reset = NOW + 3 * 3_600_000
    const none = decideAutoSwitch(base({ options: [], limit: { resetsAt: reset } }))
    expect(none).toMatchObject({ kind: 'none', episode: { resumeAt: reset + RESUME_AFTER_RESET_MS } })
    if (none.kind !== 'none') throw new Error('x')
    expect(resumeDue(none.episode, reset)).toBe(false)
    expect(resumeDue(none.episode, reset + RESUME_AFTER_RESET_MS)).toBe(true)
    expect(resumeDue({ ...none.episode, resumedAt: reset + 70_000 }, reset + 80_000)).toBe(false) // once
    expect(decideAutoSwitch(base({ options: [], limit: {} }))).toMatchObject({ kind: 'none', episode: { handled: true } })
    expect((decideAutoSwitch(base({ options: [], limit: {} })) as { episode: { resumeAt?: number } }).episode.resumeAt).toBeUndefined()
  })
  test('F3 — an account already given a session this tick is not a candidate again', () => {
    const d = decideAutoSwitch(base({ budgets: [row('a', { fiveHourPct: 100 }), row('b'), row('c', { fiveHourPct: 80 })], takenThisTick: new Set(['b']) }))
    expect(d).toMatchObject({ kind: 'move', target: { id: 'c' } })
  })
  test('F4 — with no known current account nothing is done (it could be "moved" onto its own account)', () => {
    expect(decideAutoSwitch(base({ currentAccount: undefined }))).toEqual({ kind: 'skip', why: 'unknown_account' })
  })
  test('F6 — a per-model account is judged on the session\'s model; without a model it is not room', () => {
    const scoped = (week: number): AccountBudget => ({ ...row('b'), scopes: [
      { scope: { id: 'opus', label: 'Opus', models: ['claude-opus-5'], providers: ['anthropic'] }, weekPct: week, weekResetsAt: NOW + 86_400_000, daysToWeekReset: 1, dailyBudgetPct: 20, status: 'ok' },
      { scope: { id: 'sonnet', label: 'Sonnet', models: ['claude-sonnet-5'], providers: ['anthropic'] }, weekPct: 10, weekResetsAt: NOW + 86_400_000, daysToWeekReset: 1, dailyBudgetPct: 20, status: 'ok' },
    ] } as AccountBudget)
    expect(hasRoom(scoped(99), 'claude-opus-5')).toBe(false) // top-level 30 % hides an Opus group at 99 %
    expect(hasRoom(scoped(99), 'claude-sonnet-5')).toBe(true)
    expect(hasRoom(scoped(10))).toBe(false) // no model → no number for it → not room
    expect(hasRoom(scoped(10), 'claude-opus-5')).toBe(true)
    expect(decideAutoSwitch(base({ model: 'claude-opus-5', budgets: [row('a', { fiveHourPct: 100 }), scoped(99), row('c', { fiveHourPct: 50 })] }))).toMatchObject({ kind: 'move', target: { id: 'c' } })
  })
})
