import { describe, expect, test } from 'bun:test'
import { isNativeRow, nativeFleetRows } from './session-native'

const L = { working: 'working', idle: 'ended', ended: 'ended' }
describe('native sessions in the fleet (SS-01)', () => {
  test('running → working; otherwise a reopenable conversation (closed), never a guessed "needs you"', () => {
    const rows = nativeFleetRows([
      { sessionId: 'ses_a', title: 'Parser fix', task: 't-0539 Parser', updatedAt: '2026-10-03T12:00:00.000Z', status: 'open', model: 'm', cwd: '/w/repo', running: true },
      { sessionId: 'ses_b', title: 'Old', updatedAt: '2026-10-02T12:00:00.000Z', status: 'open', model: 'm', cwd: '/w/repo' },
      { sessionId: 'ses_c', title: 'Done', updatedAt: '2026-10-01T12:00:00.000Z', status: 'ended', model: 'm' },
    ], L)
    expect(rows.map(r => [r.id, r.state, r.stateLabel, r.harness])).toEqual([
      ['ses_a', 'working', 'working', 'agentistics'],
      ['ses_b', 'closed', 'ended', 'agentistics'],
      ['ses_c', 'closed', 'ended', 'agentistics'],
    ])
    expect(rows[0]).toMatchObject({ task: 'Parser', project: 'repo', cwd: '/w/repo', searchFields: { name: 'Parser fix', task: 't-0539 Parser' } })
    expect(isNativeRow(rows[1]!)).toBe(true)
  })
})

describe('g groups by task · harness · state (SS-01, D-TUI-12)', () => {
  test('the cycle, and anything outside it starts it', async () => {
    const { nextCycleGrouping, resolveSessionsKey } = await import('./sessions')
    expect(nextCycleGrouping('task')).toBe('harness')
    expect(nextCycleGrouping('harness')).toBe('status')
    expect(nextCycleGrouping('status')).toBe('task')
    expect(nextCycleGrouping('project')).toBe('task')
    expect(resolveSessionsKey({ input: 'g' }, { actionsFocused: false, asideFocused: false, detailPane: false, grid: false } as never)).toEqual({ kind: 'cycleGroup' })
    expect(resolveSessionsKey({ input: '', return: true }, { actionsFocused: false, asideFocused: false, detailPane: false, grid: false } as never)).toEqual({ kind: 'enter' })
  })
})

describe('state in words, with the dot beside the word (SS-02)', () => {
  test('live ●, ended ○, external ◌', async () => {
    const { stateCell } = await import('./sessions')
    expect(stateCell({ state: 'waiting-approval', stateLabel: 'approve' })).toBe('● approve')
    expect(stateCell({ state: 'waiting', stateLabel: 'needs you' })).toBe('● needs you')
    expect(stateCell({ state: 'working', stateLabel: 'working' })).toBe('● working')
    expect(stateCell({ state: 'closed', stateLabel: 'ended' })).toBe('○ ended')
    expect(stateCell({ state: 'unknown', stateLabel: 'external' })).toBe('◌ external')
  })
})
