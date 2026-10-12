import { describe, expect, it } from 'bun:test'
import {
  inQuietHours, markSummaryGiven, mergeHeld, needIsNews, planRound, readQuietHours, splitForSilence, summaryDue,
  DEFAULT_QUIET_HOURS, type CheckinNeed, type SubjectMemory,
} from './checkinNotify'

const at = (h: number, m = 0, day = 12) => new Date(2026, 9, day, h, m).getTime()
const need = (subject: string, text = 't', critical = false): CheckinNeed => ({ subject, text, ...(critical ? { critical } : {}) })
const mem = (text: string, critical: boolean, when: number): SubjectMemory => ({ text, critical, at: when })

describe('needIsNews (dedup by subject)', () => {
  it('announces a subject never seen', () => expect(needIsNews(need('a'), undefined, at(10))).toBe(true))
  it('stays quiet on the same subject and text', () => expect(needIsNews(need('a', 't'), mem('t', false, at(9)), at(10))).toBe(false))
  it('re-announces when it got worse (now critical)', () => expect(needIsNews(need('a', 't', true), mem('t', false, at(10)), at(10, 1))).toBe(true))
  it('stays quiet when already critical and unchanged', () => expect(needIsNews(need('a', 't', true), mem('t', true, at(9)), at(10))).toBe(false))
  it('new text inside the hour is not news', () => expect(needIsNews(need('a', 'novo'), mem('t', false, at(10)), at(10, 59))).toBe(false))
  it('new text after one hour is news', () => expect(needIsNews(need('a', 'novo'), mem('t', false, at(10)), at(11))).toBe(true))
})

describe('inQuietHours', () => {
  const q = DEFAULT_QUIET_HOURS
  it('crosses midnight: 23h–8h', () => {
    expect(inQuietHours(q, at(22, 59))).toBe(false)
    expect(inQuietHours(q, at(23))).toBe(true)
    expect(inQuietHours(q, at(3))).toBe(true)
    expect(inQuietHours(q, at(7, 59))).toBe(true)
    expect(inQuietHours(q, at(8))).toBe(false)
  })
  it('a same-day window', () => {
    const d = { enabled: true, fromHour: 13, toHour: 15 }
    expect(inQuietHours(d, at(13))).toBe(true)
    expect(inQuietHours(d, at(15))).toBe(false)
  })
  it('disabled or empty window is never quiet', () => {
    expect(inQuietHours({ ...q, enabled: false }, at(3))).toBe(false)
    expect(inQuietHours({ enabled: true, fromHour: 5, toHour: 5 }, at(5))).toBe(false)
  })
  it('reads junk as the defaults', () => {
    expect(readQuietHours({ fromHour: 99, toHour: 'x' })).toEqual(DEFAULT_QUIET_HOURS)
    expect(readQuietHours(undefined)).toEqual(DEFAULT_QUIET_HOURS)
    expect(readQuietHours({ enabled: false }).enabled).toBe(false)
  })
})

describe('silence split and round plan', () => {
  it('only critical rings in the silence', () => {
    const r = splitForSilence([need('a'), need('b', 't', true)], true)
    expect(r.now.map(n => n.subject)).toEqual(['b'])
    expect(r.held.map(n => n.subject)).toEqual(['a'])
  })
  it('outside the silence everything rings', () => expect(splitForSilence([need('a')], false).held).toEqual([]))
  it('a round remembers news (raised or held) and drops repeats', () => {
    const p1 = planRound({ needs: [need('a'), need('b', 't', true)], memory: {}, quiet: true, now: at(2) })
    expect(p1.raise.map(n => n.subject)).toEqual(['b'])
    expect(p1.held.map(n => n.subject)).toEqual(['a'])
    const p2 = planRound({ needs: [need('a'), need('b', 't', true)], memory: p1.memory, quiet: true, now: at(2, 30) })
    expect(p2.raise).toEqual([])
    expect(p2.held).toEqual([])
  })
  it('mergeHeld keeps the newest text per subject', () => {
    expect(mergeHeld([need('a', 'old')], [need('a', 'new'), need('b')]).map(n => n.text)).toEqual(['new', 't'])
  })
})

describe('summaryDue', () => {
  const q = DEFAULT_QUIET_HOURS
  const st = (lastSeenAt: number, lastSummaryDay: string | null = null) => ({ lastSeenAt, lastSummaryDay })
  it('never during the silence, never with nothing held', () => {
    expect(summaryDue({ q, nowMs: at(3), held: 2, state: st(at(0)) })).toBe(null)
    expect(summaryDue({ q, nowMs: at(9), held: 0, state: st(at(0)) })).toBe(null)
  })
  it('the morning summary fires once the silence ends, once a day', () => {
    expect(summaryDue({ q, nowMs: at(8), held: 1, state: st(at(7, 59)) })).toBe('morning')
    const given = markSummaryGiven(st(at(8)), at(8))
    expect(summaryDue({ q, nowMs: at(8, 30), held: 1, state: given })).toBe(null)
  })
  it('opening the app after >= 2 h away fires "away"', () => {
    expect(summaryDue({ q, nowMs: at(15), held: 1, state: st(at(12, 59), '2026-10-12') })).toBe('away')
    expect(summaryDue({ q, nowMs: at(15), held: 1, state: st(at(13, 30), '2026-10-12') })).toBe(null)
  })
})
