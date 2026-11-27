import { test, expect } from 'bun:test'
import { StaleAnswer, staleNoteOf, toolText, withStaleNote } from './stale-note'

test('a stale /api/data answer is told to the agent in a second block; the JSON keeps its shape', () => {
  const v = withStaleNote({ total: 3 }, { stale: true, staleBuiltAt: '2026-11-26T10:00:00.000Z' })
  expect(v).toBeInstanceOf(StaleAnswer)
  const out = toolText(v)
  expect(out.content).toHaveLength(2)
  expect(JSON.parse(out.content[0]!.text)).toEqual({ total: 3 })
  expect(out.content[1]!.text).toContain('previous build')
  expect(out.content[1]!.text).toContain('2026-11-26T10:00:00.000Z')
})

test('a current answer carries no note', () => {
  expect(staleNoteOf({ sessions: [] })).toBeNull()
  expect(staleNoteOf(null)).toBeNull()
  const v = withStaleNote([1, 2], { stale: false })
  expect(v).toEqual([1, 2])
  expect(toolText(v).content).toHaveLength(1)
})
