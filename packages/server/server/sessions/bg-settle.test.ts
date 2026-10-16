import { describe, expect, test } from 'bun:test'
import { createBgObserver } from './bg-settle'

const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
})
const result = (id: string, content: unknown, is_error = false) => ({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
})

describe('createBgObserver', () => {
  test('TaskStop pair settles the launch as stopped', () => {
    const o = createBgObserver()
    o.observe(result('t2', '{"message":"Successfully stopped task: b14ngvjin (sleep 600)"}'))
    o.observe(use('t2', 'TaskStop', { task_id: 'b14ngvjin' }))
    o.observe(result('t1', 'Command running in background with ID: b14ngvjin. Output is being written to: /tmp/x'))
    expect(o.settle('t1', false)).toBe('stopped')
  })
  test('a denied launch never started', () => {
    const o = createBgObserver()
    // Real denied result (measured, 2026-10), cut after the first sentences.
    o.observe(result('t1', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]. If you have other tasks that don\'t depend on this action, continue working on those.', true))
    expect(o.settle('t1', false)).toBe('never-started')
  })
  test('a successful launch whose text matches no id pattern is NOT labelled never-started', () => {
    const o = createBgObserver()
    o.observe(result('t1', [{ type: 'text', text: 'ok' }]))
    expect(o.settle('t1', false)).toBeNull()
    o.observe(result('t3', { weird: true }))
    expect(o.settle('t3', false)).toBeNull()
    expect(o.settle('t3', true)).toBe('session-ended')
  })
  test('the real background Agent launch result is a running task (agentId)', () => {
    const o = createBgObserver()
    o.observe(result('t1', [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a8b6cc39d1\nThe agent is working in the background.' }]))
    expect(o.settle('t1', false)).toBeNull()
  })
  test('KillShell settles the shell it names as stopped', () => {
    const o = createBgObserver()
    o.observe(result('k1', 'Successfully killed shell: bq1x2y3z (npm run dev)'))
    o.observe(use('k1', 'KillShell', { shell_id: 'bq1x2y3z' }))
    o.observe(result('t1', 'Command running in background with ID: bq1x2y3z'))
    expect(o.settle('t1', false)).toBe('stopped')
  })
  test('stopped text in an ordinary tool result (a cat of a log) does not settle a live task', () => {
    const o = createBgObserver()
    o.observe(result('c1', 'Successfully stopped task: abc123'))
    o.observe(use('c1', 'Bash', { command: 'cat run.log' }))
    o.observe(result('t1', 'Command running in background with ID: abc123'))
    expect(o.settle('t1', false)).toBeNull()
  })
  test('a live launch is unsettled, an ended session settles it', () => {
    const o = createBgObserver()
    o.observe(result('t1', 'Command running in background with ID: abc123'))
    expect(o.settle('t1', false)).toBeNull()
    expect(o.settle('t1', true)).toBe('session-ended')
  })
  test('no result yet (in flight) stays running', () => {
    expect(createBgObserver().settle('t1', false)).toBeNull()
  })
  test('stopping another task does not settle this one', () => {
    const o = createBgObserver()
    o.observe(result('t2', 'Successfully stopped task: other'))
    o.observe(result('t1', 'Command running in background with ID: abc123'))
    expect(o.settle('t1', false)).toBeNull()
  })
})
