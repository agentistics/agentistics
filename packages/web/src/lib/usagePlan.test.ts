import { describe, expect, test } from 'bun:test'
import { usageHeadline, planSessions, type UsageBudgetRow } from './usagePlan'

const at = (time: string) => new Date(`2026-10-17T${time}:00`).getTime()
const row = (p: Partial<UsageBudgetRow> = {}): UsageBudgetRow => ({
  harness: 'claude', plan: 'max5x', fiveHourPct: 10, weekPct: 30,
  weekResetsAt: Date.parse('2026-10-22T00:00:00Z'), daysToWeekReset: 5, dailyBudgetPct: 14,
  status: 'ok', updatedAt: at('12:00'), stale: false,
  paceStatus: 'on', burnPctPerHour: 0.5, sustainablePctPerHour: 0.5, suggestedParallel: 1, note: '',
  freeSlots: 1, freeSlotsMeasured: true, liveSessions: [], account: 'a', accountLabel: 'Claude · pessoal',
  ...p,
})
const live = { id: 'worker', model: 'sonnet', burnPctPerHour: 0.4 }

describe('usageHeadline', () => {
  test('counts plans over pace and names the latest numeric pause', () => {
    const rows = [row({ paceStatus: 'over', pauseUntil: at('14:20') }), row({ account: 'b' }),
      row({ account: 'c', paceStatus: 'over', pauseUntil: at('13:11') })]
    expect(usageHeadline(rows, at('12:00'), 'pt')).toBe('2 de 3 planos acima do ritmo. Não abra sessões novas até 14:20.')
    expect(usageHeadline(rows, at('12:00'), 'en')).toBe('2 of 3 plans over pace. Do not open new sessions until 14:20.')
  })
  test('all on pace', () => {
    expect(usageHeadline([row()], 0, 'en')).toBe('All 1 plans on pace.')
    expect(usageHeadline([row()], 0, 'pt')).toBe('Todos os 1 planos no ritmo.')
  })
  test('no rows means no headline', () => {
    expect(usageHeadline([], 0, 'pt')).toBeNull()
  })
  test('hold counts once and expired or absent pauses are omitted', () => {
    expect(usageHeadline([row({ status: 'hold', paceStatus: 'over', pauseUntil: at('12:00') })], at('12:00'), 'pt'))
      .toBe('1 de 1 planos acima do ritmo.')
    expect(usageHeadline([row({ status: 'hold' })], at('12:00'), 'en')).toBe('1 of 1 plans over pace.')
  })
})

describe('planSessions', () => {
  test('parallel is floor(sustainable / per-session burn), including decimal boundaries', () => {
    expect(planSessions([row({ sustainablePctPerHour: 1.2, burnPctPerHour: 0.4, liveSessions: [live] })], 4, 0)[0]?.parallel).toBe(3)
    expect(planSessions([row({ sustainablePctPerHour: 1.1, burnPctPerHour: 0.8, liveSessions: [live, { ...live, id: 'worker2' }] })], 4, 0)[0]?.parallel).toBe(2)
  })
  test('a plan on hold gets zero and its numeric pause, even beyond the requested hours', () => {
    expect(planSessions([row({ status: 'hold', pauseUntil: at('14:20') })], 1, at('12:00'))[0])
      .toMatchObject({ parallel: 0, pauseUntil: at('14:20'), reason: 'hold' })
  })
  test('unmeasured capacity or missing burn means unknown, never a guess', () => {
    for (const p of [{ burnPctPerHour: 0, liveSessions: [] }, { freeSlotsMeasured: false, liveSessions: [] }, { burnPctPerHour: 0, liveSessions: [live] }]) {
      expect(planSessions([row(p)], 4, 0)[0]).toMatchObject({ parallel: null, pauseUntil: null, reason: 'unmeasured' })
    }
  })
  test('measured capacity survives the last live session leaving the fleet', () => {
    expect(planSessions([row({ liveSessions: [], suggestedParallel: 2 })], 4, 0)[0]).toMatchObject({ parallel: 2, reason: 'pace' })
  })
  test('each account keeps its label and capacity without mutation', () => {
    const rows = [row({ liveSessions: [live], sustainablePctPerHour: 0.1 }), row({ harness: 'codex', account: undefined, accountLabel: undefined, freeSlotsMeasured: false })]
    const before = structuredClone(rows)
    expect(planSessions(rows, 4, 0)).toEqual([
      { account: 'a', harness: 'claude', label: 'Claude · pessoal', parallel: 0, pauseUntil: null, reason: 'pace' },
      { account: 'codex', harness: 'codex', label: 'codex', parallel: null, pauseUntil: null, reason: 'unmeasured' },
    ])
    expect(rows).toEqual(before)
    expect(planSessions([], 4, 0)).toEqual([])
  })
})
