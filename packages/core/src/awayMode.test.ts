import { describe, expect, it } from 'bun:test'
import { AWAY_NOTE_MAX, awayActive, awayBriefingLines, awayHandoffNote, normalizeAwayInput, normalizeAwayNotice, parseAwayState, type AwayState } from './awayMode'

const NOW = Date.parse('2026-10-12T03:00:00.000Z')
const on = (o: Partial<AwayState> = {}): AwayState => ({ on: true, since: '2026-10-12T02:00:00.000Z', until: null, authorised: ['releases', 'workers'], maxWorkers: 6, maxOpus: 2, ...o })

describe('awayActive', () => {
  it('is on until `until`, and forever with until null', () => {
    expect(awayActive(on(), NOW)).toBe(true)
    expect(awayActive(on({ until: '2026-10-12T12:00:00.000Z' }), NOW)).toBe(true)
    expect(awayActive(on({ until: '2026-10-12T02:59:59.000Z' }), NOW)).toBe(false)
    expect(awayActive(on({ on: false }), NOW)).toBe(false)
    expect(awayActive(null, NOW)).toBe(false)
  })
})

describe('parseAwayState', () => {
  it('reads malformed input as off and drops unknown authorisations', () => {
    expect(parseAwayState('x').on).toBe(false)
    expect(parseAwayState({ on: true, until: 'nope', authorised: ['releases', 'rm-rf', 'releases'] })).toEqual({ on: true, since: '', until: null, authorised: ['releases'], maxWorkers: 6, maxOpus: 2 })
  })
})

describe('normalizeAwayInput', () => {
  it('requires on', () => {
    expect(normalizeAwayInput({}, NOW)).toEqual({ ok: false, error: 'on_required' })
  })
  it('turning off keeps nothing else', () => {
    const r = normalizeAwayInput({ on: false, authorised: ['releases'], note: 'x' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: false, since: '2026-10-12T03:00:00.000Z', until: null, authorised: [], maxWorkers: 6, maxOpus: 2 } })
  })
  it('refuses an unknown authorisation, a past or broken until, a long note', () => {
    expect(normalizeAwayInput({ on: true, authorised: ['everything'] }, NOW)).toMatchObject({ ok: false, error: 'unknown_authorisation' })
    expect(normalizeAwayInput({ on: true, until: '2026-10-11T00:00:00Z' }, NOW)).toMatchObject({ ok: false, error: 'until_in_past' })
    expect(normalizeAwayInput({ on: true, until: 'tomorrow' }, NOW)).toMatchObject({ ok: false, error: 'bad_until' })
    expect(normalizeAwayInput({ on: true, note: 'x'.repeat(AWAY_NOTE_MAX + 1) }, NOW)).toMatchObject({ ok: false, error: 'note_too_long' })
  })
  it('normalises until to ISO and orders authorisations', () => {
    const r = normalizeAwayInput({ on: true, until: '2026-10-12T12:00:00Z', authorised: ['merges', 'releases'], note: '  ship it  ' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: true, since: '2026-10-12T03:00:00.000Z', until: '2026-10-12T12:00:00.000Z', authorised: ['releases', 'merges'], note: 'ship it', maxWorkers: 6, maxOpus: 2 } })
  })
})

describe('awayBriefingLines', () => {
  it('says nothing when inactive or expired', () => {
    expect(awayBriefingLines(null, 'leader', NOW)).toEqual([])
    expect(awayBriefingLines(on({ until: '2026-10-12T01:00:00.000Z' }), 'leader', NOW)).toEqual([])
  })
  it('leader lines: scope, pacing, quality, communication', () => {
    const lines = awayBriefingLines(on({ note: 'focus on QUAL', maxWorkers: 4, maxOpus: 1 }), 'leader', NOW)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe("AWAY MODE — the owner is away until they say they are back. Pre-authorised: publish releases the leader has approved (QA green); open worker sessions within the plan limits; owner's note: focus on QUAL. These authorisations stand in for the owner's approval wherever the rules below ask for it; anything outside them waits in the hand-off file for their return.")
    expect(lines[1]).toContain('Never run more than 4 workers at once, nor more than 1 of them on the strongest model (Opus)')
    expect(lines[1]).toContain('free RAM drops under 2 GB')
    expect(lines[1]).toContain('Sonnet: scoped implementation; Haiku: probes')
    expect(lines[2]).toContain('QA by a different model from the author, tests only in throwaway runs (agentop run --rm)')
    expect(lines[2]).toContain('bundled into one release per batch')
    expect(lines[3]).toContain('never end a turn on a question to the owner')
    expect(lines[3]).toContain('agentistics_session_away with `notice`')
    expect(lines[3]).toContain("in the successor's prompt that the owner is away")
  })
  it('pacing points at the briefing rule when it is there, and states it in full when it is not', () => {
    const pointed = awayBriefingLines(on(), 'leader', NOW, { planLimitsInBriefing: true })[1]!
    expect(pointed).toContain('apply the agentistics_plan_limits rule above')
    expect(pointed).not.toContain('5-hour window')
    const full = awayBriefingLines(on(), 'leader', NOW)[1]!
    expect(full).toContain('keep cadence.parallel workers running; if paceStatus is under, pull work from the queue; hold only when the 5-hour window is at least 85%')
    expect(full).toContain('weekly quota is not a brake unless it is at least 95%')
  })
  it('without the releases authorisation, releases wait for the owner', () => {
    expect(awayBriefingLines(on({ authorised: ['workers'] }), 'leader', NOW)[2]).toContain('releases wait for the owner')
  })
  it('worker line: report to the leader, not the owner', () => {
    const [l] = awayBriefingLines(on({ until: '2026-10-12T12:00:00.000Z' }), 'worker', NOW)
    expect(l).toBe('AWAY MODE — the owner is away until 2026-10-12T12:00:00.000Z. Do not ask the owner anything: send questions, blocks and hand-backs to the session that started you (agentistics_session_message); with no such session, decide within your brief and record the decision.')
  })
  it('auto line names both paths; no authorisations says so', () => {
    const [l] = awayBriefingLines(on({ authorised: [] }), undefined, NOW)
    expect(l).toContain('Pre-authorised: nothing beyond the rules below.')
    expect(l).toContain('otherwise report to the session that started you')
  })
})

describe('awayHandoffNote', () => {
  it('only while active', () => {
    expect(awayHandoffNote(on(), NOW)).toContain('até avisar que voltou')
    expect(awayHandoffNote(on({ on: false }), NOW)).toBe('')
  })
})

describe('ceilings and notices', () => {
  it('refuses a bad ceiling or Opus above workers', () => {
    expect(normalizeAwayInput({ on: true, maxWorkers: 40 }, NOW)).toMatchObject({ ok: false, error: 'bad_ceiling' })
    expect(normalizeAwayInput({ on: true, maxWorkers: 2, maxOpus: 3 }, NOW)).toMatchObject({ ok: false, error: 'bad_ceiling' })
    expect(normalizeAwayInput({ on: true, maxWorkers: 3, maxOpus: 1 }, NOW)).toMatchObject({ ok: true, state: { maxWorkers: 3, maxOpus: 1 } })
  })
  it('notice must be non-empty and bounded', () => {
    expect(normalizeAwayNotice('  ')).toBeNull()
    expect(normalizeAwayNotice('x'.repeat(501))).toBeNull()
    expect(normalizeAwayNotice(' release 2.133 is out ')).toBe('release 2.133 is out')
  })
  it('hand-off note names authorisations and ceilings', () => {
    expect(awayHandoffNote(on(), NOW)).toContain('autorizado: releases, workers; teto 6 workers / 2 Opus')
  })
})
