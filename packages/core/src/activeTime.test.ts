import { describe, expect, test } from 'bun:test'
import { computeActiveTime, activeMinutesOf } from './activeTime'

const MIN = 60_000

describe('computeActiveTime', () => {
  test('no events at all → undefined, never 0 (0 would read as "no work happened")', () => {
    expect(computeActiveTime([]).activeMinutes).toBeUndefined()
    expect(activeMinutesOf([{ ts: NaN, userPrompt: true }])).toBeUndefined()
  })

  test('a single turn is prompt → last event, not prompt → prompt', () => {
    const r = computeActiveTime([
      { ts: 0, userPrompt: true },
      { ts: 10 * MIN },
    ])
    expect(r.activeMinutes).toBe(10)
    expect(r.turns).toBe(1)
  })

  test('the idle gap between turns is excluded — this is the whole point', () => {
    // Two 5-minute turns three days apart: wall clock 72h, active time 10min.
    const day = 24 * 60 * MIN
    const r = computeActiveTime([
      { ts: 0, userPrompt: true },
      { ts: 5 * MIN },
      { ts: 3 * day, userPrompt: true },
      { ts: 3 * day + 5 * MIN },
    ])
    expect(r.activeMinutes).toBe(10)
    expect(r.turns).toBe(2)
  })

  test('a harness-measured duration wins over the reconstruction', () => {
    const r = computeActiveTime([
      { ts: 0, userPrompt: true },
      { ts: 10 * MIN },
      { ts: 10 * MIN, measuredMs: 2 * MIN },
    ])
    expect(r.activeMinutes).toBe(2)
    expect(r.measuredTurns).toBe(1)
  })

  test('mixed coverage: measured turns and reconstructed turns add up together', () => {
    const r = computeActiveTime([
      { ts: 0, userPrompt: true },
      { ts: 30 * MIN, measuredMs: 3 * MIN }, // measured turn
      { ts: 60 * MIN, userPrompt: true },    // reconstructed turn
      { ts: 64 * MIN },
    ])
    expect(r.activeMinutes).toBe(7)
    expect(r.turns).toBe(2)
    expect(r.measuredTurns).toBe(1)
  })

  test('an aborted turn ends where the harness says it ended, not at the last line of the file', () => {
    // Real shape: Copilot turn aborted 1min in, then the file sits idle for 3h before an error line.
    const r = computeActiveTime([
      { ts: 0, userPrompt: true },
      { ts: 1 * MIN, turnEnd: true },
      { ts: 200 * MIN },
    ])
    expect(r.activeMinutes).toBe(1)
    expect(r.turns).toBe(1)
  })

  test('a turn-end with no open turn is inert', () => {
    expect(computeActiveTime([{ ts: 5 * MIN, turnEnd: true }]).activeMinutes).toBe(0)
  })

  test('a measured duration with no open turn cannot invent one', () => {
    const r = computeActiveTime([{ ts: 0, measuredMs: 99 * MIN }])
    expect(r.activeMinutes).toBe(0)
    expect(r.turns).toBe(0)
  })

  test('tool results and assistant events do not open a turn', () => {
    const r = computeActiveTime([
      { ts: 0 },              // session boot line
      { ts: 60 * MIN },       // still no human prompt
      { ts: 60 * MIN, userPrompt: true },
      { ts: 62 * MIN },
    ])
    expect(r.activeMinutes).toBe(2)
  })

  test('out-of-order timestamps contribute 0, never negative time', () => {
    const r = computeActiveTime([
      { ts: 10 * MIN, userPrompt: true },
      { ts: 0 },
    ])
    expect(r.activeMinutes).toBe(0)
  })

  test('active time never exceeds the wall clock for a normal transcript', () => {
    const events = [
      { ts: 0, userPrompt: true }, { ts: 2 * MIN },
      { ts: 90 * MIN, userPrompt: true }, { ts: 95 * MIN },
    ]
    const wall = 95
    expect(computeActiveTime(events).activeMinutes!).toBeLessThanOrEqual(wall)
  })
})
