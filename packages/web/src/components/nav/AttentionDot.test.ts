import { describe, expect, test } from 'bun:test'
import { attentionCount, attentionIds, needsAttention, pruneDismissed } from './AttentionDot'

const row = (id: string, state: string) => ({ id, state }) as { id: string; state: never }

describe('needsAttention', () => {
  test('waiting and waiting-approval want a person; working and the rest do not', () => {
    expect(needsAttention(row('a', 'waiting'))).toBe(true)
    expect(needsAttention(row('a', 'waiting-approval'))).toBe(true)
    expect(needsAttention(row('a', 'working'))).toBe(false)
    expect(needsAttention(row('a', 'exited'))).toBe(false)
  })
})

describe('dismissing', () => {
  const rows = [row('a', 'waiting'), row('b', 'working'), row('c', 'waiting-approval')]

  test('counts only the waiting ones, and honours the dismissed set', () => {
    expect(attentionCount(rows)).toBe(2)
    expect(attentionCount(rows, new Set(['a']))).toBe(1)
    expect(attentionCount(rows, new Set(['a', 'c']))).toBe(0)
  })

  test('a dismiss writes down exactly the ids that were counting', () => {
    expect(attentionIds(rows)).toEqual(['a', 'c'])
    expect(attentionIds(rows, new Set(['a']))).toEqual(['c'])
  })

  test('a dismissal is forgotten once its session stops waiting, so the NEXT wait counts again', () => {
    const dismissed = new Set(['a', 'c'])
    // a went back to work, c is still waiting
    const later = pruneDismissed(dismissed, [row('a', 'working'), row('b', 'working'), row('c', 'waiting')])
    expect([...later]).toEqual(['c'])
    // a asks again: it is no longer dismissed
    expect(attentionCount([row('a', 'waiting'), row('c', 'waiting')], later)).toBe(1)
  })

  test('a session that disappears from the list is forgotten too', () => {
    expect([...pruneDismissed(new Set(['gone']), [row('a', 'waiting')])]).toEqual([])
  })

  test('nothing to forget returns the same set, so callers can skip the update', () => {
    const dismissed = new Set(['a'])
    expect(pruneDismissed(dismissed, [row('a', 'waiting')])).toBe(dismissed)
    const empty = new Set<string>()
    expect(pruneDismissed(empty, rows)).toBe(empty)
  })
})
