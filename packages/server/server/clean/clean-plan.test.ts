import { describe, expect, test } from 'bun:test'
import { formatPlan, planClean, reclaimable, type WorktreeFacts } from './clean-plan'

const DAY = 86_400_000
const NOW = 100 * DAY
const wt = (o: Partial<WorktreeFacts>): WorktreeFacts => ({
  repo: '/r', path: '/r/.wt/x', branch: 'feat/x', isMain: false, missing: false, locked: false, merged: false, dirty: false,
  lastCommitMs: NOW - 4 * DAY, sizeBytes: 500 * 1024 ** 2, nodeModulesBytes: 400 * 1024 ** 2, ...o,
})

describe('planClean', () => {
  test('removes only a pushed, clean, unlocked worktree that is not the main checkout', () => {
    const p = planClean([
      wt({ isMain: true, merged: true, path: '/r' }),
      wt({ merged: true, pushed: true }),
      wt({ merged: true, dirty: true }),
      wt({ merged: true, locked: true }),
    ], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['main', 'remove', 'dirty', 'locked'])
  })

  test('an unmerged worktree untouched for 30 days loses only its node_modules; a recent one is kept as unmerged, never "in use"', () => {
    const p = planClean([wt({ lastCommitMs: NOW - 31 * DAY }), wt({ lastCommitMs: NOW - 31 * DAY, dirty: true }), wt({}), wt({ lastCommitMs: NOW - 31 * DAY, nodeModulesBytes: 0 })], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['node-modules', 'node-modules', 'unmerged', 'unmerged'])
  })

  test('requires a clean published branch; local merges, squash-merges and detached HEAD are kept', () => {
    const p = planClean([wt({ merged: true, pushed: true }), wt({ squashed: true }), wt({ pushed: true, dirty: true }), wt({ pushed: false, squashed: false }), wt({ merged: true }), wt({ branch: null, pushed: true })], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['remove', 'unmerged', 'dirty', 'unmerged', 'unmerged', 'unmerged'])
  })

  test('a merged pull request counts as merged and published, even with the branch gone from origin', () => {
    const p = planClean([wt({ prMerged: true }), wt({ prMerged: true, dirty: true }), wt({ prMerged: true, keepsIgnored: true })], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['remove', 'dirty', 'ignored'])
    expect(p[0]!.action).not.toHaveProperty('savePatch')
  })

  test('pushed but not merged is not "done": kept until idle 30 days, then removed with a patch saved first', () => {
    const p = planClean([wt({ pushed: true }), wt({ pushed: true, lastCommitMs: NOW - 2 * DAY }), wt({ pushed: true, lastCommitMs: NOW - 31 * DAY }), wt({ pushed: true, lastCommitMs: null })], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['unmerged', 'unmerged', 'remove', 'unmerged'])
    expect(p[2]!.action).toMatchObject({ savePatch: true })
  })

  test('a merged worktree with a commit under 3 days old stays, unless its owner session ended for good', () => {
    const HOUR = 3_600_000
    const p = planClean([
      wt({ merged: true, pushed: true, lastCommitMs: NOW - HOUR }),
      wt({ merged: true, pushed: true, lastCommitMs: NOW - HOUR, ownerEnded: true }),
      wt({ merged: true, pushed: true, lastCommitMs: NOW - 4 * DAY }),
      wt({ prMerged: true, lastCommitMs: NOW - HOUR }),
      wt({ merged: true, pushed: true, lastCommitMs: null }),
      wt({ merged: true, pushed: true, lastCommitMs: NOW - 3 * DAY }),
    ], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['young', 'remove', 'remove', 'young', 'young', 'remove'])
    expect(formatPlan([p[0]!], 'pt').join('\n')).toContain('menos de 3 dias')
    expect(formatPlan([p[0]!], 'en').join('\n')).toContain('less than 3 days')
  })

  test('"in use" means a live process inside it, and it protects even a merged worktree', () => {
    const p = planClean([wt({ merged: true, inUse: true }), wt({ lastCommitMs: NOW - 40 * DAY, inUse: true }), wt({ merged: true, pushed: true, inUse: false })], NOW)
    expect(p.map(i => i.action.kind === 'keep' ? i.action.reason : i.action.kind)).toEqual(['active', 'active', 'remove'])
  })

  test('a worktree whose directory is gone is pruned; the total counts what is freed', () => {
    const p = planClean([wt({ missing: true }), wt({ merged: true, pushed: true, sizeBytes: 1024 ** 3 }), wt({ lastCommitMs: NOW - 40 * DAY })], NOW)
    expect(reclaimable(p)).toEqual({ bytes: 1024 ** 3 + 400 * 1024 ** 2, count: 3 })
    const lines = formatPlan(p, 'en', '/r')
    expect(lines[0]).toBe('~')
    expect(lines.at(-1)).toBe('3 items would free 1.4 GB.')
    expect(formatPlan(planClean([wt({})], NOW), 'pt').at(-1)).toContain('Nada a limpar')
  })
})
