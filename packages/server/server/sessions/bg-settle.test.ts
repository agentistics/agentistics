import { describe, expect, test } from 'bun:test'
import { createBgObserver } from './bg-settle'

const result = (id: string, content: unknown, is_error = false) => ({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
})

describe('createBgObserver', () => {
  test('TaskStop pair settles the launch as stopped', () => {
    const o = createBgObserver()
    o.observe(result('t2', '{"message":"Successfully stopped task: b14ngvjin (sleep 600)"}'))
    o.observe(result('t1', 'Command running in background with ID: b14ngvjin. Output is being written to: /tmp/x'))
    expect(o.settle('t1', false)).toBe('stopped')
  })
  test('a denied launch never started', () => {
    const o = createBgObserver()
    o.observe(result('t1', 'Permission for this action was denied by the Claude Code auto mode classifier', true))
    expect(o.settle('t1', false)).toBe('never-started')
  })
  test('a launch result with no background id never started', () => {
    const o = createBgObserver()
    o.observe(result('t1', [{ type: 'text', text: 'ok' }]))
    expect(o.settle('t1', false)).toBe('never-started')
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
