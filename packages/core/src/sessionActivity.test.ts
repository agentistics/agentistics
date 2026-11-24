import { expect, test } from 'bun:test'
import { activeEvidence, activityApplies, activityState, OUTPUT_BASELINE_MAX_MS, outputMovedSince, runningLabel, withoutClocks } from './sessionActivity'

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

const reading = (lines: string[], atMs: number) => ({ key: lines.join('\n'), clockFree: withoutClocks(lines).join('\n'), atMs })

test('withoutClocks blanks only WALL-CLOCK times; durations and other numbers are content', () => {
  expect(withoutClocks(['at 12:34:05', 'clock 2026-11-24T05:00:00.000Z'])).toEqual(withoutClocks(['at 12:35:06', 'clock 2026-11-24T06:00:00.000Z']))
  // QA r3 probe: a duration in a log is meaningful output.
  expect(withoutClocks(['test elapsed 45s'])).not.toEqual(withoutClocks(['test elapsed 46s']))
  expect(withoutClocks(['build 41 passed'])).not.toEqual(withoutClocks(['build 42 passed']))
  expect(withoutClocks(['build output 1795000000000'])).not.toEqual(withoutClocks(['build output 1796800000000']))
})

test('outputMovedSince: a timestamp a command prints counts against a RECENT read (heartbeat log)', () => {
  const now = Date.parse(T)
  expect(outputMovedSince(reading(['Heartbeat received at 12:34:01', '❯ '], now - 5_000), reading(['Heartbeat received at 12:34:06', '❯ '], now))).toBe(true)
  expect(outputMovedSince(reading(['Heartbeat received at 12:34:01'], now - 60_000), reading(['Heartbeat received at 12:35:01'], now))).toBe(true)
  expect(outputMovedSince(reading(['same'], now - 5_000), reading(['same'], now))).toBe(false)
  expect(outputMovedSince(undefined, reading(['first'], now))).toBe(false)
})

test('outputMovedSince: a change in nothing but a time of day against an OLD read is a repainted clock, not activity', () => {
  const now = Date.parse(T)
  const clock = (ms: number) => reading([`clock ${new Date(ms).toISOString()}`], ms)
  expect(outputMovedSince(clock(now - OUTPUT_BASELINE_MAX_MS), clock(now))).toBe(true)
  expect(outputMovedSince(clock(now - OUTPUT_BASELINE_MAX_MS - 1), clock(now))).toBe(false)
  expect(outputMovedSince(clock(now - 30 * 60_000), clock(now))).toBe(false)
  expect(outputMovedSince({ ...clock(now), atMs: now + 1_000 }, clock(now))).toBe(false)
})

test('outputMovedSince: any other content that changed counts whatever the gap', () => {
  const now = Date.parse(T)
  expect(outputMovedSince(reading([`build output ${now - 30 * 60_000}`], now - 30 * 60_000), reading([`build output ${now}`], now))).toBe(true)
  expect(outputMovedSince(reading(['test elapsed 45s'], now - 30 * 60_000), reading(['test elapsed 46s'], now))).toBe(true)
})

test('activityState: evidence turns a prompt-idle row into working; heavy-lock is queued; others keep their state', () => {
  expect(activityState('waiting', 'tool')).toEqual({ state: 'working', queued: false })
  expect(activityState('idle', 'heavy-lock')).toEqual({ state: 'working', queued: true })
  expect(activityState('waiting', null)).toEqual({ state: 'waiting', queued: false })
  for (const s of ['waiting-approval', 'exited', 'lost', 'closed']) {
    expect(activityState(s, 'tool').state).toBe(s)
    expect(activityState(s, 'heavy-lock')).toEqual({ state: s, queued: false })
  }
})

test('activityState: a row ALREADY working that waits on the heavy lock is queued (sidebar and Live agree)', () => {
  expect(activityState('working', 'heavy-lock')).toEqual({ state: 'working', queued: true })
  expect(activityState('working', 'tool')).toEqual({ state: 'working', queued: false })
  expect(activityState('working', null)).toEqual({ state: 'working', queued: false })
})
