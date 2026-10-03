/**
 * Native sessions filed on the board — a `NativeSessionLink` becomes a row the board's rollups walk,
 * priced by the ENGINE's snapshot, never by a meta or a rate table. Pure, no filesystem (the store
 * round-trip lives in `task-store.test.ts`).
 */
import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { isNativeRow, nativeRows, sanitizeNativeUsage } from './task-native'
import { buildTaskDetail, buildTaskList } from './task-report'
import { buildBoardOverview } from './task-overview'
import { rollupAttempt } from './task-rollup'
import { nativeLinkId, type NativeSessionLink, type NativeSessionUsage, type Subtask, type Task } from './task-model'
import type { ManagedSession } from './types'

const at = (hh: number) => `2026-10-03T${String(hh).padStart(2, '0')}:00:00.000Z`
const task = (id: string): Task => ({ id, title: `Task ${id}`, status: 'in_progress', createdAt: at(1), updatedAt: at(1) } as Task)
const sub = (id: string, taskId: string): Subtask => ({ id, taskId, title: id, status: 'todo', done: false, createdAt: at(1), updatedAt: at(1) } as Subtask)
const usage = (over: Partial<NativeSessionUsage> = {}): NativeSessionUsage => ({
  responses: 3, rounds: 2, tokens: 1500, costUSD: 0.42, costMeasured: true, model: 'anthropic/claude-sonnet-4.6', updatedAt: at(5), ...over,
})
const link = (sid: string, taskId: string, over: Partial<NativeSessionLink> = {}): NativeSessionLink => ({
  id: nativeLinkId(sid), sessionId: sid, taskId, linkedAt: at(3), ...over,
})
const meta = (id: string): SessionMeta => ({
  session_id: id, project_path: '/repo', start_time: at(2), end_time: at(2), harness: 'claude', model: 'claude-sonnet-5',
  input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, user_message_count: 4,
} as SessionMeta)
const cliRow = (over: Partial<ManagedSession>): ManagedSession => ({ id: 'r', harness: 'claude', cwd: '/repo', createdAt: at(2), ...over } as ManagedSession)
const costOf = () => 5

describe('nativeRows', () => {
  it('a flagged row: native harness, the session id as its conversation, the filing stamp, the snapshot', () => {
    const [r] = nativeRows([link('ses_a', 'tA', { subtaskId: 's1', label: 'Fix it', cwd: '/w', usage: usage() })])
    expect(isNativeRow(r!)).toBe(true)
    expect(r).toMatchObject({
      id: 'ses_a', harness: 'agentistics', conversationId: 'ses_a', taskId: 'tA', subtaskId: 's1',
      createdAt: at(3), label: 'Fix it', cwd: '/w', model: 'anthropic/claude-sonnet-4.6', native: true,
    })
    expect(r!.nativeUsage?.costUSD).toBe(0.42)
  })
})

describe('sanitizeNativeUsage', () => {
  it('keeps a well-formed snapshot; drops a negative, non-integer or undated one', () => {
    expect(sanitizeNativeUsage(usage())).toEqual(usage())
    expect(sanitizeNativeUsage(usage({ costUSD: -1 }))).toBeNull()
    expect(sanitizeNativeUsage(usage({ rounds: 1.5 }))).toBeNull()
    expect(sanitizeNativeUsage({ ...usage(), updatedAt: 'x' })).toBeNull()
    // `costMeasured` cannot be claimed for a cost that is not there.
    expect(sanitizeNativeUsage(usage({ costUSD: null, costMeasured: true }))?.costMeasured).toBe(false)
  })
})

describe('the rollup reads the engine snapshot', () => {
  it('a native session counts its cost (measured), tokens and rounds, keyed by its own harness', () => {
    const rows = [cliRow({ id: 'r1', taskId: 'tA', conversationId: 'c1' }), ...nativeRows([link('ses_a', 'tA', { usage: usage() })])]
    const d = buildTaskDetail({ task: task('tA'), attempts: [], rows, metas: new Map([['c1', meta('c1')]]), costOf })
    expect(d.rollup).toMatchObject({
      sessionsUsed: 2, sessionsLinked: 2, costUSD: 5.42, tokens: 1650, rounds: 6,
      costByHarness: { claude: 5, agentistics: 0.42 }, costMeasuredSessions: 1, costEstimatedSessions: 1,
    })
    const n = d.sessions.find(s => s.native)!
    expect(n).toMatchObject({ id: 'ses_a', harness: 'agentistics', conversationId: 'ses_a', costUSD: 0.42, tokens: 1500, rounds: 2 })
  })

  it('with no snapshot yet: a session used, unmeasured — never a confident zero', () => {
    const r = rollupAttempt({ sessions: [] })
    expect(r.costUSD).toBeNull()
    const d = buildTaskDetail({ task: task('tA'), attempts: [], rows: nativeRows([link('ses_a', 'tA')]), metas: new Map(), costOf })
    expect(d.rollup).toMatchObject({ sessionsUsed: 1, sessionsLinked: 0, costUSD: null, tokens: null, rounds: null })
  })

  it('a session filed under a subtask lands in that subtask\'s bucket, and the list total includes it', () => {
    const rows = nativeRows([link('ses_a', 'tA', { subtaskId: 's1', usage: usage() })])
    const d = buildTaskDetail({ task: task('tA'), attempts: [], rows, metas: new Map(), costOf, subtasks: [sub('s1', 'tA')] })
    expect(d.subtaskRollups.find(v => v.id === 's1')?.rollup.costUSD).toBe(0.42)
    const [item] = buildTaskList({ tasks: [task('tA')], attempts: [], rows, metas: new Map(), costOf })
    expect(item!.rollup.costUSD).toBe(0.42)
    expect(item!.harnesses).toEqual(['agentistics'])
  })

  it('the board overview sums it once, with its model and harness', () => {
    const rows = nativeRows([link('ses_a', 'tA', { usage: usage() })])
    const o = buildBoardOverview({ tasks: [task('tA')], rows, metas: new Map(), costOf })
    expect(JSON.stringify(o)).toContain('agentistics')
    expect(o.costByHarness).toEqual({ agentistics: 0.42 })
  })
})
