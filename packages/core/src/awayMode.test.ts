import { describe, expect, it } from 'bun:test'
import { AWAY_NOTE_MAX, awayActive, awayBriefingLines, awayHandoffNote, awayTopCap, normalizeAwayInput, normalizeAwayNotice, parseAwayState, readAwaySpawn, resolveSpawnAway, sessionAwayNotice, sessionAwayState, type AwayState } from './awayMode'

const NOW = Date.parse('2026-10-12T03:00:00.000Z')
const on = (o: Partial<AwayState> = {}): AwayState => ({ on: true, since: '2026-10-12T02:00:00.000Z', until: null, authorised: ['releases', 'workers'], maxWorkers: 6, topCaps: { claude: 2 }, ...o })

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
    expect(parseAwayState({ on: true, until: 'nope', authorised: ['releases', 'rm-rf', 'releases'] })).toEqual({ on: true, since: '', until: null, authorised: ['releases'], maxWorkers: 6, topCaps: {} })
  })
})

describe('normalizeAwayInput', () => {
  it('requires on', () => {
    expect(normalizeAwayInput({}, NOW)).toEqual({ ok: false, error: 'on_required' })
  })
  it('turning off keeps nothing else', () => {
    const r = normalizeAwayInput({ on: false, authorised: ['releases'], note: 'x' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: false, since: '2026-10-12T03:00:00.000Z', until: null, authorised: [], maxWorkers: 6, topCaps: {} } })
  })
  it('refuses an unknown authorisation, a past or broken until, a long note', () => {
    expect(normalizeAwayInput({ on: true, authorised: ['everything'] }, NOW)).toMatchObject({ ok: false, error: 'unknown_authorisation' })
    expect(normalizeAwayInput({ on: true, until: '2026-10-11T00:00:00Z' }, NOW)).toMatchObject({ ok: false, error: 'until_in_past' })
    expect(normalizeAwayInput({ on: true, until: 'tomorrow' }, NOW)).toMatchObject({ ok: false, error: 'bad_until' })
    expect(normalizeAwayInput({ on: true, note: 'x'.repeat(AWAY_NOTE_MAX + 1) }, NOW)).toMatchObject({ ok: false, error: 'note_too_long' })
  })
  it('normalises until to ISO and orders authorisations', () => {
    const r = normalizeAwayInput({ on: true, until: '2026-10-12T12:00:00Z', authorised: ['merges', 'releases'], note: '  ship it  ' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: true, since: '2026-10-12T03:00:00.000Z', until: '2026-10-12T12:00:00.000Z', authorised: ['releases', 'merges'], note: 'ship it', maxWorkers: 6, topCaps: {} } })
  })
})

describe('awayBriefingLines', () => {
  it('says nothing when inactive or expired', () => {
    expect(awayBriefingLines(null, 'leader', NOW)).toEqual([])
    expect(awayBriefingLines(on({ until: '2026-10-12T01:00:00.000Z' }), 'leader', NOW)).toEqual([])
  })
  it('leader lines: scope, pacing, quality, communication', () => {
    const lines = awayBriefingLines(on({ note: 'focus on QUAL', maxWorkers: 4, topCaps: { claude: 1, codex: 3 } }), 'leader', NOW)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe("AWAY MODE — the owner is away until they say they are back. Pre-authorised: publish releases the leader has approved (QA green); open worker sessions within the plan limits; owner's note: focus on QUAL. These authorisations stand in for the owner's approval wherever the rules below ask for it; anything outside them waits in the hand-off file for their return.")
    expect(lines[1]).toContain('Never run more than 4 workers at once; at most this many of them on a provider\'s top model tier at once: claude (Opus / Fable) ≤ 1, codex (top GPT tier) ≤ 3, any other provider ≤ 2')
    expect(lines[1]).toContain('free RAM drops under 2 GB')
    expect(lines[1]).toContain('mid tier: scoped implementation; light tier: probes')
    expect(lines[1]).not.toContain('Opus:')
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
  it('refuses a bad ceiling, an unknown provider or a top cap above workers', () => {
    expect(normalizeAwayInput({ on: true, maxWorkers: 40 }, NOW)).toMatchObject({ ok: false, error: 'bad_ceiling' })
    expect(normalizeAwayInput({ on: true, maxWorkers: 2, topCaps: { codex: 3 } }, NOW)).toMatchObject({ ok: false, error: 'bad_ceiling' })
    expect(normalizeAwayInput({ on: true, topCaps: { chatgpt: 1 } }, NOW)).toMatchObject({ ok: false, error: 'bad_ceiling' })
    expect(normalizeAwayInput({ on: true, topCaps: [1] }, NOW)).toMatchObject({ ok: false, error: 'bad_ceiling' })
    expect(normalizeAwayInput({ on: true, maxWorkers: 3, topCaps: { codex: 1, gemini: 0 } }, NOW)).toMatchObject({ ok: true, state: { maxWorkers: 3, topCaps: { codex: 1, gemini: 0 } } })
  })
  it('an older client\'s maxOpus lands in the claude entry; an explicit claude entry wins', () => {
    expect(normalizeAwayInput({ on: true, maxWorkers: 3, maxOpus: 1 }, NOW)).toMatchObject({ ok: true, state: { topCaps: { claude: 1 } } })
    expect(normalizeAwayInput({ on: true, maxWorkers: 2, maxOpus: 3 }, NOW)).toMatchObject({ ok: false, error: 'bad_ceiling' })
    expect(normalizeAwayInput({ on: true, maxOpus: 1, topCaps: { claude: 0 } }, NOW)).toMatchObject({ ok: true, state: { topCaps: { claude: 0 } } })
  })
  it('migrates a stored maxOpus into topCaps.claude and clamps to maxWorkers', () => {
    expect(parseAwayState({ on: true, maxWorkers: 4, maxOpus: 3 }).topCaps).toEqual({ claude: 3 })
    expect(parseAwayState({ on: true, maxWorkers: 2, topCaps: { codex: 5, bogus: 1 } }).topCaps).toEqual({ codex: 2 })
    expect(parseAwayState({ on: true }).topCaps).toEqual({})
  })
  it('a provider with no entry takes the shared default — no harness has its own', () => {
    const s = parseAwayState({ on: true, maxWorkers: 6, topCaps: { codex: 1 } })
    expect(awayTopCap(s, 'codex')).toBe(1)
    expect(awayTopCap(s, 'claude')).toBe(2)
    expect(awayTopCap(s, 'gemini')).toBe(2)
    expect(awayTopCap({ maxWorkers: 1, topCaps: {} }, 'kimi')).toBe(1)
  })
  it('notice must be non-empty and bounded', () => {
    expect(normalizeAwayNotice('  ')).toBeNull()
    expect(normalizeAwayNotice('x'.repeat(501))).toBeNull()
    expect(normalizeAwayNotice(' release 2.133 is out ')).toBe('release 2.133 is out')
  })
  it('hand-off note names authorisations and ceilings', () => {
    expect(awayHandoffNote(on(), NOW)).toContain('autorizado: releases, workers; teto 6 workers / modelo de topo por provedor: claude 2, demais 2')
  })
})

describe('per-session away', () => {
  it('reads the spawn field strictly', () => {
    expect(readAwaySpawn(undefined)).toBeUndefined()
    expect(readAwaySpawn(true)).toBe(true)
    expect(readAwaySpawn(false)).toBe(false)
    expect(readAwaySpawn('inherit')).toBe('inherit')
    expect(readAwaySpawn('true')).toBeNull()
    expect(readAwaySpawn(1)).toBeNull()
  })
  it('a verified away parent passes it on; an explicit false overrides; an unverified parent does not', () => {
    expect(resolveSpawnAway(undefined, { away: true, verified: true })).toBe(true)
    expect(resolveSpawnAway('inherit', { away: true, verified: true })).toBe(true)
    expect(resolveSpawnAway(false, { away: true, verified: true })).toBe(false)
    expect(resolveSpawnAway(undefined, { away: true, verified: false })).toBe(false)
    expect(resolveSpawnAway(undefined, { away: false, verified: true })).toBe(false)
    expect(resolveSpawnAway(undefined, undefined)).toBe(false)
    expect(resolveSpawnAway(true, undefined)).toBe(true)
  })
  it('the global switch covers every session; a session flag covers only it', () => {
    const off = parseAwayState({ on: false, maxWorkers: 4, topCaps: { codex: 1 } })
    expect(sessionAwayState(off, undefined, NOW)).toBeNull()
    expect(sessionAwayState(off, true, NOW)).toEqual({ on: true, since: '', until: null, authorised: ['workers'], maxWorkers: 4, topCaps: { codex: 1 } })
    expect(sessionAwayState(on(), false, NOW)).toEqual(on())
    expect(sessionAwayState(null, true, NOW)?.on).toBe(true)
  })
  it('a session-only away briefing tells a worker not to ask the owner', () => {
    const [l] = awayBriefingLines(sessionAwayState(null, true, NOW), 'worker', NOW)
    expect(l).toContain('Do not ask the owner anything')
  })
  it('the runtime notice is typed only when the effective state changes', () => {
    const off = parseAwayState(null)
    expect(sessionAwayNotice(off, false, true, 'worker', NOW)).toContain('away mode is now ON for this session')
    expect(sessionAwayNotice(off, true, false, 'worker', NOW)).toContain('away mode is now OFF for this session')
    expect(sessionAwayNotice(off, true, true, 'worker', NOW)).toBeNull()
    expect(sessionAwayNotice(on(), true, false, 'worker', NOW)).toBeNull()
  })
})
