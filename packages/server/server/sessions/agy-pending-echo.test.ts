import { describe, expect, test } from 'bun:test'
import { pendingEchoes } from '@agentistics/core'
import { parseAntigravityChat } from './antigravity-chat'

// An antigravity transcript as agy writes it: the person's text arrives wrapped, with harness metadata.
const step = (i: number, source: string, type: string, content: string) =>
  JSON.stringify({ step_index: i, source, type, status: 'DONE', created_at: '2026-10-05T10:00:00Z', content })
const wrapped = (t: string) => `<USER_REQUEST>\n${t}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-05T07:00:00-03:00.\n</ADDITIONAL_METADATA>`

describe('antigravity: a delivered message and its answer resolve in the chat', () => {
  const lines = [
    step(0, 'USER_EXPLICIT', 'USER_INPUT', wrapped('does the build pass?')),
    step(1, 'MODEL', 'PLANNER_RESPONSE', 'Yes, the build passes.'),
  ]
  test('the user turn is the person\'s own text (no wrapper) and the answer is drawn', () => {
    const turns = parseAntigravityChat(lines, 'antigravity', 400)
    expect(turns.map(t => [t.role, t.text])).toEqual([['user', 'does the build pass?'], ['assistant', 'Yes, the build passes.']])
  })
  test('the pending echo is cleared once the transcript holds that message', () => {
    const users = parseAntigravityChat(lines, 'antigravity', 400).filter(t => t.role === 'user').map(t => t.text)
    expect(pendingEchoes(['does the build pass?'], users)).toEqual([])
    expect(pendingEchoes(['a message not written yet'], users)).toEqual(['a message not written yet'])
  })
})
