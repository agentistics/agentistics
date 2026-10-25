import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanLimits } from '@agentistics/core'
import { appendPoint, BUCKET_MS, flush, historyOf, MAX_POINTS, mergeSeries, pointOf, RETAIN_MS, recordHistory, __resetPlanHistoryForTest, type HistoryPoint } from './plan-history'

const T0 = Date.parse('2026-10-20T00:00:00Z')
const pt = (at: number, week = 10, weekReset = T0 + 86_400_000, fiveReset = at + 3_600_000): HistoryPoint =>
  ({ at, weekPct: week, fiveHourPct: 5, weekReset, fiveReset })
const limit = (at: number, week: number, weekReset: number): PlanLimits => ({
  harness: 'claude', account: 'a', plan: 'max5x', source: 'claude-usage-api', updatedAt: at,
  windows: [{ kind: 'week', usedPct: week, resetsAt: weekReset }, { kind: '5h', usedPct: 4, resetsAt: at + 1_000_000 }],
})

describe('downsampling', () => {
  test('readings in one 5-minute bucket collapse to the newest', () => {
    let s: HistoryPoint[] = []
    for (let i = 0; i < 6; i++) s = appendPoint(s, pt(T0 + i * 40_000, i))
    expect(s.length).toBe(1)
    expect(s[0]!.weekPct).toBe(5)
  })
  test('a week of 1-minute readings stays one point per bucket', () => {
    let s: HistoryPoint[] = []
    for (let m = 0; m < 7 * 24 * 60; m += 1) s = appendPoint(s, pt(T0 + m * 60_000, 10, T0 + 8 * 86_400_000, T0 + 8 * 86_400_000))
    expect(s.length).toBeLessThanOrEqual(7 * 24 * 12 + 1)
    expect(s.length).toBeGreaterThan(7 * 24 * 12 - 2)
  })
  test('a window renewal inside a bucket is kept as its own point', () => {
    const s = appendPoint(appendPoint([], pt(T0, 90, T0 + 1000)), pt(T0 + 60_000, 2, T0 + 7 * 86_400_000))
    expect(s.map(p => p.weekPct)).toEqual([90, 2])
  })
  test('old points leave and the series is bounded', () => {
    let s: HistoryPoint[] = [pt(T0)]
    s = appendPoint(s, pt(T0 + RETAIN_MS + BUCKET_MS * 2))
    expect(s.length).toBe(1)
    expect(MAX_POINTS).toBe(4032)
  })
  test('a late reading is inserted in order and merge unions two writers', () => {
    const s = appendPoint([pt(T0), pt(T0 + 3 * BUCKET_MS)], pt(T0 + BUCKET_MS + 5))
    expect(s.map(p => p.at)).toEqual([T0, T0 + BUCKET_MS + 5, T0 + 3 * BUCKET_MS])
    expect(mergeSeries([pt(T0)], [pt(T0 + 2 * BUCKET_MS), pt(T0)]).length).toBe(2)
  })
  test('pointOf keeps unknown windows null, never zero', () => {
    const l = limit(T0, 1, T0 + 5); l.windows = [l.windows[1]!]
    expect(pointOf(l).weekPct).toBeNull()
  })
})

describe('persistence', () => {
  let dir = ''
  afterEach(async () => { __resetPlanHistoryForTest(null); if (dir) await rm(dir, { recursive: true, force: true }) })
  test('survives a restart and merges with another writer', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plan-history-'))
    const file = join(dir, 'plan-history.json')
    __resetPlanHistoryForTest(file)
    const now = Date.now()
    await recordHistory('claude:a', limit(now - 2 * BUCKET_MS, 11, now + 1e6))
    await recordHistory('claude:a', limit(now, 12, now + 1e6))
    await flush()
    expect(JSON.parse(await readFile(file, 'utf8')).series['claude:a'].length).toBe(2)
    __resetPlanHistoryForTest(file)
    expect((await historyOf('claude:a')).map(p => p.weekPct)).toEqual([11, 12])
  })
  test('a corrupt file reads as empty', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plan-history-'))
    const file = join(dir, 'plan-history.json')
    await Bun.write(file, '{nope')
    __resetPlanHistoryForTest(file)
    expect(await historyOf('x')).toEqual([])
  })
})
