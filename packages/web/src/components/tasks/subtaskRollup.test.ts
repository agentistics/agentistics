import { test, expect } from 'bun:test'
import { costCaveat, costCellFor, isUntracked, rollupKeyOf, subtaskRollupOf, subtaskStatsOf, tokensCellFor } from './subtaskRollup'
import type { AttemptRollup, Subtask, SubtaskView, TaskStats } from '../../lib/tasks'

function rollup(over: Partial<AttemptRollup> = {}): AttemptRollup {
  return {
    sessionsUsed: 1, sessionsLinked: 1, provenance: { assigned: 1, observed: 0, none: 0 },
    rounds: 3, activeMinutes: 10, tokens: 1000, costUSD: 1.5,
    costMeasuredSessions: 0, costEstimatedSessions: 1, credits: null, mixedCurrency: false,
    ...over,
  }
}

function stats(over: Partial<TaskStats> = {}): TaskStats {
  return {
    models: [], harnesses: [], tokens: null, agentRuns: null, filesModified: null,
    linesAdded: null, linesRemoved: null, commits: null, toolErrors: null, deliveryMs: null,
    firstSessionAt: null, lastSessionAt: null,
    ...over,
  }
}

function sub(id: string, groupId?: string): Pick<Subtask, 'id' | 'groupId'> {
  return groupId === undefined ? { id } : { id, groupId }
}

// --- rollupKeyOf -----------------------------------------------------------------------------
// §F (docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md) supersedes §B's shared-bucket
// model: `subtaskViews()` now buckets EVERY subtask by its own id, always. `groupId` is inert.

test('rollupKeyOf: a subtask with no groupId is bucketed under its own id', () => {
  expect(rollupKeyOf(sub('s1'))).toBe('s1')
})

test('rollupKeyOf: a legacy `groupId` is INERT — the subtask is still bucketed under its OWN id, never the group\'s', () => {
  expect(rollupKeyOf(sub('s1', 'g1'))).toBe('s1')
})

// --- subtaskRollupOf -----------------------------------------------------------------------------

test('subtaskRollupOf: finds the bucket by subtask id', () => {
  const r = rollup({ costUSD: 7 })
  const views: SubtaskView[] = [
    { id: 's1', rollup: r, stats: null },
    { id: 's2', rollup: rollup({ costUSD: 3 }), stats: null },
  ]
  expect(subtaskRollupOf(views, sub('s1'))).toBe(r)
})

test('subtaskRollupOf: undefined when the server has no bucket for this subtask', () => {
  const views: SubtaskView[] = [{ id: 's1', rollup: rollup(), stats: null }]
  expect(subtaskRollupOf(views, sub('unknown'))).toBeUndefined()
})

test('subtaskRollupOf: the id:null direct-branch bucket is not confused with a real subtask', () => {
  const views: SubtaskView[] = [{ id: null, rollup: rollup({ costUSD: 99 }), stats: null }]
  expect(subtaskRollupOf(views, sub('s1'))).toBeUndefined()
})

test('subtaskRollupOf: two subtasks that still carry the SAME legacy groupId read their OWN separate buckets, never a shared one', () => {
  // §F supersedes §B's shared-bucket model: `subtaskViews()` no longer collapses a `groupId` into
  // one view, so each subtask's own id is its own bucket — `groupId` is inert.
  const own1 = rollup({ costUSD: 8, sessionsUsed: 2, sessionsLinked: 2 })
  const own2 = rollup({ costUSD: 1 })
  const views: SubtaskView[] = [
    { id: 's1', rollup: own1, stats: null },
    { id: 's2', rollup: own2, stats: null },
  ]
  expect(subtaskRollupOf(views, sub('s1', 'g1'))).toBe(own1)
  expect(subtaskRollupOf(views, sub('s2', 'g1'))).toBe(own2)
})

test('subtaskRollupOf: a subtask with a legacy groupId never falls back to a bucket keyed by the group', () => {
  // If the list happened to carry a stray bucket keyed by the old group id, the subtask's OWN id
  // must still win — reading the group's bucket instead is exactly the §B behaviour this supersedes.
  const own = rollup({ costUSD: 1 })
  const strayGroupBucket = rollup({ costUSD: 9 })
  const views: SubtaskView[] = [
    { id: 's1', rollup: own, stats: null },
    { id: 'g1', rollup: strayGroupBucket, stats: null },
  ]
  expect(subtaskRollupOf(views, sub('s1', 'g1'))).toBe(own)
})

test('subtaskRollupOf: a subtask with no groupId is unaffected by an unrelated bucket', () => {
  const mine = rollup({ costUSD: 4 })
  const views: SubtaskView[] = [
    { id: 'g1', rollup: rollup({ costUSD: 8 }), stats: null },
    { id: 's3', rollup: mine, stats: null },
  ]
  expect(subtaskRollupOf(views, sub('s3'))).toBe(mine)
})

// --- isUntracked -------------------------------------------------------------------------------

test('isUntracked: no bucket at all is untracked', () => {
  expect(isUntracked(undefined)).toBe(true)
})

test('isUntracked: a bucket with sessionsUsed 0 is untracked', () => {
  expect(isUntracked(rollup({ sessionsUsed: 0 }))).toBe(true)
})

test('isUntracked: a bucket with at least one session filed is tracked', () => {
  expect(isUntracked(rollup({ sessionsUsed: 1 }))).toBe(false)
})

// --- subtaskStatsOf ----------------------------------------------------------------------------
// Mirrors `subtaskRollupOf`'s own tests: same key resolution, over the evidence-numbers field
// instead of the cost/session rollup. See docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md
// §C.5.

test('subtaskStatsOf: finds the bucket by subtask id', () => {
  const s = stats({ filesModified: 7 })
  const views: SubtaskView[] = [
    { id: 's1', rollup: rollup(), stats: s },
    { id: 's2', rollup: rollup(), stats: stats({ filesModified: 3 }) },
  ]
  expect(subtaskStatsOf(views, sub('s1'))).toBe(s)
})

test('subtaskStatsOf: undefined when the server has no bucket at all for this subtask', () => {
  const views: SubtaskView[] = [{ id: 's1', rollup: rollup(), stats: stats() }]
  expect(subtaskStatsOf(views, sub('unknown'))).toBeUndefined()
})

test('subtaskStatsOf: null when the bucket exists but nothing is filed under it yet — different from undefined', () => {
  const views: SubtaskView[] = [{ id: 's1', rollup: rollup(), stats: null }]
  expect(subtaskStatsOf(views, sub('s1'))).toBeNull()
})

test('subtaskStatsOf: two subtasks that still carry the SAME legacy groupId read their OWN separate stats buckets, never a shared one', () => {
  const own1 = stats({ filesModified: 10 })
  const own2 = stats({ filesModified: 1 })
  const views: SubtaskView[] = [
    { id: 's1', rollup: rollup(), stats: own1 },
    { id: 's2', rollup: rollup(), stats: own2 },
  ]
  expect(subtaskStatsOf(views, sub('s1', 'g1'))).toBe(own1)
  expect(subtaskStatsOf(views, sub('s2', 'g1'))).toBe(own2)
})

// --- costCellFor -----------------------------------------------------------------------------

test('costCellFor: no bucket at all renders as an empty cell, not even N/A', () => {
  expect(costCellFor(undefined)).toEqual({ kind: 'empty' })
})

test('costCellFor: a subtask with no session filed yet — sessionsUsed 0 — renders as an empty cell, not a fake 0 nor N/A', () => {
  // Reasoning: a subtask with nothing filed under it has not been "measured and found unpriceable"
  // — it simply has no metric to show yet. It gains one the moment a session is linked.
  const r = rollup({ sessionsUsed: 0, sessionsLinked: 0, rounds: null, activeMinutes: null, tokens: null, costUSD: null })
  expect(costCellFor(r)).toEqual({ kind: 'empty' })
})

test('costCellFor: an ordinary priced subtask renders its dollar figure', () => {
  expect(costCellFor(rollup({ costUSD: 12.34 }))).toEqual({ kind: 'money', usd: 12.34 })
})

test('costCellFor: a LINKED session whose cost cannot be computed still renders N/A, never empty', () => {
  // The transition case this correction must not blur: once a session IS filed, a genuinely
  // unpriceable cost is a real (empty) measurement, not "nothing filed yet".
  const r = rollup({ sessionsUsed: 1, sessionsLinked: 1, costUSD: null, credits: null })
  expect(costCellFor(r)).toEqual({ kind: 'money', usd: null })
})

test('costCellFor: mixed currency takes the credits branch even if costUSD is set', () => {
  const r = rollup({ mixedCurrency: true, costUSD: 5, credits: { nanoAiu: 0, premiumRequests: 4 } })
  expect(costCellFor(r)).toEqual({ kind: 'credits', premiumRequests: 4 })
})

test('costCellFor: Copilot-only credits with no USD figure takes the credits branch', () => {
  const r = rollup({ mixedCurrency: false, costUSD: null, credits: { nanoAiu: 0, premiumRequests: 2 } })
  expect(costCellFor(r)).toEqual({ kind: 'credits', premiumRequests: 2 })
})

// --- tokensCellFor ---------------------------------------------------------------------------

test('tokensCellFor: no bucket at all renders as an empty cell', () => {
  expect(tokensCellFor(undefined)).toEqual({ kind: 'empty' })
})

test('tokensCellFor: sessionsUsed 0 renders as an empty cell', () => {
  expect(tokensCellFor(rollup({ sessionsUsed: 0, tokens: null }))).toEqual({ kind: 'empty' })
})

test('tokensCellFor: a linked session with a real token count renders it', () => {
  expect(tokensCellFor(rollup({ sessionsUsed: 1, tokens: 4321 }))).toEqual({ kind: 'tokens', n: 4321 })
})

test('tokensCellFor: a linked session whose tokens could not be read renders N/A (not empty)', () => {
  expect(tokensCellFor(rollup({ sessionsUsed: 1, tokens: null }))).toEqual({ kind: 'tokens', n: null })
})

test('tokensCellFor: gaining a session flips a subtask from empty to a real figure', () => {
  const before = rollup({ sessionsUsed: 0, sessionsLinked: 0, tokens: null, costUSD: null })
  const after = rollup({ sessionsUsed: 1, sessionsLinked: 1, tokens: 500, costUSD: 0.25 })
  expect(tokensCellFor(before)).toEqual({ kind: 'empty' })
  expect(costCellFor(before)).toEqual({ kind: 'empty' })
  expect(tokensCellFor(after)).toEqual({ kind: 'tokens', n: 500 })
  expect(costCellFor(after)).toEqual({ kind: 'money', usd: 0.25 })
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
