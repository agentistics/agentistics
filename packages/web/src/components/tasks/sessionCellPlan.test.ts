import { test, expect } from 'bun:test'
import { planSessionCell, sessionsFiledUnder } from './sessionCellPlan'
import type { TaskSessionRow } from '../../lib/tasks'

function session(over: Partial<TaskSessionRow> = {}): TaskSessionRow {
  return {
    id: 's1', harness: 'claude', cwd: '/repo', attemptId: null, subtaskId: 'sub-a',
    createdAt: '2026-09-11T00:00:00.000Z', model: null, tokens: 1000, costUSD: 1, rounds: 1,
    ...over,
  }
}

// --- sessionsFiledUnder --------------------------------------------------------------------------

test('sessionsFiledUnder: ungrouped — a single id filters exactly like the old subtaskId did', () => {
  const sessions = [
    session({ id: 's1', subtaskId: 'sub-a' }),
    session({ id: 's2', subtaskId: 'sub-b' }),
  ]
  expect(sessionsFiledUnder(sessions, ['sub-a']).map(s => s.id)).toEqual(['s1'])
})

test('sessionsFiledUnder: grouped — a session filed under a SIBLING member shows on this row too', () => {
  const sessions = [
    session({ id: 's1', subtaskId: 'sub-a' }),
    session({ id: 's2', subtaskId: 'sub-b' }),
    session({ id: 's3', subtaskId: 'sub-c' }),
  ]
  // sub-a and sub-b share a group; sub-c does not.
  expect(sessionsFiledUnder(sessions, ['sub-a', 'sub-b']).map(s => s.id)).toEqual(['s1', 's2'])
})

test('sessionsFiledUnder: a session filed directly on the delivery (subtaskId null) never shows on any subtask row', () => {
  const sessions = [session({ id: 's1', subtaskId: null })]
  expect(sessionsFiledUnder(sessions, ['sub-a'])).toEqual([])
})

// --- planSessionCell: display / link ------------------------------------------------------------

test('planSessionCell: nothing filed — empty display, "link" wording, nothing to open or unlink', () => {
  const plan = planSessionCell([], ['sub-a'], true)
  expect(plan.display).toEqual({ kind: 'empty' })
  expect(plan.link).toBe('link')
  expect(plan.open).toBeNull()
  expect(plan.unlink).toEqual({ kind: 'none' })
})

test('planSessionCell: exactly one filed — single display, "another" wording, that session is the direct target', () => {
  const s = session({ id: 's1' })
  const plan = planSessionCell([s], ['sub-a'], true)
  expect(plan.display).toEqual({ kind: 'single', session: s })
  expect(plan.link).toBe('another')
  expect(plan.open).toBe(s)
  expect(plan.unlink).toEqual({ kind: 'one', session: s })
})

test('planSessionCell: several filed — multi display, no direct open target, unlink is a picker', () => {
  const sessions = [session({ id: 's1' }), session({ id: 's2', subtaskId: 'sub-b' })]
  const plan = planSessionCell(sessions, ['sub-a', 'sub-b'], true)
  expect(plan.display).toEqual({ kind: 'multi' })
  expect(plan.link).toBe('another')
  // Ambiguous with several — the compact list is where each one opens from, not this menu.
  expect(plan.open).toBeNull()
  expect(plan.unlink).toEqual({ kind: 'pick' })
})

// --- planSessionCell: open is withheld in every case that would be a dead or ambiguous control ---

test('planSessionCell: open withheld when the caller wired no onOpen at all', () => {
  const plan = planSessionCell([session({ id: 's1' })], ['sub-a'], false)
  expect(plan.open).toBeNull()
  // Unlinking a historical-or-not single session is unaffected by whether opening is offered.
  expect(plan.unlink).toEqual({ kind: 'one', session: expect.objectContaining({ id: 's1' }) })
})

test('planSessionCell: open withheld for a HISTORICAL link even when it is the only one and onOpen is wired', () => {
  const hist = session({ id: 'hist:c1', historical: true })
  const plan = planSessionCell([hist], ['sub-a'], true)
  expect(plan.display).toEqual({ kind: 'single', session: hist })
  expect(plan.open).toBeNull()
  // Unfiling a historical link still works — the server takes the link's own id.
  expect(plan.unlink).toEqual({ kind: 'one', session: hist })
})

test('planSessionCell: open withheld with several filed even when one of them is not historical', () => {
  const sessions = [session({ id: 'live1' }), session({ id: 'hist:c1', historical: true })]
  const plan = planSessionCell(sessions, ['sub-a'], true)
  expect(plan.open).toBeNull()
  expect(plan.unlink).toEqual({ kind: 'pick' })
})
