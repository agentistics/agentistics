import { expect, test } from 'bun:test'
import { activeEvidence, runningLabel } from './sessionActivity'

const T = '2026-11-23T10:00:00Z'
const span = (ms: number) => `${Math.floor(ms / 60_000)} min`

test('an open tool call is activity and carries when it began', () => {
  expect(activeEvidence({ turns: [{ role: 'assistant', text: '', pending: true, at: T }] })).toEqual({ signal: 'tool', sinceMs: Date.parse(T) })
})

test('a closed turn with no other signal is NOT activity', () => {
  expect(activeEvidence({ turns: [{ role: 'assistant', text: 'done', at: T }] })).toBeNull()
  expect(activeEvidence({})).toBeNull()
})

test('a running background task, the heavy lock and moving output each count', () => {
  expect(activeEvidence({ turns: [{ role: 'assistant', text: '', task: { label: 'x', running: true } }, { role: 'assistant', text: 'ok' }] })?.signal).toBe('task')
  expect(activeEvidence({ heavyLock: true })?.signal).toBe('heavy-lock')
  expect(activeEvidence({ outputMoved: true })?.signal).toBe('output')
})

test('an ended background task does not count', () => {
  expect(activeEvidence({ turns: [{ role: 'assistant', text: '', task: { label: 'x', running: false } }] })).toBeNull()
})

test('the sidebar says running, not stopped', () => {
  const now = Date.parse(T) + 33 * 60_000
  expect(runningLabel({ signal: 'tool', sinceMs: Date.parse(T) }, now, true, span)).toBe('rodando há 33 min')
  expect(runningLabel({ signal: 'tool', sinceMs: Date.parse(T) }, now, false, span)).toBe('running 33 min')
  expect(runningLabel({ signal: 'heavy-lock' }, now, true, span)).toBe('rodando')
})
