import { describe, expect, test } from 'bun:test'
import {
  ACCOUNT_FLAP_MS, accountAvailableForAgents, accountAvailableNotice, scheduleWindowEnd, stepAvailability,
} from './accountAvailability'
import { resolveAgentUse, scheduleVerdict, type AgentSchedule } from './agentSchedule'

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0)
const MIN = 60_000

describe('stepAvailability — one notice per transition', () => {
  test('first sight records the state and never notifies (a boot does not announce every account)', () => {
    expect(stepAvailability(undefined, true, T0)).toEqual({ next: { available: true, since: T0 }, notify: false, changed: true })
    expect(stepAvailability(undefined, false, T0)).toEqual({ next: { available: false, since: T0 }, notify: false, changed: true })
  })
  test('unavailable -> available notifies and stamps since + notifiedAt', () => {
    const out = stepAvailability({ available: false, since: T0 - 60 * MIN }, true, T0)
    expect(out).toEqual({ next: { available: true, since: T0, notifiedAt: T0 }, notify: true, changed: true })
  })
  test('available -> unavailable records only, never a notice', () => {
    const out = stepAvailability({ available: true, since: T0 - MIN, notifiedAt: T0 - MIN }, false, T0)
    expect(out.notify).toBe(false)
    expect(out.next).toEqual({ available: false, since: T0, notifiedAt: T0 - MIN })
  })
  test('the same state changes nothing (persisted state survives a restart: no re-send)', () => {
    const prev = { available: true, since: T0 - 5 * MIN, notifiedAt: T0 - 5 * MIN }
    expect(stepAvailability(prev, true, T0)).toEqual({ next: prev, notify: false, changed: false })
    expect(stepAvailability(prev, true, T0 + 10 * 24 * 60 * MIN).notify).toBe(false)
  })
  test('flapping inside 10 min: no new notice; after 10 min a new transition notifies again', () => {
    let s = stepAvailability({ available: false, since: T0 - 60 * MIN }, true, T0)
    expect(s.notify).toBe(true)
    s = stepAvailability(s.next, false, T0 + 2 * MIN)
    s = stepAvailability(s.next, true, T0 + 4 * MIN)
    expect(s.notify).toBe(false)
    expect(s.next).toEqual({ available: true, since: T0 + 4 * MIN, notifiedAt: T0 })
    s = stepAvailability(s.next, false, T0 + 5 * MIN)
    s = stepAvailability(s.next, true, T0 + ACCOUNT_FLAP_MS + 1)
    expect(s.notify).toBe(true)
  })
})

describe('accountAvailableForAgents — the existing status, nothing new', () => {
  test('agent-visible, spawnable and not on hold', () => {
    expect(accountAvailableForAgents({ visible: true, spawnable: true, status: 'ok' })).toBe(true)
    expect(accountAvailableForAgents({ visible: true, status: 'ok' })).toBe(true)
  })
  test('hidden (switched off / outside schedule), a broken login, or a hold is unavailable', () => {
    expect(accountAvailableForAgents({ visible: false, spawnable: true, status: 'ok' })).toBe(false)
    expect(accountAvailableForAgents({ visible: true, spawnable: false, status: 'ok' })).toBe(false)
    expect(accountAvailableForAgents({ visible: true, spawnable: true, status: 'hold' })).toBe(false)
  })
})

describe('override / schedule matrix (resolveAgentUse feeds the visible flag)', () => {
  // Thursday 26/11/2026; window 09:00-18:00 local.
  const schedule: AgentSchedule = { enabled: true, days: { thu: { windows: [{ from: '09:00', to: '18:00' }] } } }
  const at = (h: number, m = 0) => new Date(2026, 10, 26, h, m)
  const visible = (enabled: boolean, override: boolean, now: Date) =>
    resolveAgentUse({ enabled, override }, schedule, scheduleVerdict(schedule, now, null)).available
  test('override on outside the window -> available -> notice', () => {
    expect(visible(true, true, at(20))).toBe(true)
    const s = stepAvailability({ available: false, since: 0 }, accountAvailableForAgents({ visible: visible(true, true, at(20)) }), at(20).getTime())
    expect(s.notify).toBe(true)
  })
  test('override off outside the window -> still unavailable -> no notice (switched on is not enough)', () => {
    const s = stepAvailability({ available: false, since: 0 }, accountAvailableForAgents({ visible: visible(true, false, at(20)) }), at(20).getTime())
    expect(s.notify).toBe(false)
  })
  test('the window opens -> notice', () => {
    const before = stepAvailability(undefined, accountAvailableForAgents({ visible: visible(true, false, at(8, 59)) }), at(8, 59).getTime())
    expect(before.next.available).toBe(false)
    const open = stepAvailability(before.next, accountAvailableForAgents({ visible: visible(true, false, at(9)) }), at(9).getTime())
    expect(open.notify).toBe(true)
  })
  test('Agenda off wins over override: never available', () => {
    expect(visible(false, true, at(10))).toBe(false)
  })
})

describe('scheduleWindowEnd', () => {
  const schedule: AgentSchedule = {
    enabled: true,
    days: { thu: { windows: [{ from: '09:00', to: '18:00' }, { from: '22:00', to: '02:00' }] }, fri: { windows: [], allDay: true } },
  }
  test('the end of the window holding now', () => {
    expect(scheduleWindowEnd(schedule, new Date(2026, 10, 26, 10))).toBe('18:00')
    expect(scheduleWindowEnd(schedule, new Date(2026, 10, 26, 23))).toBe('02:00')
  })
  test("yesterday's window crossing midnight, an all-day day, and outside any window", () => {
    expect(scheduleWindowEnd({ enabled: true, days: { thu: { windows: [{ from: '22:00', to: '02:00' }] } } }, new Date(2026, 10, 27, 1))).toBe('02:00')
    expect(scheduleWindowEnd(schedule, new Date(2026, 10, 27, 15))).toBe('23:59')
    expect(scheduleWindowEnd(schedule, new Date(2026, 10, 26, 19))).toBeNull()
    expect(scheduleWindowEnd({ enabled: false, days: {} }, new Date(2026, 10, 26, 10))).toBeNull()
  })
})

describe('accountAvailableNotice', () => {
  test('pt, inside the schedule with an end time', () => {
    const text = accountAvailableNotice({ label: 'Nayara', harness: 'Claude Code', plan: 'Max 5x', reason: 'in-window', until: '18:00' }, 'pt')
    expect(text).toBe('[agentistics · conta] A conta Nayara (Claude Code, Max 5x) está disponível para agentes: dentro da agenda até 18:00. Veja agentistics_plan_limits antes de abrir sessões.')
  })
  test('en, override on', () => {
    const text = accountAvailableNotice({ label: 'Vini', harness: 'Codex', reason: 'override-on' }, 'en')
    expect(text).toBe('[agentistics · account] The account Vini (Codex) is available for agents: schedule override on. Check agentistics_plan_limits before opening sessions.')
  })
  test('no schedule, and a reason it does not know reads plainly', () => {
    expect(accountAvailableNotice({ label: 'X', harness: 'Claude Code', reason: 'no-schedule' }, 'pt')).toContain(': sem agenda (livre a qualquer hora).')
    expect(accountAvailableNotice({ label: 'X', harness: 'Claude Code' }, 'en')).toBe('[agentistics · account] The account X (Claude Code) is available for agents. Check agentistics_plan_limits before opening sessions.')
  })
})
