import { describe, expect, it } from 'bun:test'
import { lastPromptOf, toIdleRow } from './idleRows'

const base = { id: 'a', title: 't', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: '', actionable: true, attached: false, searchFields: {} } as never

describe('toIdleRow', () => {
  it('a row that is not external/closed is managed; task done comes from finishedTasks by label', () => {
    const r = toIdleRow({ ...(base as object), task: 'T', taskId: 't1', lastUserMessageAt: 5, rssBytes: 7 } as never, ['T'])
    expect(r).toMatchObject({ id: 'a', managed: true, taskId: 't1', taskDone: true, lastUserMessageAt: 5, rssBytes: 7 })
  })
  it('external rows are not managed', () => {
    expect(toIdleRow({ ...(base as object), state: 'unknown' } as never, []).managed).toBe(false)
  })
  it('closed rows are not managed either', () => {
    expect(toIdleRow({ ...(base as object), state: 'closed' } as never, []).managed).toBe(false)
  })
  it('a row with no taskId/lastUserMessageAt/conversationId omits them rather than writing undefined', () => {
    const r = toIdleRow(base as never, [])
    expect('taskId' in r).toBe(false)
    expect('lastUserMessageAt' in r).toBe(false)
    expect('conversationId' in r).toBe(false)
    expect(r.taskDone).toBe(false)
  })
  it('a task label with no matching finished task is not done', () => {
    const r = toIdleRow({ ...(base as object), task: 'T' } as never, ['Other'])
    expect(r.taskDone).toBe(false)
  })
  it('missing rssBytes/cpuPercent/contextFraction read as null, never undefined', () => {
    const r = toIdleRow(base as never, [])
    expect(r.rssBytes).toBe(null)
    expect(r.cpuPercent).toBe(null)
    expect(r.contextFraction).toBe(null)
  })
  it('carries contextFraction from context.fraction when present', () => {
    const r = toIdleRow({ ...(base as object), context: { fraction: 0.92, label: '92%', used: '1', window: '2' } } as never, [])
    expect(r.contextFraction).toBe(0.92)
  })
})

describe('lastPromptOf', () => {
  it('is the last user turn, trimmed to 200 chars, else null', () => {
    const r = { ...(base as object), chatTurns: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'x' }, { role: 'user', text: 'y'.repeat(300) }] } as never
    expect(lastPromptOf(r)).toHaveLength(200)
    expect(lastPromptOf(base)).toBe(null)
  })
  it('skips a trailing blank user turn and finds the last non-blank one', () => {
    const r = { ...(base as object), chatTurns: [{ role: 'user', text: 'real prompt' }, { role: 'user', text: '   ' }] } as never
    expect(lastPromptOf(r)).toBe('real prompt')
  })
  it('is null when every turn is the assistant\'s', () => {
    const r = { ...(base as object), chatTurns: [{ role: 'assistant', text: 'hi' }] } as never
    expect(lastPromptOf(r)).toBe(null)
  })
})
