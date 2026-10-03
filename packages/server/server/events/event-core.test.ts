import { describe, expect, test } from 'bun:test'
import { DEDUPE_WINDOW_MS, dedupeEvents, isDuplicate } from './event-dedupe'
import { MAX_TAIL_LINES, parseEvent, parseEvents, serializeEvent } from './event-line'
import { EMPTY_MEMORY, planEvents, seedMemory, type EventMemory } from './event-plan'
import { EMPTY_CURSOR, advanceCursor, planRead, planRotation } from './event-rotate'
import { EVENT_VERSION, type EventCandidate, type EventKind, type SessionEvent } from './event-types'
import { deliver, eventMuteKey } from './notifier'
import type { SessionActivity } from '../sessions/types'

const NOW = '2026-08-14T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)

const ev = (o: Partial<SessionEvent>): SessionEvent => ({
  v: EVENT_VERSION, seq: 1, at: NOW, source: 'poll', kind: 'waiting',
  id: 's1', cwd: '/w', ...o,
})

const sess = (o: Partial<EventCandidate>): EventCandidate => ({ id: 's1', cwd: '/w', ...o })

/**
 * Two polls make a state. `run` walks a sequence of readings through the planner exactly as the
 * producer does, so what these tests exercise is the real loop rather than one call to it.
 */
const run = (
  readings: SessionActivity[][],
  o: { seed?: boolean; kinds?: readonly EventKind[] } = {},
): { events: SessionEvent[][]; memory: EventMemory } => {
  const toSessions = (row: SessionActivity[]): EventCandidate[] =>
    row.map((activity, i) => sess({ id: `s${i + 1}`, activity }))
  let memory: EventMemory = EMPTY_MEMORY
  const events: SessionEvent[][] = []
  for (const [i, row] of readings.entries()) {
    if (i === 0 && o.seed !== false) { memory = seedMemory(toSessions(row)); events.push([]); continue }
    const r = planEvents({ memory, sessions: toSessions(row), nowIso: NOW, ...(o.kinds ? { kinds: o.kinds } : {}) })
    memory = r.memory
    events.push(r.events)
  }
  return { events, memory }
}

const kinds = (rows: SessionEvent[][]): string[] => rows.flat().map(e => e.kind)

describe('planEvents', () => {
  test('a change held for two polls is an event, and it carries the state it came from', () => {
    const out = planEvents({
      memory: { lastSeen: new Map([['s1', 'waiting-approval']]), confirmed: new Map([['s1', 'working']]) },
      sessions: [sess({ activity: 'waiting-approval', harness: 'claude', task: 'canal' })],
      nowIso: NOW,
    })
    expect(out.events).toHaveLength(1)
    expect(out.events[0]).toMatchObject({ kind: 'waiting-approval', from: 'working', task: 'canal', source: 'poll' })
  })

  test('the same state twice is not an event — a level never rings', () => {
    expect(kinds(run([['waiting'], ['waiting'], ['waiting'], ['waiting']]).events)).toEqual([])
  })

  test('a session never seen before produces nothing — a restart must not replay the fleet', () => {
    expect(kinds(run([['waiting'], ['waiting']]).events)).toEqual([])
  })

  test('a real turn is reported: several polls of work, then the wait', () => {
    expect(kinds(run([
      ['waiting'], ['working'], ['working'], ['working'], ['waiting'], ['waiting'],
    ]).events)).toEqual(['working', 'waiting'])
  })

  test('the DEFAULT subscription hears only the wait, not the work that led to it', () => {
    expect(kinds(run(
      [['waiting'], ['working'], ['working'], ['waiting'], ['waiting']],
      { kinds: ['waiting', 'waiting-approval', 'exited'] },
    ).events)).toEqual(['waiting'])
  })

  test('a ONE-FRAME blip is not a state — the repaint that made this rule exist', () => {
    // Measured on a real fleet: the pane redrew for a single poll, `attention.ts` correctly read
    // the movement as `working`, and the next frame was `waiting` again. Nothing happened.
    expect(kinds(run([
      ['waiting'], ['working'], ['waiting'], ['waiting'], ['waiting'],
    ]).events)).toEqual([])
  })

  test('a blip much later is suppressed too — the rule is not a time window', () => {
    const quiet: SessionActivity[][] = Array.from({ length: 20 }, () => ['waiting'])
    expect(kinds(run([...quiet, ['working'], ['waiting'], ['waiting']]).events)).toEqual([])
  })

  test('a `working` nobody subscribed to still advances what the channel believes', () => {
    // Or the real `waiting` that follows would compare against a stale `waiting` and be swallowed.
    expect(kinds(run(
      [['waiting'], ['working'], ['working'], ['waiting'], ['waiting']],
      { kinds: ['waiting'] },
    ).events)).toEqual(['waiting'])
  })

  test('kinds narrow what is written, per session', () => {
    const r = run([
      ['working', 'working'], ['waiting', 'exited'], ['waiting', 'exited'],
    ], { kinds: ['exited'] })
    expect(r.events.flat().map(e => e.id)).toEqual(['s2'])
  })

  test('the memory carries only sessions still on screen', () => {
    const r = run([['waiting', 'waiting'], ['waiting', 'waiting'], ['waiting']])
    expect([...r.memory.confirmed.keys()]).toEqual(['s1'])
  })

  test('seeding treats what is on screen as already true, so nothing is reported about it', () => {
    const seeded = seedMemory([sess({ activity: 'waiting-approval' })])
    expect(seeded.confirmed.get('s1')).toBe('waiting-approval')
    const out = planEvents({ memory: seeded, sessions: [sess({ activity: 'waiting-approval' })], nowIso: NOW })
    expect(out.events).toEqual([])
  })

  test('a row with no activity is never remembered, so acquiring one is not a transition', () => {
    const seeded = seedMemory([sess({ id: 'ext', activity: undefined })])
    expect(seeded.confirmed.has('ext')).toBe(false)
    const a = planEvents({ memory: seeded, sessions: [sess({ id: 'ext', activity: 'waiting' })], nowIso: NOW })
    const b = planEvents({ memory: a.memory, sessions: [sess({ id: 'ext', activity: 'waiting' })], nowIso: NOW })
    expect(b.events).toEqual([])
  })
})

describe('serializeEvent / parseEvent', () => {
  test('a screen tail with newlines in it stays ONE line', () => {
    const line = serializeEvent(ev({ lines: ['a\nb', 'c\r\nd'] }))
    expect(line.split('\n').filter(s => s !== '')).toHaveLength(1)
    const back = parseEvent(line)
    expect(back?.lines).toEqual(['a b', 'c d'])
  })

  test('the tail is clamped by the writer, wherever the writer is', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const back = parseEvent(serializeEvent(ev({ lines: many })))
    expect(back?.lines).toHaveLength(MAX_TAIL_LINES)
    expect(back?.lines?.[MAX_TAIL_LINES - 1]).toBe('line 39')
  })

  test('a round trip preserves a field this version does not know about', () => {
    const line = serializeEvent({ ...ev({}), somethingNew: 42 } as unknown as SessionEvent)
    expect((parseEvent(line) as unknown as { somethingNew: number }).somethingNew).toBe(42)
  })

  test('a line from a FUTURE version is unreadable rather than half-understood', () => {
    expect(parseEvent(JSON.stringify({ ...ev({}), v: EVENT_VERSION + 1 }))).toBeNull()
  })

  test('junk in the middle of the file costs that line and nothing else', () => {
    const text = [serializeEvent(ev({ id: 'a' })), 'not json\n', '{"v":1}\n', serializeEvent(ev({ id: 'b' }))].join('')
    const r = parseEvents(text)
    expect(r.events.map(e => e.id)).toEqual(['a', 'b'])
    expect(r.unreadable).toBe(2)
  })
})

describe('dedupe', () => {
  const hook = ev({ source: 'hook', kind: 'turn-end', harness: 'claude', cwd: '/repo', conversationId: 'c1' })

  test('the poller is suppressed by a hook for the same conversation inside the window', () => {
    const poll = ev({ source: 'poll', kind: 'waiting', harness: 'claude', cwd: '/repo', conversationId: 'c1' })
    expect(isDuplicate(poll, [hook], NOW_MS + 3_000)).toBe(true)
  })

  test('the MEASURED gap is inside the window — 32s between the hook and the poll copy', () => {
    // Real numbers from a live fleet: hook 13:58:12.738, poll 13:58:44.818. The first window was
    // 20s, sized before `event-plan.ts` began requiring two consecutive polls, and the user was
    // told twice.
    const poll = ev({ source: 'poll', kind: 'waiting', harness: 'claude', cwd: '/repo', conversationId: 'c1' })
    expect(isDuplicate(poll, [hook], NOW_MS + 32_080)).toBe(true)
  })

  test('well outside the window it is a second turn, not a duplicate', () => {
    const poll = ev({ source: 'poll', kind: 'waiting', harness: 'claude', cwd: '/repo', conversationId: 'c1' })
    expect(isDuplicate(poll, [hook], NOW_MS + DEDUPE_WINDOW_MS + 1)).toBe(false)
  })

  test('a hook event is never suppressed by a poll event — the exact record always lands', () => {
    const poll = ev({ source: 'poll', kind: 'waiting', harness: 'claude', cwd: '/repo', conversationId: 'c1' })
    expect(isDuplicate(hook, [poll], NOW_MS + 1_000)).toBe(false)
  })

  test('waiting-approval is never deduped — it is the event nobody may lose', () => {
    const poll = ev({ source: 'poll', kind: 'waiting-approval', harness: 'claude', cwd: '/repo', conversationId: 'c1' })
    expect(isDuplicate(poll, [hook], NOW_MS + 1_000)).toBe(false)
  })

  test('the cwd fallback applies only to claude', () => {
    const claude = ev({ source: 'poll', kind: 'waiting', harness: 'claude', cwd: '/repo' })
    const codex = ev({ source: 'poll', kind: 'waiting', harness: 'codex', cwd: '/repo' })
    const hookNoConv = ev({ source: 'hook', kind: 'turn-end', harness: 'claude', cwd: '/repo' })
    expect(isDuplicate(claude, [hookNoConv], NOW_MS)).toBe(true)
    expect(isDuplicate(codex, [hookNoConv], NOW_MS)).toBe(false)
  })

  test('an empty history suppresses nothing', () => {
    const poll = ev({ source: 'poll', kind: 'waiting', harness: 'claude', cwd: '/repo' })
    expect(dedupeEvents([poll], [], NOW_MS)).toHaveLength(1)
  })
})

describe('rotation and the cursor', () => {
  test('rotation happens before the write that would exceed the cap', () => {
    expect(planRotation(900, 200, 1000)).toBe(true)
    expect(planRotation(700, 200, 1000)).toBe(false)
    expect(planRotation(0, 5000, 1000)).toBe(false) // an empty file is never rotated
  })

  test('a cursor past the end of the file means rotated — read from the start and SAY so', () => {
    expect(planRead({ offset: 900, seq: 40 }, 100)).toEqual({ from: 0, rotated: true })
  })

  test('a sequence ahead of the file is rotated even when the offset still fits', () => {
    expect(planRead({ offset: 50, seq: 40 }, 5000, 3)).toEqual({ from: 0, rotated: true })
  })

  test('an ordinary resume reads from where it stopped', () => {
    expect(planRead({ offset: 50, seq: 3 }, 5000, 9)).toEqual({ from: 50, rotated: false })
  })

  test('the empty cursor reads the whole file and is not a rotation', () => {
    expect(planRead(EMPTY_CURSOR, 5000, 9)).toEqual({ from: 0, rotated: false })
    expect(advanceCursor(120, 7)).toEqual({ offset: 120, seq: 7 })
  })
})

describe('a muted session is not delivered', () => {
  const ev = (id: string, conversationId?: string): SessionEvent => ({
    v: EVENT_VERSION, seq: 1, at: '2026-10-02T10:00:00.000Z', source: 'poll', kind: 'waiting',
    id, cwd: '/tmp/x', ...(conversationId ? { conversationId } : {}),
  })
  // A peer that cannot exist: an attempt shows up as `peersFailed`, so "no attempt" is observable
  // without touching a desktop.
  const sub = [{ id: 's1', createdAt: '2026-10-02T10:00:00.000Z', kinds: ['waiting' as const], notify: 'no-such-peer-xyz', desktop: false }]

  test('the mute key is the conversation when known, the id otherwise', () => {
    expect(eventMuteKey(ev('m1', 'c1'))).toBe('c1')
    expect(eventMuteKey(ev('m1'))).toBe('m1')
  })
  test('a muted key causes no peer delivery attempt; an unmuted one does', async () => {
    const quiet = await deliver({ events: [ev('m1', 'c1')], subscriptions: sub, muted: new Set(['c1']) })
    expect(quiet.peersFailed + quiet.peersReached + quiet.toastsShown).toBe(0)
    const loud = await deliver({ events: [ev('m1', 'c1')], subscriptions: sub, muted: new Set(['other']) })
    expect(loud.peersFailed + loud.peersReached).toBe(1)
  })
})
