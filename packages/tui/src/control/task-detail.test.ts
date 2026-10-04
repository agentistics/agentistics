import { describe, expect, test } from 'bun:test'
import { liveSessionOf, taskDetailLines, type TaskDetailView, type TaskDetailWords } from './task-detail'

const W: TaskDetailWords = {
  priority: 'priority', due: 'due', blocked: 'blocked', subtasksOf: (d, t, p) => `${p}% (${d} of ${t} subtasks)`,
  noSubtasks: 'no subtasks, so no progress bar', cost: 'cost', tokens: 'tokens', rounds: 'rounds', na: 'N/A',
  fromSessions: n => `from ${n} sessions`, noSession: 'no session filed yet', subtasksHead: 'SUBTASKS',
  subtaskSessions: n => (n === 1 ? '1 session' : `${n} sessions`), sessionsHead: 'SESSIONS', noSessions: 'none yet · n starts one filed here',
  activityHead: 'ACTIVITY', readOnly: 'read-only here · edit on the web:',
}
const base: TaskDetailView = {
  id: 't-3a68db4599', ref: 't-3a68', title: 'TUI port check', status: 'in_progress', statusLabel: 'In progress',
  rollup: { cost: '$0.66', tokens: '1.2M', rounds: 3, sessions: 4 }, subtasks: [], sessions: [], activity: [], closed: false,
}
const kinds = (l: ReturnType<typeof taskDetailLines>) => l.map(x => x.kind)

describe('task detail (TK-02…TK-07)', () => {
  test('TK-02 rollup from its sessions; N/A — never 0 — when none reported', () => {
    const l = taskDetailLines(base, W, null)
    expect(l.find(x => x.kind === 'rollup')).toMatchObject({ text: 'cost $0.66   tokens 1.2M   rounds 3', right: 'from 4 sessions', na: false })
    const none = taskDetailLines({ ...base, rollup: { cost: null, tokens: null, rounds: null, sessions: 0 } }, W, null)
    expect(none.find(x => x.kind === 'rollup')).toMatchObject({ text: 'cost N/A   tokens N/A   rounds N/A', right: 'no session filed yet', na: true })
  })
  test('TK-03 subtasks each with status and session count; progress only when there are subtasks', () => {
    expect(kinds(taskDetailLines(base, W, null))).toContain('note')
    const l = taskDetailLines({ ...base, progress: { done: 1, total: 3 }, subtasks: [
      { id: 's1', title: 'Port', statusLabel: 'Done', done: true, sessions: 2 },
      { id: 's2', title: 'Verify', statusLabel: 'To do', done: false, sessions: 0 },
    ] }, W, null)
    expect(l.find(x => x.kind === 'progress')).toMatchObject({ text: '33% (1 of 3 subtasks)' })
    expect(l.filter(x => x.kind === 'subtask').map(x => (x as { right: string }).right)).toEqual(['Done · 2 sessions', 'To do · 0 sessions'])
  })
  test('TK-04 sessions with state and cost; enter opens the live one, native first', () => {
    const s = (id: string, harness: string, live: boolean) => ({ id, title: id, harness, state: (live ? 'working' : 'closed') as never, stateLabel: live ? 'working' : 'ended', live })
    const v = { ...base, sessions: [s('a', 'claude', false), s('b', 'claude', true), s('c', 'agentistics', true)] }
    expect(taskDetailLines(v, W, null).filter(x => x.kind === 'session').map(x => (x as { right: string }).right)).toEqual(['ended · N/A', 'working · N/A', 'working · N/A'])
    expect(liveSessionOf(v)?.id).toBe('c')
    expect(liveSessionOf({ ...v, sessions: [s('a', 'claude', false)] })).toBeNull()
    expect(taskDetailLines(base, W, null).some(x => x.kind === 'note' && x.text.startsWith('none yet'))).toBe(true)
  })
  test('TK-05 the blocked reason in words; TK-07 read-only line with the web address', () => {
    const l = taskDetailLines({ ...base, status: 'blocked', statusLabel: 'Blocked', blocked: 'waits on t-e587 Create hello.txt (To do)' }, W, 'http://localhost:47292/')
    expect(l.find(x => x.kind === 'blocked')).toMatchObject({ text: 'blocked: waits on t-e587 Create hello.txt (To do)' })
    expect(l.at(-1)).toEqual({ kind: 'web', text: 'read-only here · edit on the web: http://localhost:47292/tasks/t-3a68db4599' })
  })
})
