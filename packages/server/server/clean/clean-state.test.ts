import { describe, expect, test } from 'bun:test'
import { CLEAN_LOG_LIMIT, newCleanScan, scanEstimate, scanLog, wireCleanPlan } from './clean-state'
import { planClean, type WorktreeFacts } from './clean-plan'

const fact = (overrides: Partial<WorktreeFacts> = {}): WorktreeFacts => ({ repo: '/repo', path: '/repo/.worktrees/finished-name', branch: 'done', isMain: false,
  missing: false, locked: false, merged: true, dirty: false, lastCommitMs: 1000, lastActivityMs: 2000, sizeBytes: 4096, nodeModulesBytes: 1024, ...overrides })

describe('live clean state', () => {
  test('starts with honest counters, no ETA and no stale log from another scan', () => {
    const a = newCleanScan('a', 100)
    scanLog(a, { at: 101, state: 'running', name: 'a' })
    expect(newCleanScan('b', 102)).toMatchObject({ id: 'b', state: 'scanning', step: 1, progress: 0, etaMs: null, foundBytes: 0, log: [], background: false })
  })
  test('keeps the last twenty log lines in chronological order', () => {
    const state = newCleanScan('a', 0)
    for (let n = 0; n < 40; n++) scanLog(state, { at: n, state: n % 2 ? 'done' : 'queued', name: String(n) })
    expect(state.log).toHaveLength(CLEAN_LOG_LIMIT)
    expect(state.log[0]?.name).toBe('20')
    expect(state.log.at(-1)?.name).toBe('39')
  })
  test('ETA follows elapsed work and the bar never regresses when another repo adds items', () => {
    const state = newCleanScan('a', 1000)
    scanEstimate(state, 2, 4, 3000)
    expect(state.etaMs).toBe(2000)
    const progress = state.progress
    scanEstimate(state, 2, 20, 4000)
    expect(state.etaMs).toBeNull() // 10% < 15%: no honest estimate yet
    expect(state.progress).toBe(progress)
    expect(state.progress).toBeLessThan(1)
    scanEstimate(state, 20, 20, 5000)
    expect(state.etaMs).toBeNull()
  })
})

describe('wire cleanup result', () => {
  test('keeps folder name, project, activity and zero-byte missing records', () => {
    const scan = newCleanScan('scan', 0)
    const plan = wireCleanPlan(planClean([fact(), fact({ path: '/repo/.worktrees/gone', missing: true, sizeBytes: 0, lastActivityMs: null, lastCommitMs: null })], 3000), scan, 3000)
    expect(plan.items[0]).toMatchObject({ name: 'finished-name', project: 'repo', lastActivityMs: 2000, bytes: 4096 })
    expect(plan.items[1]).toMatchObject({ name: 'gone', kind: 'prune', bytes: 0, lastActivityMs: null })
    expect(plan).toMatchObject({ scanId: 'scan', scannedAt: 3000, elapsedMs: 3000, reclaimable: { bytes: 4096, count: 2 } })
  })
  test('shows protected/dirty items but excludes them from reclaimable bytes and count', () => {
    const facts = [fact(), fact({ path: '/repo/.worktrees/dirty', dirty: true, nodeModulesBytes: 0 }), fact({ path: '/repo/.worktrees/free' })]
    const plan = wireCleanPlan(planClean(facts, 3000), newCleanScan('scan', 0), 3000, new Map([[facts[0]!.path, 'an active session']]))
    expect(plan.items.map(i => i.kind)).toEqual(['keep', 'keep', 'remove'])
    expect(plan.items[0]?.reason).toBe('an active session')
    expect(plan.reclaimable).toEqual({ bytes: 4096, count: 1 })
  })
  test('lastActivity is display metadata and does not change the old safety decisions', () => {
    const now = 40 * 86_400_000
    const plan = wireCleanPlan(planClean([fact({ merged: false, lastCommitMs: 1000, lastActivityMs: now })], now), newCleanScan('scan', 0), now)
    expect(plan.items[0]).toMatchObject({ kind: 'node-modules', name: 'finished-name/node_modules', lastActivityMs: now, bytes: 1024 })
  })
})
