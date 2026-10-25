import { describe, expect, it } from 'bun:test'
import {
  CRASH_MAX_AGE_MS, CRASH_WINDOW_MS, HEARTBEAT_MS, OFFER_LIMIT, planCrashGroup, planFellOffer,
} from './crash-group'
import type { ManagedSession } from './types'

const NOW = 1_786_700_000_000

const row = (id: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id,
  harness: 'claude',
  cwd: '/repo/a',
  createdAt: '2026-08-13T10:00:00.000Z',
  lastSeenMs: NOW,
  ...over,
})

const ids = (o: ReturnType<typeof planCrashGroup>) => (o?.entries ?? []).map(e => e.id)

describe('planCrashGroup', () => {
  it('groups the sessions the backend no longer knows about, sharing one heartbeat', () => {
    const group = planCrashGroup({ now: NOW,
      entries: [row('a'), row('b'), row('c')],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['a', 'b', 'c'])
    expect(group?.atMs).toBe(NOW)
  })

  it('keeps registry order, so a task comes back the way it was built', () => {
    const group = planCrashGroup({ now: NOW,
      entries: [row('c'), row('a'), row('b')],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['c', 'a', 'b'])
  })

  // --- the garbage rules, which are the whole point ------------------------------------------

  it('never includes a session the user FINISHED — that is a decision, not a fall', () => {
    const group = planCrashGroup({ now: NOW,
      entries: [row('a'), row('done', { endedAt: '2026-08-13T11:00:00.000Z' })],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['a'])
  })

  it('never includes a session the backend still holds, running or exited', () => {
    // tmux keeps a finished session listable (`remain-on-exit`), so a command that ended on its own
    // is still something the backend can name. Nothing took it.
    const group = planCrashGroup({ now: NOW,
      entries: [row('a'), row('alive'), row('deadPane')],
      backendIds: new Set(['alive', 'deadPane']),
    })
    expect(ids(group)).toEqual(['a'])
  })

  it('never includes a row with no evidence it was ever alive', () => {
    // A registry written by an older build, or a row this process never once saw. It is EXCLUDED
    // rather than guessed at from `createdAt` — which is equally true of a session abandoned three
    // weeks ago, and is exactly how a crash group turns into a list of everything that ever ran.
    const group = planCrashGroup({ now: NOW,
      entries: [row('a'), row('legacy', { lastSeenMs: undefined })],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['a'])
  })

  it('refuses a lastSeenMs that is not a real number, however the file got that way', () => {
    // `managed-sessions.json` is hand-editable. A NaN reaching the comparison below would put an
    // always-false test in charge of which sessions get reopened.
    const group = planCrashGroup({ now: NOW,
      entries: [row('a'), row('junk', { lastSeenMs: Number.NaN })],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['a'])
  })

  it('leaves out an OLDER fall — a machine that crashed twice has two events, not one', () => {
    const group = planCrashGroup({ now: NOW,
      entries: [
        row('old', { lastSeenMs: NOW - 3 * 24 * 60 * 60_000 }),
        row('new1'),
        row('new2'),
      ],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['new1', 'new2'])
    expect(group?.atMs).toBe(NOW)
  })

  it('is null when nothing qualifies, rather than an empty group', () => {
    expect(planCrashGroup({ now: NOW, entries: [], backendIds: new Set() })).toBeNull()
    expect(planCrashGroup({ now: NOW,
      entries: [row('a', { endedAt: 'x' })],
      backendIds: new Set(),
    })).toBeNull()
  })

  it('expires a 33-day-old fall even when it is the latest group', () => {
    expect(planCrashGroup({ now: NOW, entries: [row('ancient', {
      lastSeenMs: NOW - 33 * 24 * 60 * 60_000,
    })], backendIds: new Set() })).toBeNull()
  })

  it('includes fresh falls through 24 hours, then expires them without a new fall', () => {
    const entries = [row('fresh')]
    expect(ids(planCrashGroup({ now: NOW + CRASH_MAX_AGE_MS, entries, backendIds: new Set() }))).toEqual(['fresh'])
    expect(planCrashGroup({ now: NOW + CRASH_MAX_AGE_MS + 1, entries, backendIds: new Set() })).toBeNull()
  })

  it('excludes future heartbeat stamps instead of letting them hide a real recent fall', () => {
    expect(ids(planCrashGroup({ now: NOW, entries: [row('fresh'), row('future', {
      lastSeenMs: NOW + CRASH_WINDOW_MS + 1,
    })], backendIds: new Set() }))).toEqual(['fresh'])
  })

  // --- the window ----------------------------------------------------------------------------

  it('absorbs one heartbeat of spread, which is the widest a genuine fall can be', () => {
    // The oldest possible member carries the previous heartbeat's stamp while a session created
    // just after it carries its own creation stamp. That gap is one interval, and no more.
    const group = planCrashGroup({ now: NOW,
      entries: [row('older', { lastSeenMs: NOW - HEARTBEAT_MS }), row('newer')],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['older', 'newer'])
  })

  it('is wider than the heartbeat, or a real fall would be split into two groups', () => {
    expect(CRASH_WINDOW_MS).toBeGreaterThan(HEARTBEAT_MS)
  })

  it('excludes anything outside the window, erring toward leaving a real casualty out', () => {
    // The deliberate direction of the error: a session wrongly left out is still on screen with its
    // own Reopen verb — one keypress. A session wrongly let in is invisible, and makes the whole
    // group untrustworthy.
    const group = planCrashGroup({ now: NOW,
      entries: [row('edge', { lastSeenMs: NOW - CRASH_WINDOW_MS - 1 }), row('now')],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['now'])
  })

  it('includes a lone session — one thing open when the laptop died is one thing that fell', () => {
    const group = planCrashGroup({ now: NOW, entries: [row('a')], backendIds: new Set() })
    expect(ids(group)).toEqual(['a'])
  })

  it('says nothing about whether a row can be RESUMED — that is planTaskReopen business', () => {
    // Filtering unresolvable rows here would make the group quietly smaller than the fall it
    // describes; `planTaskReopen` already reports them as skipped AND counted.
    const group = planCrashGroup({ now: NOW,
      entries: [row('a', { harness: 'gemini' })],
      backendIds: new Set(),
    })
    expect(ids(group)).toEqual(['a'])
  })
})

describe('planFellOffer', () => {
  const conv = (sessionId: string, title = sessionId) => ({ sessionId, title })
  const all = (e: ManagedSession) => conv(`c-${e.id}`)

  it('names each row with the user own label, falling back to the conversation title', () => {
    const out = planFellOffer({
      entries: [row('a', { label: 'my work' }), row('b')],
      conversationFor: e => conv(`c-${e.id}`, `titled ${e.id}`),
    })
    expect(out.map(o => o.label)).toEqual(['my work', 'titled b'])
  })

  it('drops a row whose conversation does not resolve — a button that fails is not an offer', () => {
    const out = planFellOffer({
      entries: [row('a'), row('b')],
      conversationFor: e => (e.id === 'a' ? conv('c-a') : null),
    })
    expect(out.map(o => o.entry.id)).toEqual(['a'])
  })

  it('is NARROWER than the fall, and only here — the count must not shrink with it', () => {
    // A row that cannot be reopened still fell. `planCrashGroup` keeps it so the summary row and the
    // heading describe the event, and `reopenEntries` reports it as skipped rather than pretending
    // it was never there.
    const entries = [row('a'), row('cannot')]
    const group = planCrashGroup({ now: NOW, entries, backendIds: new Set() })
    expect(group?.entries).toHaveLength(2)
    expect(planFellOffer({
      entries: group!.entries,
      conversationFor: e => (e.id === 'a' ? conv('c-a') : null),
    })).toHaveLength(1)
  })

  it('is newest first — what someone was in the middle of is the recent work', () => {
    const out = planFellOffer({
      entries: [
        row('old', { createdAt: '2026-08-01T10:00:00.000Z' }),
        row('new', { createdAt: '2026-08-14T10:00:00.000Z' }),
      ],
      conversationFor: all,
    })
    expect(out.map(o => o.entry.id)).toEqual(['new', 'old'])
  })

  it('survives a start time nobody can read, rather than sorting it as 1970', () => {
    const out = planFellOffer({
      entries: [row('bad', { createdAt: 'not a date' }), row('good')],
      conversationFor: all,
    })
    expect(out.map(o => o.entry.id)).toEqual(['good', 'bad'])
    expect(out.find(o => o.entry.id === 'bad')?.startedMs).toBeUndefined()
  })

  it('is BOUNDED — a modal listing forty rows is a wall, not an offer', () => {
    const many = Array.from({ length: 40 }, (_, i) => row(`s${i}`))
    expect(planFellOffer({ entries: many, conversationFor: all })).toHaveLength(OFFER_LIMIT)
    expect(planFellOffer({ entries: many, conversationFor: all, limit: 3 })).toHaveLength(3)
  })

  it('is empty for an empty fall, without inventing a row', () => {
    expect(planFellOffer({ entries: [], conversationFor: all })).toEqual([])
  })
})
