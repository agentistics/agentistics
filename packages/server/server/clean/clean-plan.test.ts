import { describe, expect, test } from 'bun:test'
import { formatPlan, planClean, reclaimable, type WorktreeFacts } from './clean-plan'

const DAY = 86_400_000
const NOW = 100 * DAY
const wt = (o: Partial<WorktreeFacts>): WorktreeFacts => ({
  repo: '/r', path: '/r/.wt/x', branch: 'feat/x', isMain: false, missing: false, locked: false, merged: false, dirty: false,
  lastCommitMs: NOW - DAY, sizeBytes: 500 * 1024 ** 2, nodeModulesBytes: 400 * 1024 ** 2, ...o,
})

describe('planClean', () => {
  test('removes only a merged, clean, unlocked worktree that is not the main checkout', () => {
    const p = planClean([
      wt({ isMain: true, merged: true, path: '/r' }),
      wt({ merged: true }),
      wt({ merged: true, dirty: true }),
      wt({ merged: true, locked: true }),
    ], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['main', 'remove', 'dirty', 'locked'])
  })

  test('an unmerged worktree untouched for 30 days loses only its node_modules; a recent one is kept', () => {
    const p = planClean([wt({ lastCommitMs: NOW - 31 * DAY }), wt({ lastCommitMs: NOW - 31 * DAY, dirty: true }), wt({}), wt({ lastCommitMs: NOW - 31 * DAY, nodeModulesBytes: 0 })], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['node-modules', 'node-modules', 'active', 'unmerged'])
  })

  test('a worktree whose directory is gone is pruned; the total counts what is freed', () => {
    const p = planClean([wt({ missing: true }), wt({ merged: true, sizeBytes: 1024 ** 3 }), wt({ lastCommitMs: NOW - 40 * DAY })], NOW)
    expect(reclaimable(p)).toEqual({ bytes: 1024 ** 3 + 400 * 1024 ** 2, count: 3 })
    const lines = formatPlan(p, 'en', '/r')
    expect(lines[0]).toBe('~')
    expect(lines.at(-1)).toBe('3 items would free 1.4 GB.')
    expect(formatPlan(planClean([wt({})], NOW), 'pt').at(-1)).toContain('Nada a limpar')
  })
})
