/**
 * LIVE.COLUNAS-PRESAS — the review / PR columns on the REAL board of the reporting machine (2026-11-23 12:40Z, owner print
 * 14cc1da3: "Revisão do líder 33 · Sem líder 138 · PR/merge 12", all at 0%). The fixture is every leader/merge piece of that
 * board, redacted (titles and text replaced; ids, statuses, times, filed sessions and the commit ids the comments declare are
 * real), plus the declared commits a release tag proved (`publishedShas`). Each test is RED on 1c280d2be.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLive } from './task-live'
import { describeLive } from './task-live-view'
import { buildTaskDetail } from './task-report'
import type { StatusStage } from '@agentistics/core'

interface Fixture {
  nowMs: number
  statuses: Array<{ id: string; label: string; stage: string }>
  details: Array<{ task: { id: string }; subtasks: object[]; comments: object[]; sessions: object[] }>
  publishedShas: Array<{ sha: string; tag: string }>
  liveCards: Array<{ key: string; stage: string; old: boolean; leaderAvailability?: string | null }>
}
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__/live-colunas/board-2026-11-23.json'), 'utf8')) as Fixture
const nowMs = fixture.nowMs
const details = fixture.details.map(d => buildTaskDetail({
  task: d.task, subtasks: d.subtasks, comments: d.comments, attempts: [], files: [], metas: new Map(), costOf: () => 0,
  rows: d.sessions.map(s => ({ ...s, taskId: d.task.id })),
} as never))
const stageById = new Map(fixture.statuses.map(s => [s.id, s.stage as StatusStage]))
const labels = new Map(fixture.statuses.map(s => [s.id, s.label]))
const publishedShas = new Set(fixture.publishedShas.map(p => p.sha))
// What the reconcile answered for these pieces that morning: "could not be checked: no repository is known" (173 of 183).
const pieceIds = fixture.liveCards.map(c => c.key.split('/').at(-1)!)
const noRepos = { unchecked: new Set(pieceIds), uncheckedWhy: new Map(pieceIds.map(id => [id, 'no-repos' as const])) }
const live = (extra: object = {}) => buildLive({
  details, events: [], nowMs, statusLabel: id => labels.get(id), statusStage: id => stageById.get(id), publishedShas, ...noRepos, ...extra,
})
const all = (r: ReturnType<typeof live>) => [...r.deliveries, ...(r.history ?? []), ...(r.oldReviews ?? [])]
const stageOf = (r: ReturnType<typeof live>, sub: string) => all(r).find(d => d.subtaskId === sub)?.stage

describe('C1 — "no repository is known" never vetoes the commit proof', () => {
  test('a review piece whose declared commit a release holds leaves "Revisão do líder" for Publicado', () => {
    // LIVE.REVISAO-MAC / CALENDARIO.VERSOES-DO-APP: declared commits inside v2.204.3 (PR #1379) / v2.217.2 (PR #1448).
    expect(stageOf(live(), 's-eb2917b46a')).toBe('published')
    expect(stageOf(live(), 's-475a954723')).toBe('published')
  })
  test('on the whole real board, every piece whose newest declared commits are all in a release is Publicado', () => {
    const r = live()
    const moved = all(r).filter(d => d.stage === 'published').map(d => d.subtaskId)
    expect(moved.length).toBe(EXPECTED_PUBLISHED)
    // A piece with no declared commit, or one no tag holds, stays where it was — never promoted on a guess.
    expect(stageOf(r, 's-fa05fa3dee')).toBe('leader') // RUN.SERVE-CWD: commit cited, not released
  })
})

describe('C5 — a record-less piece in PR · merge is promoted by the same proof', () => {
  test('NAVEGADOR pieces shipped in v2.222.0 (PR #1482) leave PR/merge', () => {
    const r = live({ unchecked: undefined, uncheckedWhy: undefined })
    for (const id of ['s-871bea3564', 's-3be4a2daaa', 's-62bfcd3629', 's-99376f43cb']) expect(stageOf(r, id)).toBe('published')
    // NAVEGADOR S1 declared no commit: it stays in PR/merge until somebody proves it.
    expect(stageOf(r, 's-e01cd3dc05')).toBe('merge')
  })
})

describe('C4 — no observed act in review / PR is no step, never "0% · lendo as mudanças"', () => {
  test('every leader / merge card of the real board that has no record carries step null', () => {
    const r = live()
    const cards = all(r).filter(d => d.stage === 'leader' || d.stage === 'merge')
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.filter(d => d.step !== null).map(d => d.key)).toEqual([])
  })
})

describe('C2 — "antigas" are not drawn nor counted in Tudo, but still reach the Antigas group', () => {
  test('the Tudo count is the columns, and the old pieces still ride the reply marked `old`', () => {
    const v = describeLive({ reply: live(), rows: [], leaderIds: new Set(), nowMs, filters: { tab: 'all', period: 'all' } })
    const old = v.deliveries.filter(d => d.old === true)
    expect(old.length).toBeGreaterThan(100)
    expect(v.view.counts.all).toBe(v.deliveries.length - old.length)
  })
})

describe('the owner\'s print, end to end (C1–C5 together)', () => {
  test('Revisão do líder / Sem líder / PR · merge: 33 / 138 / 12 on 1c280d2be → 19 / 4 / 8, no false percent', async () => {
    const { inheritedLeads, mergeLeads } = await import('./leader-succession').catch(() => ({ inheritedLeads: () => new Map(), mergeLeads: (a: Map<string, readonly string[]>) => a }))
    const { rows: registry } = JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__/live-colunas/registry-succession.json'), 'utf8')) as { rows: [] }
    // The two leaders alive that morning, each filed on its own task (Motor, Prontuário).
    const LIVE = new Set(['400fd19590', '3fb06f9a15'])
    const fleet = [{ id: '400fd19590', title: 'L', harness: 'claude', state: 'working', task: 't-e1dea7cd6f' }, { id: '3fb06f9a15', title: 'L', harness: 'claude', state: 'working', task: 't-e3237b6cff' }]
    const v = describeLive({ reply: live(), rows: fleet as never, leaderIds: LIVE, leadsOf: mergeLeads(new Map(), inheritedLeads(registry, LIVE)), nowMs, filters: { tab: 'all', period: 'all' } })
    const drawn = v.deliveries.filter(d => !d.old)
    const count = (pred: (d: typeof drawn[number]) => boolean) => drawn.filter(pred).length
    expect({
      review: count(d => d.stage === 'leader' && d.leaderAvailability !== 'absent'),
      noLeader: count(d => d.stage === 'leader' && d.leaderAvailability === 'absent'),
      merge: count(d => d.stage === 'merge'),
      percent: count(d => (d.stage === 'leader' || d.stage === 'merge') && d.step !== null),
    }).toEqual({ review: 19, noLeader: 4, merge: 8, percent: 0 })
  })
})

// Measured on the fixture: 21 pieces whose newest commit-naming comment declares only commits a release holds (0 on 1c280d2be).
const EXPECTED_PUBLISHED = 21
