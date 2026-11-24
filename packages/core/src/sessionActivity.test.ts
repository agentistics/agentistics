import { expect, test } from 'bun:test'
import { activeEvidence, activityApplies, activityState, runningLabel, withoutClocks } from './sessionActivity'

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
  expect(runningLabel({ signal: 'heavy-hold' }, now, true, span)).toBe('rodando')
})

test('waiting on the heavy lock outranks an open tool call: the Bash IS the flock, it is queued, not running', () => {
  const turns = [{ role: 'assistant' as const, text: '', pending: true, at: T }]
  expect(activeEvidence({ turns, heavyLock: 'waiting' })).toEqual({ signal: 'heavy-lock', sinceMs: Date.parse(T) })
  expect(activeEvidence({ heavyLock: true })?.signal).toBe('heavy-lock')
})

test('HOLDING the lock is running (heavy-hold), and ranks after tool and task', () => {
  expect(activeEvidence({ heavyLock: 'holding' })?.signal).toBe('heavy-hold')
  expect(activeEvidence({ turns: [{ role: 'assistant', text: '', pending: true }], heavyLock: 'holding' })?.signal).toBe('tool')
})

test('the queue reads "na fila" / "queued", holding reads "rodando"', () => {
  const now = Date.parse(T) + 33 * 60_000
  expect(runningLabel({ signal: 'heavy-lock' }, now, true, span)).toBe('na fila')
  expect(runningLabel({ signal: 'heavy-lock' }, now, false, span)).toBe('queued')
  expect(runningLabel({ signal: 'heavy-lock', sinceMs: Date.parse(T) }, now, true, span)).toBe('na fila há 33 min')
  expect(runningLabel({ signal: 'heavy-hold' }, now, true, span)).toBe('rodando')
})

test('a finished session is never active, whatever its stale turns say', () => {
  for (const s of ['closed', 'exited', 'lost']) expect(activityApplies(s)).toBe(false)
  expect(activityApplies('running')).toBe(true)
  expect(activityApplies(undefined)).toBe(true)
})

test('withoutClocks blanks timers but keeps real output changes', () => {
  expect(withoutClocks(['esc to interrupt · 1m 23s', 'at 12:34:05'])).toEqual(withoutClocks(['esc to interrupt · 2m 24s', 'at 12:35:06']))
  expect(withoutClocks(['build 41 passed'])).not.toEqual(withoutClocks(['build 42 passed']))
})

test('activityState: evidence turns a prompt-idle row into working; heavy-lock is queued; others keep their state', () => {
  expect(activityState('waiting', 'tool')).toEqual({ state: 'working', queued: false })
  expect(activityState('idle', 'heavy-lock')).toEqual({ state: 'working', queued: true })
  expect(activityState('waiting', null)).toEqual({ state: 'waiting', queued: false })
  for (const s of ['waiting-approval', 'exited', 'lost', 'closed']) expect(activityState(s, 'tool').state).toBe(s)
})
