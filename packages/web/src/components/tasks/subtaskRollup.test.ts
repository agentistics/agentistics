import { test, expect } from 'bun:test'
import { costCaveat, costCellFor, subtaskRollupOf } from './subtaskRollup'
import type { AttemptRollup, SubtaskView } from '../../lib/tasks'

function rollup(over: Partial<AttemptRollup> = {}): AttemptRollup {
  return {
    sessionsUsed: 1, sessionsLinked: 1, provenance: { assigned: 1, observed: 0, none: 0 },
    rounds: 3, activeMinutes: 10, tokens: 1000, costUSD: 1.5,
    costMeasuredSessions: 0, costEstimatedSessions: 1, credits: null, mixedCurrency: false,
    ...over,
  }
}

// --- subtaskRollupOf -----------------------------------------------------------------------------

test('subtaskRollupOf: finds the bucket by subtask id', () => {
  const r = rollup({ costUSD: 7 })
  const views: SubtaskView[] = [{ id: 's1', rollup: r }, { id: 's2', rollup: rollup({ costUSD: 3 }) }]
  expect(subtaskRollupOf(views, 's1')).toBe(r)
})

test('subtaskRollupOf: undefined when the server has no bucket for this subtask', () => {
  const views: SubtaskView[] = [{ id: 's1', rollup: rollup() }]
  expect(subtaskRollupOf(views, 'unknown')).toBeUndefined()
})

test('subtaskRollupOf: the id:null direct-branch bucket is not confused with a real subtask', () => {
  const views: SubtaskView[] = [{ id: null, rollup: rollup({ costUSD: 99 }) }]
  expect(subtaskRollupOf(views, 's1')).toBeUndefined()
})

// --- costCellFor -----------------------------------------------------------------------------

test('costCellFor: no bucket at all renders N/A, never a 0', () => {
  expect(costCellFor(undefined)).toEqual({ kind: 'na' })
})

test('costCellFor: a subtask with no session filed yet — sessionsUsed 0, costUSD null — is honest N/A, not a fake 0', () => {
  const r = rollup({ sessionsUsed: 0, sessionsLinked: 0, rounds: null, activeMinutes: null, tokens: null, costUSD: null })
  expect(costCellFor(r)).toEqual({ kind: 'money', usd: null })
})

test('costCellFor: an ordinary priced subtask renders its dollar figure', () => {
  expect(costCellFor(rollup({ costUSD: 12.34 }))).toEqual({ kind: 'money', usd: 12.34 })
})

test('costCellFor: mixed currency takes the credits branch even if costUSD is set', () => {
  const r = rollup({ mixedCurrency: true, costUSD: 5, credits: { nanoAiu: 0, premiumRequests: 4 } })
  expect(costCellFor(r)).toEqual({ kind: 'credits', premiumRequests: 4 })
})

test('costCellFor: Copilot-only credits with no USD figure takes the credits branch', () => {
  const r = rollup({ mixedCurrency: false, costUSD: null, credits: { nanoAiu: 0, premiumRequests: 2 } })
  expect(costCellFor(r)).toEqual({ kind: 'credits', premiumRequests: 2 })
})

// --- costCaveat ------------------------------------------------------------------------------

test('costCaveat: absent when every linked session is priced', () => {
  expect(costCaveat(rollup({ sessionsUsed: 2, sessionsLinked: 2 }))).toBeUndefined()
})

test('costCaveat: names the split when some sessions have no conversation link', () => {
  expect(costCaveat(rollup({ sessionsUsed: 3, sessionsLinked: 2 }))).toBe('cost covers 2 of 3 sessions')
})

test('costCaveat: absent when there is no bucket to speak of', () => {
  expect(costCaveat(undefined)).toBeUndefined()
})
