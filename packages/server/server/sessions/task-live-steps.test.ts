import { describe, expect, test } from 'bun:test'
import { deriveStep, mergeStep, sessionActivityOf, type StepFacts, type StepSession } from './task-live-steps'
import { buildLive, type LiveDeliveryFacts } from './task-live'
import type { TaskDetail } from './task-report'
import type { TaskEvent } from './task-model'
import { cardPercent, stepSourceNote, STAGE_STEPS } from '../../../web/src/components/tasks/liveCardModel'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()
const SINCE = NOW - H

const act = (over: Partial<NonNullable<StepSession['activity']>> = {}): NonNullable<StepSession['activity']> =>
  ({ edits: 0, tests: 0, commits: 0, browser: false, ...over })
const worker = (activity?: StepSession['activity'], live = true): StepSession => ({ id: 'w', live, isQa: false, ...(activity ? { activity } : {}) })
const qaSession = (activity?: StepSession['activity']): StepSession => ({ id: 'q', live: true, isQa: true, ...(activity ? { activity } : {}) })
const facts = (over: Partial<StepFacts>): StepFacts => ({ stage: 'running', sinceMs: SINCE, sessions: [], handback: false, ...over })

describe('sessionActivityOf — what the transcript says a session DID', () => {
  test('no meta = no signal at all, never a zeroed activity', () => {
    expect(sessionActivityOf(null)).toBeUndefined()
    expect(sessionActivityOf(undefined)).toBeUndefined()
  })
  test('counts file-writing tools, commits, tests and a browser pass', () => {
    expect(sessionActivityOf({ tool_counts: { Read: 9, Edit: 2, Write: 1, MultiEdit: 1, Bash: 5 }, git_commits: 3, test_runs: 4 })).toEqual({ edits: 4, tests: 4, commits: 3, browser: false })
    expect(sessionActivityOf({ tool_counts: { mcp__playwright__browser_click: 3 }, git_commits: 0, test_runs: 0 })!.browser).toBe(true)
    expect(sessionActivityOf({ tool_counts: { mcp__agentistics__agentistics_tasks: 3 }, git_commits: 0 })!.browser).toBe(false)
  })
  test('a transcript that was not counted for tests says null, not zero', () => {
    expect(sessionActivityOf({ tool_counts: {}, git_commits: 0 })!.tests).toBeNull()
  })
})

describe('running — one observed fact per step', () => {
  test('no session at all: nothing is observable', () => {
    expect(deriveStep(facts({ sessions: [] }))).toBeNull()
  })
  test('1 · a session is open (even when its transcript was never read)', () => {
    expect(deriveStep(facts({ sessions: [worker()] }))).toEqual({ step: 1, signal: 'session' })
    expect(deriveStep(facts({ sessions: [worker(act())] }))).toEqual({ step: 1, signal: 'session' })
  })
  test('2 · the first edit', () => {
    expect(deriveStep(facts({ sessions: [worker(act({ edits: 1 }))] }))).toEqual({ step: 2, signal: 'edit' })
  })
  test('3 · a test command ran', () => {
    expect(deriveStep(facts({ sessions: [worker(act({ edits: 4, tests: 1 }))] }))).toEqual({ step: 3, signal: 'tests' })
  })
  test('4 · a commit on the piece\'s branch', () => {
    expect(deriveStep(facts({ sessions: [worker(act({ edits: 4, tests: 1, commits: 1 }))] }))).toEqual({ step: 4, signal: 'commit' })
  })
  test('4 · or the salvo gate saw the head on origin', () => {
    const rec = { phase: 'executando', gates: { salvo: { ok: true, at: iso(NOW - 60_000) } } }
    expect(deriveStep(facts({ sessions: [worker(act())], rec }))).toEqual({ step: 4, signal: 'commit' })
  })
  test('a salvo gate from BEFORE this stage began belongs to an earlier stage', () => {
    const rec = { phase: 'executando', gates: { salvo: { ok: true, at: iso(SINCE - H) } } }
    expect(deriveStep(facts({ sessions: [worker(act())], rec }))).toEqual({ step: 1, signal: 'session' })
  })
  test('5 · the handback', () => {
    expect(deriveStep(facts({ sessions: [worker(act({ commits: 1 }))], handback: true }))).toEqual({ step: 5, signal: 'handback' })
  })
  test('a QA-labelled session is not the author: its tests do not move the running step', () => {
    expect(deriveStep(facts({ sessions: [worker(act()), qaSession(act({ tests: 3 }))] }))).toEqual({ step: 1, signal: 'session' })
  })
})

describe('adjust', () => {
  const adj = (over: Partial<StepFacts>) => facts({ stage: 'adjust', ...over })
  test('1 fixing (a live session) · 3 pushed · 4 handback', () => {
    expect(deriveStep(adj({ sessions: [worker()] }))).toEqual({ step: 1, signal: 'session' })
    expect(deriveStep(adj({ sessions: [worker()], rec: { phase: 'ajuste', gates: { salvo: { ok: true, at: iso(NOW - 1000) } } } }))).toEqual({ step: 3, signal: 'commit' })
    expect(deriveStep(adj({ sessions: [worker()], handback: true }))).toEqual({ step: 4, signal: 'handback' })
  })
  test('no live session and nothing recorded: nothing', () => {
    expect(deriveStep(adj({ sessions: [worker(undefined, false)] }))).toBeNull()
  })
})

describe('qa', () => {
  const qa = (over: Partial<StepFacts>) => facts({ stage: 'qa', ...over })
  test('no QA session: nothing observable', () => {
    expect(deriveStep(qa({ sessions: [worker()] }))).toBeNull()
  })
  test('1 open · 2 tests · 3 browser · 4 verdict recorded', () => {
    expect(deriveStep(qa({ sessions: [qaSession(act())] }))).toEqual({ step: 1, signal: 'session' })
    expect(deriveStep(qa({ sessions: [qaSession(act({ tests: 2 }))] }))).toEqual({ step: 2, signal: 'tests' })
    expect(deriveStep(qa({ sessions: [qaSession(act({ tests: 2, browser: true }))] }))).toEqual({ step: 3, signal: 'browser' })
    expect(deriveStep(qa({ sessions: [qaSession(act())], rec: { phase: 'qa', qa: { at: iso(NOW - 1000) } } }))).toEqual({ step: 4, signal: 'verdict' })
  })
  test('the record names the QA session even without a QA label', () => {
    const s: StepSession = { id: 'x', live: true, isQa: false, activity: act({ tests: 1 }) }
    expect(deriveStep(qa({ sessions: [s], rec: { phase: 'qa', qaSessionId: 'x' } }))).toEqual({ step: 2, signal: 'tests' })
  })
  test('a verdict from a previous QA round is not this stage\'s', () => {
    expect(deriveStep(qa({ sessions: [qaSession(act())], rec: { phase: 'qa', qa: { at: iso(SINCE - H) } } }))).toEqual({ step: 1, signal: 'session' })
  })
})

describe('leader and merge read the delivery record only', () => {
  test('without a record there is no signal', () => {
    expect(deriveStep(facts({ stage: 'leader' }))).toBeNull()
    expect(deriveStep(facts({ stage: 'merge' }))).toBeNull()
  })
  test('leader: 1 stage · 2 deletions gate · 3 decision recorded', () => {
    expect(deriveStep(facts({ stage: 'leader', rec: { phase: 'revisao_lider' } }))).toEqual({ step: 1, signal: 'stage' })
    expect(deriveStep(facts({ stage: 'leader', rec: { phase: 'revisao_lider', gates: { delecoes: { ok: true, at: iso(NOW - 1000) } } } }))).toEqual({ step: 2, signal: 'deletions-gate' })
    expect(deriveStep(facts({ stage: 'leader', rec: { phase: 'revisao_lider', review: { at: iso(NOW - 1000) } } }))).toEqual({ step: 3, signal: 'review' })
  })
  test('a failed gate is not a step', () => {
    expect(deriveStep(facts({ stage: 'leader', rec: { phase: 'revisao_lider', gates: { delecoes: { ok: false, at: iso(NOW - 1000) } } } }))).toEqual({ step: 1, signal: 'stage' })
  })
  test('merge: 1 stage · 2 PR exists · 3 merged', () => {
    expect(deriveStep(facts({ stage: 'merge', rec: { phase: 'pr_merge' } }))).toEqual({ step: 1, signal: 'stage' })
    expect(deriveStep(facts({ stage: 'merge', rec: { phase: 'pr_merge', pr: 12 } }))).toEqual({ step: 2, signal: 'pr' })
    expect(deriveStep(facts({ stage: 'merge', rec: { phase: 'pr_merge', pr: 12, mergeSha: 'abc' } }))).toEqual({ step: 3, signal: 'merged' })
  })
  test('stages with no steps of their own answer null', () => {
    for (const stage of ['queue', 'blocked', 'ci', 'published'] as const) expect(deriveStep(facts({ stage, rec: { phase: 'x' } }))).toBeNull()
  })
})

describe('mergeStep — the larger of what was said and what was seen', () => {
  test('a reported step wins ties and a larger value', () => {
    expect(mergeStep(3, { step: 3, signal: 'tests' })).toEqual({ step: 3, source: 'reported' })
    expect(mergeStep(4, { step: 2, signal: 'edit' })).toEqual({ step: 4, source: 'reported' })
  })
  test('an observed step beats a stale report', () => {
    expect(mergeStep(1, { step: 3, signal: 'tests' })).toEqual({ step: 3, source: 'signals', signal: 'tests' })
  })
  test('either alone, or neither', () => {
    expect(mergeStep(2, null)).toEqual({ step: 2, source: 'reported' })
    expect(mergeStep(null, { step: 1, signal: 'session' })).toEqual({ step: 1, source: 'signals', signal: 'session' })
    expect(mergeStep(null, null)).toBeNull()
  })
})

describe('every derived step is a real position in the card\'s word list', () => {
  test('no signal can name a step the web has no words for', () => {
    const max = (s: keyof typeof STAGE_STEPS) => STAGE_STEPS[s]!.en.length
    expect(deriveStep(facts({ sessions: [worker(act()) ], handback: true }))!.step).toBeLessThanOrEqual(max('running'))
    expect(deriveStep(facts({ stage: 'adjust', sessions: [worker()], handback: true }))!.step).toBeLessThanOrEqual(max('adjust'))
    expect(deriveStep(facts({ stage: 'qa', sessions: [qaSession()], rec: { phase: 'qa', qa: { at: iso(NOW) } } }))!.step).toBeLessThanOrEqual(max('qa'))
    expect(deriveStep(facts({ stage: 'leader', rec: { phase: 'x', review: { at: iso(NOW) } } }))!.step).toBeLessThanOrEqual(max('leader'))
    expect(deriveStep(facts({ stage: 'merge', rec: { phase: 'x', mergeSha: 'a' } }))!.step).toBeLessThanOrEqual(max('merge'))
  })
})

// ------------------------------------------------------------------ through buildLive (what the endpoint and the MCP return)

const detail = (over: Partial<TaskDetail> & { subtasks: TaskDetail['subtasks']; sessions: TaskDetail['sessions'] }): TaskDetail => ({
  task: { id: 't1', title: 'Task one', status: 'in_progress', createdAt: iso(NOW - 24 * H), updatedAt: iso(NOW - H), startedAt: iso(NOW - 24 * H) },
  attempts: [], rollup: {} as never, stats: {} as never, comments: [], commentThreads: [], threads: [], files: [],
  subtaskRollups: [], times: { startedAt: iso(NOW - 24 * H), completedAt: null, durationMs: null, activeMinutes: null, source: 'status' },
  ...over,
} as TaskDetail)
const sub = (id: string, status: string) => ({ id, taskId: 't1', title: `Sub ${id}`, done: false, status, createdAt: iso(NOW - 20 * H), updatedAt: iso(NOW - H) })
const sess = (id: string, extra: object = {}) => ({
  id, harness: 'claude', cwd: '/x', attemptId: null, subtaskId: 'a', createdAt: iso(NOW - 3 * H), model: 'opus', tokens: null, costUSD: null, rounds: null, ...extra,
})

describe('buildLive: the card gets its percent from signals alone', () => {
  const run = (sessions: object[], extra: { events?: TaskEvent[]; deliveries?: Map<string, LiveDeliveryFacts>; comments?: object[]; status?: string } = {}) =>
    buildLive({
      nowMs: NOW, events: extra.events ?? [], deliveries: extra.deliveries,
      details: [detail({ subtasks: [sub('a', extra.status ?? 'in_progress')] as never, sessions: sessions as never, comments: (extra.comments ?? []) as never })],
    }).deliveries[0]!

  test('BEFORE: a worker that never reported a step drew no percent — now an edit places it on "implementando"', () => {
    const d = run([sess('s1', { activity: act({ edits: 3 }) })])
    expect(d.step).toBe(2)
    expect(d.stepSource).toBe('signals')
    expect(d.stepSignal).toBe('edit')
    expect(cardPercent(d as never, true)).toMatchObject({ pct: 20, step: 2, of: 5, label: 'implementando' })
  })
  test('with no transcript read the card still knows the session is open (step 1), and no more', () => {
    const d = run([sess('s1')])
    expect(d.step).toBe(1)
    expect(cardPercent(d as never, true)).toMatchObject({ pct: 0, step: 1, label: 'lendo o pedido' })
  })
  test('a worker that reported a larger step is believed; the card says it was reported', () => {
    const events: TaskEvent[] = [{ id: 'e', taskId: 't1', subtaskId: 'a', actor: 'x', kind: 'step', to: '4', at: iso(NOW - 600_000) } as TaskEvent]
    const d = run([sess('s1', { activity: act({ edits: 3 }) })], { events })
    expect(d.step).toBe(4)
    expect(d.stepSource).toBe('reported')
    expect(stepSourceNote(d, true)).toContain('relatado')
  })
  test('a handback comment on the piece reads as "entregando"', () => {
    const comments = [{ id: 'c', taskId: 't1', subtaskId: 'a', author: 'x', body: 'done', kind: 'handback', createdAt: iso(NOW - 60_000) }]
    const d = run([sess('s1', { activity: act({ edits: 3, tests: 1, commits: 1 }) })], { comments })
    expect(d.step).toBe(5)
    expect(d.stepSignal).toBe('handback')
  })
  test('a handback from before this stage began is history', () => {
    const comments = [{ id: 'c', taskId: 't1', subtaskId: 'a', author: 'x', body: 'old', kind: 'handback', createdAt: iso(NOW - 10 * H) }]
    expect(run([sess('s1', { activity: act({ edits: 1 }) })], { comments }).step).toBe(2)
  })
  test('a legacy piece in review (no record) has nothing observable: no step, no line', () => {
    const d = run([sess('s1', { endedAt: iso(NOW - H) })], { status: 'in_review' })
    expect(d.stage).toBe('leader')
    expect(d.step).toBeNull()
    expect(d.stepSource).toBeNull()
    expect(cardPercent(d as never, true)).toBeNull()
  })
  test('a delivery record in revisao_lider with a recorded review reads step 3 of the leader stage', () => {
    const deliveries = new Map<string, LiveDeliveryFacts>([['a', { phase: 'revisao_lider', review: { at: iso(NOW - 1000) } } as LiveDeliveryFacts]])
    const d = run([sess('s1')], { deliveries, status: 'in_review' })
    expect(d.stage).toBe('leader')
    expect(d.step).toBe(3)
    expect(d.stepSignal).toBe('review')
  })
  test('the card note names the observed fact', () => {
    const d = run([sess('s1', { activity: act({ edits: 1, tests: 2 }) })])
    expect(stepSourceNote(d, true)).toBe('passo lido de fatos observados: a sessão rodou testes')
    expect(stepSourceNote(d, false)).toBe('step read from observed facts: the session ran tests')
    expect(stepSourceNote({ stepSource: null, stepSignal: null }, true)).toBeNull()
  })
})
