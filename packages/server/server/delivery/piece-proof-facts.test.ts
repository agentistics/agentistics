/**
 * LIVE.COLUNAS-PRESAS C1 — where the release proof looks for a review piece once its worker left the registry. Shapes from the
 * real board of 2026-11-23: NAVEGADOR S6 (s-62bfcd3629) handed back "commit 8acbd8cd8" from a worktree that no longer has a
 * registry row; the reconcile answered "no repository is known" although the commit is inside PR #1482 (v2.222.0).
 */
import { describe, expect, test } from 'bun:test'
import { matchBatchPr, type BatchPr } from './batch-proof'
import { pieceProofFacts, taskRepoSlug } from './piece-proof-facts'

const FULL = '8acbd8cd82f9d75dd1c7e3142cb94358ab2bfb52'
const PR_1482: BatchPr = {
  repo: 'agentistics/agentistics', number: 1482, title: 'feat(browser): model browser (2.222.0)', body: '', baseRefName: 'main',
  mergeSha: '006e4757a5f1c4d1911da386fbc6fd6a6ddf1bc4', mergedAt: '2026-11-21T07:08:36Z', headRefName: 'release/navegador-2222', commits: [FULL],
}
const noHints = { branches: [], shas: [] }

describe('the piece names its repository and commits without a registry row', () => {
  test('a handback commit resolved in a product clone gives the repo AND a full id the PR match can read', () => {
    const f = pieceProofFacts({ repos: [], hints: noHints, declared: [{ repo: 'agentistics/agentistics', full: FULL }] })
    expect(f.repos).toEqual(['agentistics/agentistics'])
    expect(f.hints.shas).toEqual([FULL])
    const m = matchBatchPr([PR_1482], { subtaskId: 's-62bfcd3629', ...f.hints, repos: f.repos })
    expect(m.ok && m.pr.number).toBe(1482)
  })
  test('the stamped provenance and the task repository count too', () => {
    const f = pieceProofFacts({ repos: [], hints: noHints, provenance: { repos: ['agentistics/agentistics-engine'], commits: [FULL] }, taskRepo: 'https://github.com/agentistics/agentistics.git' })
    expect(f.repos.sort()).toEqual(['agentistics/agentistics', 'agentistics/agentistics-engine'])
    expect(f.hints.shas).toEqual([FULL])
  })
  test('nothing known stays nothing: no repository is invented', () => {
    expect(pieceProofFacts({ repos: [], hints: noHints, taskRepo: '/home/x/projeto' })).toEqual({ repos: [], hints: { branches: [], shas: [] } })
  })
  test('a resolved commit joins the newest statement when the handbacks named one (the latest-statement rule keeps its meaning)', () => {
    const f = pieceProofFacts({ repos: ['agentistics/agentistics'], hints: { branches: [], shas: ['a'.repeat(40)], latest: ['a'.repeat(40)] }, declared: [{ repo: 'agentistics/agentistics', full: FULL }] })
    expect(f.hints.latest).toEqual(['a'.repeat(40), FULL])
  })
  test('taskRepoSlug reads both stored shapes', () => {
    expect(taskRepoSlug('agentistics/agentistics')).toBe('agentistics/agentistics')
    expect(taskRepoSlug('github.com/org/repo')).toBe('org/repo')
    expect(taskRepoSlug('')).toBeNull()
  })
})
