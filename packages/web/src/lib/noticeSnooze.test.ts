import { describe, expect, test } from 'bun:test'
import { NOTICE_SNOOZE_MS, isNoticeSnoozed, snoozeNotice } from './noticeSnooze'

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

describe('notice snooze', () => {
  test('a closed notice stays closed until the delay passes', () => {
    const s = mem()
    expect(isNoticeSnoozed('k', 1000, s)).toBe(false)
    snoozeNotice('k', 1000, s)
    expect(isNoticeSnoozed('k', 1001, s)).toBe(true)
    expect(isNoticeSnoozed('k', 1000 + NOTICE_SNOOZE_MS - 1, s)).toBe(true)
    expect(isNoticeSnoozed('k', 1000 + NOTICE_SNOOZE_MS, s)).toBe(false)
  })
  test('garbage or a broken store reads as not snoozed and never throws', () => {
    const s = mem(); s.setItem('k', 'abc')
    expect(isNoticeSnoozed('k', 5, s)).toBe(false)
    const broken = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } }
    expect(isNoticeSnoozed('k', 5, broken)).toBe(false)
    expect(() => snoozeNotice('k', 5, broken)).not.toThrow()
    expect(isNoticeSnoozed('k', 5, null)).toBe(false)
  })
})
