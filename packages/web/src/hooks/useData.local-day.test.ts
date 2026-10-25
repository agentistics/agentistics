import { describe, expect, setSystemTime, test } from 'bun:test'
import { emptyStatsCache, sessionDay, type AppData, type Filters, type SessionMeta } from '@agentistics/core'
import { calcLongestStreak, calcStreak, computeDerivedStats, getDateRangeFilter, localActivityDates } from './useData'
import { activeInWindow, dayKey, dayKeyOfMs, daysBetween } from '../lib/sessionDaySlice'

const filters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }

function inSaoPaulo(run: () => void): void {
  // bun test runs in UTC without setting TZ, so `delete` would fall back to the host zone
  const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  process.env.TZ = 'America/Sao_Paulo'
  try { run() } finally {
    setSystemTime()
    process.env.TZ = previous
  }
}

function session(start: string, id = start): SessionMeta {
  return { session_id: id, harness: 'claude', project_path: '/repo', model: 'claude-opus-5',
    start_time: start, end_time: start, user_message_timestamps: [start],
    user_message_count: 1, assistant_message_count: 0, tool_counts: {}, message_hours: [],
  } as unknown as SessionMeta
}

function data(sessions: SessionMeta[]): AppData {
  return { statsCache: emptyStatsCache(), sessions, allSessions: [], projects: [], harnesses: ['claude'] }
}

describe('local activity calendar', () => {
  test('22:00 and 23:59 BRT belong to the same local day through producers and slicers', () => inSaoPaulo(() => {
    for (const instant of ['2026-10-18T01:00:00Z', '2026-10-18T02:59:00Z']) {
      expect(sessionDay(instant)).toBe('2026-10-17')
      expect(sessionDay(Date.parse(instant))).toBe('2026-10-17')
      expect(dayKey(instant)).toBe('2026-10-17')
      expect(dayKeyOfMs(Date.parse(instant))).toBe('2026-10-17')
      expect([...localActivityDates([session(instant)])]).toEqual(['2026-10-17'])
    }
    expect([...localActivityDates([session('2026-10-18T03:00:00Z')])]).toEqual(['2026-10-18'])
    // The epoch is a valid range boundary even though sessionDay rejects nonpositive adapter epochs.
    expect(dayKeyOfMs(0)).toBe('1969-12-31')
    expect(sessionDay('2026-10-17')).toBe('2026-10-17')
  }))

  test('owner regression: UTC tomorrow in the aggregate cannot turn 23 days into a record of 24', () => inSaoPaulo(() => {
    const now = new Date('2026-10-18T01:00:00Z')
    setSystemTime(now)
    const sessions = Array.from({ length: 23 }, (_, i) => {
      const day = new Date(now)
      day.setDate(day.getDate() - i)
      return session(day.toISOString())
    })
    const payload = data(sessions)
    payload.statsCache.dailyActivity = Array.from({ length: 24 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, 18 - i)).toISOString().slice(0, 10),
      sessionCount: 1, messageCount: 1, toolCallCount: 0,
    }))
    const dates = localActivityDates(sessions)
    expect(dates.has('2026-10-18')).toBe(false)
    expect(calcStreak(dates, now)).toBe(23)
    expect(calcLongestStreak(dates)).toBe(23)
    for (const dateRange of ['all', 'today'] as const) {
      const result = computeDerivedStats(payload, { ...filters, dateRange })!
      expect(result.streak).toBe(23)
      expect(result.longestStreak).toBe(23)
      expect(result.longestStreak).toBeGreaterThanOrEqual(result.streak)
    }
  }))

  test('local today includes late evening and ends at local midnight', () => inSaoPaulo(() => {
    setSystemTime(new Date('2026-10-18T01:00:00Z'))
    const { start, end } = getDateRangeFilter('today')
    expect(start.toISOString()).toBe('2026-10-17T03:00:00.000Z')
    expect(end.toISOString()).toBe('2026-10-18T02:59:59.999Z')
    expect(daysBetween(start.getTime(), end.getTime())).toEqual(['2026-10-17'])
    expect(activeInWindow(session('2026-10-18T02:59:00Z'), start.getTime(), end.getTime())).toBe(true)
  }))

  test('timestamps override aggregate dates; malformed timestamps are skipped and older sessions use endpoints', () => inSaoPaulo(() => {
    const older = session('2026-10-18T01:00:00Z')
    older.user_message_timestamps = []
    older.end_time = '2026-10-18T03:01:00Z'
    const malformed = session('invalid')
    expect([...localActivityDates([older, malformed])].sort()).toEqual(['2026-10-17', '2026-10-18'])
  }))

  test('project/model scopes apply to both streaks without importing cache-only days', () => inSaoPaulo(() => {
    setSystemTime(new Date('2026-10-18T01:00:00Z'))
    const selected = session('2026-10-18T01:00:00Z')
    const other = { ...session('2026-10-17T01:00:00Z'), project_path: '/other', model: 'claude-sonnet-4-6' }
    for (const scope of [{ projects: ['/repo'] }, { models: ['claude-opus-5'] }]) {
      const result = computeDerivedStats(data([selected, other]), { ...filters, ...scope })!
      expect(result.streak).toBe(1)
      expect(result.longestStreak).toBe(1)
    }
  }))
})
