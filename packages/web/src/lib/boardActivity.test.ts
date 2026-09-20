import { describe, expect, it } from 'bun:test'
import { toBoardChartData } from './boardActivity'
import type { BoardDailyPoint } from './tasks'

describe('toBoardChartData', () => {
  it('carries the numbers across without inventing or dropping any', () => {
    const daily: BoardDailyPoint[] = [
      { date: '2026-09-01', sessionsStarted: 3, delivered: 1, created: 2 },
      { date: '2026-09-02', sessionsStarted: 0, delivered: 2, created: 0 },
    ]
    expect(toBoardChartData(daily)).toEqual([
      { date: '2026-09-01', value: 3, sessions: 1, tools: 2 },
      { date: '2026-09-02', value: 0, sessions: 2, tools: 0 },
    ])
  })

  it('an empty board yields an empty chart — never a fabricated day', () => {
    expect(toBoardChartData([])).toEqual([])
  })
})
