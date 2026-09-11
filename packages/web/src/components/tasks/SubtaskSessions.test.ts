import { test, expect } from 'bun:test'
import { subtaskSessions } from './SubtaskSessions'
import type { TaskSessionRow } from '../../lib/tasks'

function session(over: Partial<TaskSessionRow> = {}): TaskSessionRow {
  return {
    id: 's1', harness: 'claude', cwd: '/repo', attemptId: null, subtaskId: 'sub-a',
    createdAt: '2026-09-11T00:00:00.000Z', tokens: 1000, costUSD: 1, rounds: 1,
    ...over,
  }
}

/** `subtaskSessions` returns a React element tree without touching the DOM, so its `props.children`
 *  can be inspected directly — same approach `subtaskRollup.test.ts` takes with plain data instead
 *  of rendering. */
function chipIds(node: React.ReactNode): string[] {
  const el = node as { props: { children: React.ReactNode[] } }
  const flat = el.props.children.flat(Infinity as 1)
  return flat
    .filter((c): c is React.ReactElement<{ id: string }> =>
      !!c && typeof c === 'object' && 'props' in c && 'id' in (c as any).props)
    .map(c => c.props.id)
}

const noop = () => {}

test('subtaskSessions: ungrouped — subtaskIds of just its own id filters exactly like the old subtaskId did', () => {
  const sessions = [
    session({ id: 's1', subtaskId: 'sub-a' }),
    session({ id: 's2', subtaskId: 'sub-b' }),
  ]
  const el = subtaskSessions({
    subtaskId: 'sub-a', subtaskIds: ['sub-a'], sessions, lang: 'en',
    onLink: noop, onUnfile: noop,
  })
  expect(chipIds(el)).toEqual(['s1'])
})

test('subtaskSessions: grouped — a session filed under a SIBLING member shows on this row too', () => {
  const sessions = [
    session({ id: 's1', subtaskId: 'sub-a' }),
    session({ id: 's2', subtaskId: 'sub-b' }),
    session({ id: 's3', subtaskId: 'sub-c' }),
  ]
  // sub-a and sub-b share a groupId; sub-c does not.
  const el = subtaskSessions({
    subtaskId: 'sub-a', subtaskIds: ['sub-a', 'sub-b'], sessions, lang: 'en',
    onLink: noop, onUnfile: noop,
  })
  expect(chipIds(el)).toEqual(['s1', 's2'])
})

test('subtaskSessions: a session filed directly on the delivery (subtaskId null) never shows on any subtask row', () => {
  const sessions = [session({ id: 's1', subtaskId: null })]
  const el = subtaskSessions({
    subtaskId: 'sub-a', subtaskIds: ['sub-a'], sessions, lang: 'en',
    onLink: noop, onUnfile: noop,
  })
  expect(chipIds(el)).toEqual([])
})

test('subtaskSessions: linking a new session always targets this row\'s own subtaskId, never a group sibling', () => {
  const linked: { id: string | null } = { id: null }
  const el = subtaskSessions({
    subtaskId: 'sub-a', subtaskIds: ['sub-a', 'sub-b'], sessions: [], lang: 'en',
    onLink: id => { linked.id = id }, onUnfile: noop,
  })
  const button = (el as any).props.children.flat(Infinity).find((c: any) => c?.type === 'button')
  button.props.onClick()
  expect(linked.id).toBe('sub-a')
})
