import { describe, expect, it } from 'bun:test'
import { AWAY_NOTE_MAX, awayActive, awayBriefingLines, awayHandoffNote, normalizeAwayInput, parseAwayState, type AwayState } from './awayMode'

const NOW = Date.parse('2026-10-12T03:00:00.000Z')
const on = (o: Partial<AwayState> = {}): AwayState => ({ on: true, since: '2026-10-12T02:00:00.000Z', until: null, authorised: ['releases', 'workers'], ...o })

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
    expect(parseAwayState({ on: true, until: 'nope', authorised: ['releases', 'rm-rf', 'releases'] })).toEqual({ on: true, since: '', until: null, authorised: ['releases'] })
  })
})

describe('normalizeAwayInput', () => {
  it('requires on', () => {
    expect(normalizeAwayInput({}, NOW)).toEqual({ ok: false, error: 'on_required' })
  })
  it('turning off keeps nothing else', () => {
    const r = normalizeAwayInput({ on: false, authorised: ['releases'], note: 'x' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: false, since: '2026-10-12T03:00:00.000Z', until: null, authorised: [] } })
  })
  it('refuses an unknown authorisation, a past or broken until, a long note', () => {
    expect(normalizeAwayInput({ on: true, authorised: ['everything'] }, NOW)).toMatchObject({ ok: false, error: 'unknown_authorisation' })
    expect(normalizeAwayInput({ on: true, until: '2026-10-11T00:00:00Z' }, NOW)).toMatchObject({ ok: false, error: 'until_in_past' })
    expect(normalizeAwayInput({ on: true, until: 'tomorrow' }, NOW)).toMatchObject({ ok: false, error: 'bad_until' })
    expect(normalizeAwayInput({ on: true, note: 'x'.repeat(AWAY_NOTE_MAX + 1) }, NOW)).toMatchObject({ ok: false, error: 'note_too_long' })
  })
  it('normalises until to ISO and orders authorisations', () => {
    const r = normalizeAwayInput({ on: true, until: '2026-10-12T12:00:00Z', authorised: ['merges', 'releases'], note: '  ship it  ' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: true, since: '2026-10-12T03:00:00.000Z', until: '2026-10-12T12:00:00.000Z', authorised: ['releases', 'merges'], note: 'ship it' } })
  })
})

describe('awayBriefingLines', () => {
  it('says nothing when inactive or expired', () => {
    expect(awayBriefingLines(null, 'leader', NOW)).toEqual([])
    expect(awayBriefingLines(on({ until: '2026-10-12T01:00:00.000Z' }), 'leader', NOW)).toEqual([])
  })
  it('leader line: until, authorisations, never end on a question, hand-off', () => {
    const [l] = awayBriefingLines(on({ note: 'focus on QUAL' }), 'leader', NOW)
    expect(l).toBe("AWAY MODE — the owner is away until they say they are back. Pre-authorised: publish releases the leader has approved (QA green); open worker sessions within the plan limits; owner's note: focus on QUAL. These authorisations stand in for the owner's approval wherever the rules below ask for it. Never end a turn on a question to the owner: decide within them, record each decision (on the task or in your hand-off file) and keep going; anything outside them waits in the hand-off file for their return. At a hand-off, tell your successor the owner is away (agentistics tells it too).")
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
