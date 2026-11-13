import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '../../../core/src/gitTestEnv'
import { buildLive, prepareForecastHistory, recordTrailOf, resolvePieceForecast, stageTypicals, type Sample } from './task-live'
import { firstTagContaining } from './release-tags'
import type { TaskDetail } from './task-report'

const NOW = Date.parse('2026-11-13T01:50:00Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

function detail(subtasks: unknown[], sessions: unknown[]): TaskDetail {
  return {
    task: { id: 't1', title: 'Task', status: 'in_progress', createdAt: iso(NOW - 99 * H), updatedAt: iso(NOW - H) },
    attempts: [], rollup: {} as never, stats: {} as never, comments: [], commentThreads: [], threads: [], files: [],
    subtaskRollups: [], times: { startedAt: null, completedAt: null, durationMs: null, activeMinutes: null, source: null },
    subtasks, sessions,
  } as unknown as TaskDetail
}
const sub = (id: string, status: string, extra: object = {}) => ({
  id, taskId: 't1', title: `Sub ${id}`, done: status === 'done', status, createdAt: iso(NOW - 50 * H), updatedAt: iso(NOW - 2 * H), ...extra,
})
const sess = (id: string, subtaskId: string, extra: object = {}) => ({
  id, harness: 'claude', cwd: '/x', attemptId: null, subtaskId, createdAt: iso(NOW - 3 * H), model: 'opus', tokens: null, costUSD: null, rounds: null, ...extra,
})

describe('item 4 — a QA session named after the task still makes the piece qa', () => {
  test('the QA worktree (`.worktrees/qa-…`) is the witness when the title says nothing', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail([sub('a', 'in_progress')], [
        sess('author', 'a', { label: 'LIVRO 3b worker', cwd: '/h/agentistics/.worktrees/livro-seams-3b-pub', harness: 'codex' }),
        sess('qa', 'a', { label: 'LIVRO 3b round 3', cwd: '/h/agentistics/.worktrees/qa-livro-3b-r3' }),
      ])],
    })
    expect(r.deliveries[0]!.stage).toBe('qa')
  })
  test('an author whose worktree merely contains the letters qa is not QA', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail([sub('a', 'in_progress')], [sess('w', 'a', { label: 'worker', cwd: '/h/.worktrees/aqua-feature' })])],
    })
    expect(r.deliveries[0]!.stage).toBe('running')
  })
})

describe('item 3 — stage durations come from the delivery record phase history', () => {
  test('recordTrailOf reads every phase of the record, not only the three the board knows', () => {
    const t = recordTrailOf([
      { to: 'executando', at: iso(NOW - 10 * H) }, { to: 'qa', at: iso(NOW - 6 * H) },
      { to: 'revisao_lider', at: iso(NOW - 3 * H) }, { to: 'publicado', at: iso(NOW - H) },
    ], NOW - H)
    expect(t.map(v => [v.stage, v.ms / H])).toEqual([['running', 4], ['qa', 3], ['leader', 2], ['published', 0]])
  })
  test('three published pieces with record histories give measured typicals for the stages they crossed', () => {
    const trails = [0, 1, 2].map(i => recordTrailOf([
      { to: 'executando', at: iso(NOW - (20 + i) * H) }, { to: 'qa', at: iso(NOW - (12 + i) * H) },
      { to: 'revisao_lider', at: iso(NOW - (8 + i) * H) }, { to: 'publicado', at: iso(NOW - 2 * H) },
    ], NOW - 2 * H))
    const typ = stageTypicals(trails)
    expect(typ.leader).toMatchObject({ n: 3 })
    expect(typ.running!.medianMs).toBeGreaterThan(0)
  })
  test('prepareForecastHistory builds typicals from records when the board events carry no stages', () => {
    const subs = [1, 2, 3, 4].map(i => sub(`p${i}`, 'done', { deliveredAt: iso(NOW - 30 * H) }))
    const sessions = subs.map((s, i) => sess(`s${i}`, s.id, { createdAt: iso(NOW - 100 * H) }))
    const d = detail(subs, sessions)
    ;(d as unknown as { subtaskRollups: unknown[] }).subtaskRollups = subs.map(s => ({ id: s.id, times: { source: 'sessions', startedAt: iso(NOW - 100 * H), completedAt: iso(NOW - 30 * H), durationMs: 70 * H, activeMinutes: 60 } }))
    const deliveries = new Map(subs.map((s, i) => [s.id, {
      phase: 'publicado', publishedAt: iso(NOW - 30 * H),
      history: [
        { to: 'executando', at: iso(NOW - (100 + i) * H) }, { to: 'qa', at: iso(NOW - (60 + i) * H) },
        { to: 'revisao_lider', at: iso(NOW - (50 + i) * H) }, { to: 'publicado', at: iso(NOW - 30 * H) },
      ],
    }]))
    const h = prepareForecastHistory({ details: [d], events: [], nowMs: NOW, deliveries: deliveries as never })
    expect(h.typicals.leader?.n).toBeGreaterThanOrEqual(3)
  })
})

describe('item 3 — measured history replaces the flat ceilings', () => {
  const samples: Sample[] = [10, 12, 14, 16].map((h, i) => ({
    key: `k${i}`, harness: 'codex', model: 'luna', taskType: null, endpoint: 'publication',
    startedAtMs: NOW - (30 + h) * H, completedAtMs: NOW - 30 * H, durationMs: h * H,
  }))
  const run = (extra: object = {}) => resolvePieceForecast({
    nowMs: NOW, startedAtMs: NOW - 5 * H, stage: 'leader', sinceMs: NOW - H, origin: null,
    harness: 'codex', model: 'luna', samples, typicals: {}, ...extra,
  })
  test('with ≥3 measured publications and no stage history the publish ETA is the cohort median, not +3d ceiling', () => {
    const e = run().publishEta
    expect(e.kind).toBe('estimate')
    if (e.kind !== 'estimate') return
    expect(e.source).not.toBe('stages')
    expect(e.basis?.n).toBe(4)
    expect(e.atMs).toBeLessThan(NOW + 24 * H) // median 13h from start 5h ago ⇒ well inside a day, never +6d
  })
  test('with NO history at all the declared ceilings still answer (low confidence)', () => {
    const e = resolvePieceForecast({ nowMs: NOW, startedAtMs: NOW - H, stage: 'leader', sinceMs: NOW - H, origin: null, harness: 'codex', model: 'luna', samples: [], typicals: {} }).publishEta
    expect(e).toMatchObject({ kind: 'estimate', source: 'stages', confidence: 'low' })
  })
})

describe('item 2 — the first release tag containing a commit is the version it shipped in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagrepo-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env: { ...gitTestEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim()
  test('earliest tag wins; an untagged commit has none', async () => {
    git('init', '-q', '-b', 'main')
    const commit = (n: string) => { writeFileSync(join(dir, n), n); git('add', n); git('commit', '-q', '-m', n); return git('rev-parse', 'HEAD') }
    const a = commit('a'); git('tag', 'v2.209.3')
    const b = commit('b'); git('tag', 'v2.210.0'); git('tag', 'v2.210.1')
    const c = commit('c')
    expect(await firstTagContaining(a, [dir])).toBe('2.209.3')
    expect(await firstTagContaining(b, [dir])).toBe('2.210.0')
    expect(await firstTagContaining(c, [dir])).toBeNull()
    expect(await firstTagContaining('zzz', [dir])).toBeNull()
  })
})
