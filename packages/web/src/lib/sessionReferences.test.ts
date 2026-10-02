import { describe, expect, test } from 'bun:test'
import { liveEvents } from './artifactTabs'
import { currentAction, edgeHint } from './artifactLayout'
import { liveVerb, sessionReferences, type ReferencesInput } from './sessionReferences'

const base: ReferencesInput = {
  pt: true, task: undefined, canOpenTask: true, canOpenLive: true, live: null, canOpenFull: true,
}
const ids = (i: ReferencesInput) => sessionReferences(i).map(r => r.id)

describe('which references exist, and in what order', () => {
  test('all three, delivery first, then live, then the full reading', () => {
    expect(ids({ ...base, task: 'ALM board' })).toEqual(['task', 'live', 'full'])
  })

  test('a session filed under nothing has NO delivery row — never a dash', () => {
    expect(ids(base)).toEqual(['live', 'full'])
    expect(ids({ ...base, task: '   ' })).toEqual(['live', 'full'])
  })

  test('the full reading is withheld when the caller withholds it', () => {
    expect(ids({ ...base, task: 'x', canOpenFull: false })).toEqual(['task', 'live'])
  })

  test('the live row is absent where the Live tab cannot be opened', () => {
    expect(ids({ ...base, task: 'x', canOpenLive: false })).toEqual(['task', 'full'])
  })

  test('nothing to offer is an EMPTY list, so no heading is drawn over nothing', () => {
    expect(sessionReferences({ ...base, canOpenLive: false, canOpenFull: false })).toEqual([])
  })
})

describe('the delivery row', () => {
  test('is a link to the task, by its name — the ref the board resolves', () => {
    const [row] = sessionReferences({ ...base, task: 'O terminal' })
    expect(row).toMatchObject({
      id: 'task', label: 'Tarefa', detail: 'O terminal', action: { type: 'task', ref: 'O terminal' },
    })
  })

  test('is only NAMED, with no action, where the surface cannot navigate', () => {
    const [row] = sessionReferences({ ...base, task: 'O terminal', canOpenTask: false })
    expect(row).toMatchObject({ id: 'task', detail: 'O terminal', action: null })
  })

  test('is worded in English on request', () => {
    expect(sessionReferences({ ...base, pt: false, task: 'x' })[0]!.label).toBe('Task')
  })
})

describe('the live row', () => {
  const liveRow = (i: Partial<ReferencesInput>) =>
    sessionReferences({ ...base, ...i }).find(r => r.id === 'live')!

  test('a running command is named, and opens THAT step', () => {
    const row = liveRow({ live: { kind: 'ran', text: 'bun test', ref: 'toolu_01' } })
    expect(row).toMatchObject({
      label: 'Ao vivo', detailVerb: 'rodando', detail: 'bun test', action: { type: 'live', ref: 'toolu_01' },
    })
  })

  test('a delegation to a subagent is named as one, and opens the delegation', () => {
    const row = liveRow({ live: { kind: 'delegated', text: 'Review the diff', ref: 'toolu_agent' } })
    expect(row).toMatchObject({
      detailVerb: 'delegando', detail: 'Review the diff', action: { type: 'live', ref: 'toolu_agent' },
    })
  })

  test('an event with no step behind it (reasoning) still opens the feed, from the top', () => {
    const row = liveRow({ live: { kind: 'thought', text: 'Weighing the options' } })
    expect(row.action).toEqual({ type: 'live' })
    expect('ref' in row.action!).toBe(false)
  })

  test('nothing in flight: a plain link to the feed that claims nothing', () => {
    const row = liveRow({ live: null })
    expect(row.action).toEqual({ type: 'live' })
    expect(row.detail).toBeUndefined()
    expect(row.detailVerb).toBeUndefined()
  })

  test('a live event with no text keeps its verb rather than an empty detail', () => {
    const row = liveRow({ live: { kind: 'used', text: '  ' } })
    expect(row.detailVerb).toBe('usando')
    expect(row.detail).toBeUndefined()
  })

  test('every kind an event can have has a verb, in both languages — never `undefined`', () => {
    for (const kind of ['wrote', 'read', 'ran', 'thought', 'delegated', 'used'] as const) {
      expect(liveVerb(kind, true).length).toBeGreaterThan(0)
      expect(liveVerb(kind, false).length).toBeGreaterThan(0)
    }
    expect(liveVerb('ran', false)).toBe('running')
  })
})

describe('the fact behind the live row is the edge strip`s own', () => {
  const turns = [
    { role: 'assistant', text: 'earlier', tools: [{ name: 'Bash', detail: 'ls', ref: 'a' }] },
    {
      role: 'assistant', pending: true, tools: [
        { name: 'Agent', detail: 'Explore the repo', ref: 'toolu_agent' },
      ],
    },
  ]

  test('a pending Agent call is what is in flight, with the id the feed row carries', () => {
    const events = liveEvents(turns)
    expect(currentAction(events)).toEqual({ kind: 'delegated', text: 'Explore the repo', ref: 'toolu_agent' })
    // The ref is the very key the aside's feed focuses a row by.
    expect(events.find(e => e.ref === 'toolu_agent')?.kind).toBe('delegated')
  })

  test('a pending tool call is what is in flight, and finished turns are history', () => {
    const events = liveEvents([
      turns[0]!,
      { role: 'assistant', pending: true, tools: [{ name: 'Bash', detail: 'bun test', ref: 'toolu_b' }] },
    ])
    expect(currentAction(events)).toEqual({ kind: 'ran', text: 'bun test', ref: 'toolu_b' })
    expect(currentAction(liveEvents([turns[0]!]))).toBeNull()
  })

  test('the strip answers the same thing wherever it is allowed to speak', () => {
    const events = liveEvents(turns)
    expect(edgeHint({ open: false, events, isMobile: false })).toEqual(currentAction(events))
    // Gated off on a phone and over an open panel — the reference row is not.
    expect(edgeHint({ open: false, events, isMobile: true })).toBeNull()
    expect(edgeHint({ open: true, events, isMobile: false })).toBeNull()
    expect(currentAction(events)).not.toBeNull()
  })
})
