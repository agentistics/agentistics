import { describe, expect, it, test } from 'bun:test'
import { AUTONOMOUS_ON_RULE, AWAY_NOTE_MAX, autonomousSpawnMode, awayActive, awayBriefingLines, awayHandoffNote, awayTopCap, normalizeAwayInput, normalizeAwayNotice, parseAwayState, readAwaySpawn, resolveSpawnAway, sessionAwayNotice, sessionAwayState, type AwayState } from './awayMode'

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
    expect(parseAwayState({ on: true, until: 'nope', authorised: ['releases', 'rm-rf', 'releases'] })).toEqual({ on: true, since: '', until: null, authorised: ['releases'], maxWorkers: 4, topCaps: {} })
  })
})

describe('normalizeAwayInput', () => {
  it('requires on', () => {
    expect(normalizeAwayInput({}, NOW)).toEqual({ ok: false, error: 'on_required' })
  })
  it('turning off keeps nothing else', () => {
    const r = normalizeAwayInput({ on: false, authorised: ['releases'], note: 'x' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: false, since: '2026-10-12T03:00:00.000Z', until: null, authorised: [], maxWorkers: 4, topCaps: {} } })
  })
  it('refuses an unknown authorisation, a past or broken until, a long note', () => {
    expect(normalizeAwayInput({ on: true, authorised: ['everything'] }, NOW)).toMatchObject({ ok: false, error: 'unknown_authorisation' })
    expect(normalizeAwayInput({ on: true, until: '2026-10-11T00:00:00Z' }, NOW)).toMatchObject({ ok: false, error: 'until_in_past' })
    expect(normalizeAwayInput({ on: true, until: 'tomorrow' }, NOW)).toMatchObject({ ok: false, error: 'bad_until' })
    expect(normalizeAwayInput({ on: true, note: 'x'.repeat(AWAY_NOTE_MAX + 1) }, NOW)).toMatchObject({ ok: false, error: 'note_too_long' })
  })
  it('normalises until to ISO and orders authorisations', () => {
    const r = normalizeAwayInput({ on: true, until: '2026-10-12T12:00:00Z', authorised: ['merges', 'releases'], note: '  ship it  ' }, NOW)
    expect(r).toEqual({ ok: true, state: { on: true, since: '2026-10-12T03:00:00.000Z', until: '2026-10-12T12:00:00.000Z', authorised: ['releases', 'merges'], note: 'ship it', maxWorkers: 4, topCaps: {} } })
  })
})

describe('awayBriefingLines', () => {
  it('says nothing when inactive or expired', () => {
    expect(awayBriefingLines(null, 'leader', NOW)).toEqual([])
    expect(awayBriefingLines(on({ until: '2026-10-12T01:00:00.000Z' }), 'leader', NOW)).toEqual([])
  })
  it('leader lines: scope, pacing, quality, communication', () => {
    const lines = awayBriefingLines(on({ note: 'focus on QUAL', maxWorkers: 4, topCaps: { claude: 1, codex: 3 } }), 'leader', NOW)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe(`AUTONOMOUS MODE (until they say they are back). ${AUTONOMOUS_ON_RULE.en} Pre-authorised: publish releases the leader has approved (QA green); open worker sessions within the plan limits; owner's note: focus on QUAL. Act directly within those authorisations; anything outside them is DEFERRED safely in the hand-off file for the owner's return.`)
    expect(lines[1]).toContain('Never run more than 4 workers at once; at most this many of them on a provider\'s top model tier at once: claude (Opus / Fable) ≤ 1, codex (top GPT tier) ≤ 3, any other provider ≤ 1')
    expect(lines[1]).toContain('free RAM drops under 2 GB')
    expect(lines[1]).toContain('mid tier: scoped implementation; light tier: probes')
    expect(lines[1]).not.toContain('Opus:')
    expect(lines[2]).toContain('QA by a different model from the author, tests only in throwaway runs (agentop run --rm)')
    expect(lines[2]).toContain('bundled into one release per batch')
    expect(lines[3]).toContain('never end a turn on a question')
    expect(lines[3]).toContain('agentistics_session_away with `notice`')
    expect(lines[3]).toContain("in the successor's prompt what is authorised")
  })
  it('pacing points at the briefing rule when it is there, and states it in full when it is not', () => {
    const pointed = awayBriefingLines(on(), 'leader', NOW, { planLimitsInBriefing: true })[1]!
    expect(pointed).toContain('apply the agentistics_plan_limits rule above')
    expect(pointed).not.toContain('5-hour window')
    const full = awayBriefingLines(on(), 'leader', NOW)[1]!
    expect(full).toContain('keep cadence.parallel workers running; if paceStatus is under, pull work from the queue; hold only when the 5-hour window is at least 85%')
    expect(full).toContain('weekly quota is not a brake unless it is at least 95%')
  })
  it('without the releases authorisation, releases are safely deferred', () => {
    expect(awayBriefingLines(on({ authorised: ['workers'] }), 'leader', NOW)[2]).toContain('releases are DEFERRED safely')
  })
  it('worker line: report to the leader, not the owner', () => {
    const [l] = awayBriefingLines(on({ until: '2026-10-12T12:00:00.000Z' }), 'worker', NOW)
    expect(l).toBe(`AUTONOMOUS MODE (until 2026-10-12T12:00:00.000Z). ${AUTONOMOUS_ON_RULE.en} Worker communication: report ONLY to your leader through agentistics_session_message. Send blocks and hand-backs there; never address the owner and never end a turn on a question. With no leader, decide within your brief and record the decision.`)
  })
  it('auto line names both paths; no authorisations says so', () => {
    const [l] = awayBriefingLines(on({ authorised: [] }), undefined, NOW)
    expect(l).toContain('Pre-authorised: nothing beyond the rules below.')
    expect(l).toContain('otherwise report ONLY to the session that started you')
  })
  it('ON text never creates an owner question or approval wait', () => {
    const text = awayBriefingLines(on({ authorised: [] }), 'leader', NOW).join('\n').toLowerCase()
    for (const forbidden of ['ask the owner', 'wait for the owner', 'wait for approval', 'confirm first', 'pergunte ao dono']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('one wording for the ON rule', () => {
  it('the hand-off hint quotes the pt rule instead of its own older wording', () => {
    const note = awayHandoffNote(on(), NOW)
    expect(note).toContain(AUTONOMOUS_ON_RULE.pt)
    expect(note).not.toContain('sem pedir permissão')
  })
  it('the away head carries the rule, unless the briefing already did (said once)', () => {
    const head = (o?: { ruleInBriefing?: boolean }) => awayBriefingLines(on(), 'worker', NOW, o).join('\n')
    expect(head()).toContain(AUTONOMOUS_ON_RULE.en)
    expect(head({ ruleInBriefing: true })).not.toContain(AUTONOMOUS_ON_RULE.en)
    expect(head({ ruleInBriefing: true })).toStartWith('AUTONOMOUS MODE (')
    expect(head()).not.toContain('— The owner')
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
    expect(awayTopCap(s, 'claude')).toBe(1)
    expect(awayTopCap(s, 'gemini')).toBe(1)
    expect(awayTopCap({ maxWorkers: 1, topCaps: {} }, 'kimi')).toBe(1)
  })
  it('notice must be non-empty and bounded', () => {
    expect(normalizeAwayNotice('  ')).toBeNull()
    expect(normalizeAwayNotice('x'.repeat(501))).toBeNull()
    expect(normalizeAwayNotice(' release 2.133 is out ')).toBe('release 2.133 is out')
  })
  it('hand-off note names authorisations and ceilings', () => {
    expect(awayHandoffNote(on(), NOW)).toContain('autorizado: releases, workers; teto 6 workers / modelo de topo por provedor: claude 2, demais 1')
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
    expect(l).toContain('never address the owner')
  })
  it('the runtime notice is typed only when the effective state changes', () => {
    const off = parseAwayState(null)
    expect(sessionAwayNotice(off, false, true, 'worker', NOW)).toContain('autonomous mode is now ON for this session')
    expect(sessionAwayNotice(off, true, false, 'worker', NOW)).toContain('autonomous mode is now OFF for this session')
    expect(sessionAwayNotice(off, true, true, 'worker', NOW)).toBeNull()
    expect(sessionAwayNotice(on(), true, false, 'worker', NOW)).toBeNull()
  })
})

describe('autonomousSpawnMode', () => {
  test('on: a new session is born in no-questions', () => {
    expect(autonomousSpawnMode(undefined, true, true)).toEqual({ mode: 'no-questions', fromAutonomous: true })
  })
  test('an explicit mode wins, even "default"', () => {
    expect(autonomousSpawnMode('plan', true, true)).toEqual({ mode: 'plan', fromAutonomous: false })
    expect(autonomousSpawnMode('default', true, true)).toEqual({ mode: 'default', fromAutonomous: false })
  })
  test('off: the inherited/default mode is kept', () => {
    expect(autonomousSpawnMode(undefined, false, true, 'accept-edits')).toEqual({ mode: 'accept-edits', fromAutonomous: false })
    expect(autonomousSpawnMode(undefined, false, true)).toEqual({ mode: undefined, fromAutonomous: false })
  })
  test('a harness that cannot carry no-questions is left alone, never refused', () => {
    expect(autonomousSpawnMode(undefined, true, false, 'plan')).toEqual({ mode: 'plan', fromAutonomous: false })
  })
})

// ── SCHEDULED autonomous mode (MODO.AUTONOMO-SIMPLES) ───────────────────────────────────────────
import { awayEffective, awayScheduleEdge, awayScheduled } from './awayMode'
import type { AgentSchedule } from './agentSchedule'

// Local-clock helper: the evaluator reads getDay()/getHours() on the machine's zone, so build the
// instants from LOCAL components instead of pinning a UTC string.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
// 2026-11-02 is a Monday.
const MON = (h: number, mi = 0) => at(2026, 11, 2, h, mi)
const TUE = (h: number, mi = 0) => at(2026, 11, 3, h, mi)
const sched = (days: AgentSchedule['days']): AgentSchedule => ({ enabled: true, days })
const scheduled = (days: AgentSchedule['days'], o: Partial<AwayState> = {}): AwayState => on({ schedule: sched(days), ...o })

describe('awayActive with a schedule', () => {
  const workday = { mon: { windows: [{ from: '09:00', to: '18:00' }] } }
  it('is on inside the window and off outside it, with the window start inclusive and the end exclusive', () => {
    const s = scheduled(workday)
    expect(awayActive(s, MON(8, 59))).toBe(false)
    expect(awayActive(s, MON(9, 0))).toBe(true)
    expect(awayActive(s, MON(17, 59))).toBe(true)
    expect(awayActive(s, MON(18, 0))).toBe(false)
  })
  it('is off on a day that is not selected', () => {
    expect(awayActive(scheduled(workday), TUE(10))).toBe(false)
  })
  it('"all day" covers the whole calendar day and stops at midnight', () => {
    const s = scheduled({ mon: { windows: [], allDay: true } })
    expect(awayActive(s, MON(0, 0))).toBe(true)
    expect(awayActive(s, MON(23, 59))).toBe(true)
    expect(awayActive(s, TUE(0, 0))).toBe(false)
  })
  it('a window crossing midnight belongs to the day it started on', () => {
    const s = scheduled({ mon: { windows: [{ from: '22:00', to: '02:00' }] } })
    expect(awayActive(s, MON(21, 59))).toBe(false)
    expect(awayActive(s, MON(22, 0))).toBe(true)
    expect(awayActive(s, TUE(1, 59))).toBe(true)
    expect(awayActive(s, TUE(2, 0))).toBe(false)
  })
  it('several windows in one day', () => {
    const s = scheduled({ mon: { windows: [{ from: '08:00', to: '10:00' }, { from: '14:00', to: '16:00' }] } })
    expect([MON(9), MON(12), MON(15)].map(t => awayActive(s, t))).toEqual([true, false, true])
  })
  it('a disabled schedule is ignored (the switch alone decides) and `until` stays the outer bound', () => {
    expect(awayActive(on({ schedule: { enabled: false, days: {} } }), MON(3))).toBe(true)
    const s = scheduled({ mon: { windows: [], allDay: true } }, { until: new Date(MON(12)).toISOString() })
    expect(awayActive(s, MON(11))).toBe(true)
    expect(awayActive(s, MON(13))).toBe(false)
  })
  it('the switch off beats any window', () => {
    expect(awayActive(scheduled({ mon: { windows: [], allDay: true } }, { on: false }), MON(10))).toBe(false)
  })
  it('awayScheduled is true only for an enabled schedule', () => {
    expect(awayScheduled(scheduled(workday))).toBe(true)
    expect(awayScheduled(on())).toBe(false)
    expect(awayScheduled(on({ schedule: { enabled: false, days: {} } }))).toBe(false)
  })
})

describe('awayScheduleEdge', () => {
  const s = scheduled({ mon: { windows: [{ from: '09:00', to: '18:00' }] } })
  it('reports the edge only when the effective state flipped since the last look', () => {
    expect(awayScheduleEdge(s, false, MON(9, 0))).toEqual({ active: true, edge: 'on' })
    expect(awayScheduleEdge(s, true, MON(18, 0))).toEqual({ active: false, edge: 'off' })
    expect(awayScheduleEdge(s, true, MON(12))).toEqual({ active: true, edge: null })
  })
  it('a first look (last undefined) announces nothing, and an unscheduled state never has an edge', () => {
    expect(awayScheduleEdge(s, undefined, MON(12))).toEqual({ active: true, edge: null })
    expect(awayScheduleEdge(on(), false, MON(12))).toEqual({ active: true, edge: null })
  })
})

describe('awayEffective', () => {
  it('drops the schedule while inside a window and reads as off outside', () => {
    const s = scheduled({ mon: { windows: [{ from: '09:00', to: '18:00' }] } })
    expect(awayEffective(s, MON(10)).schedule).toBeUndefined()
    expect(awayEffective(s, MON(10)).on).toBe(true)
    expect(awayEffective(s, MON(20)).on).toBe(false)
  })
})

describe('normalizeAwayInput with a schedule', () => {
  const days = { mon: { windows: [{ from: '09:00', to: '18:00' }] } }
  it('stores an enabled schedule and applies the automatic defaults (all authorisations, 4 workers, 1 per provider)', () => {
    const r = normalizeAwayInput({ on: true, schedule: { enabled: true, days } }, NOW)
    expect(r).toMatchObject({ ok: true, state: { on: true, until: null, authorised: ['releases', 'workers', 'merges'], maxWorkers: 4, topCaps: {}, schedule: { enabled: true, days } } })
  })
  it('refuses malformed and empty schedules', () => {
    expect(normalizeAwayInput({ on: true, schedule: { enabled: true, days: { xyz: { windows: [] } } } }, NOW)).toMatchObject({ ok: false, error: 'bad_schedule' })
    expect(normalizeAwayInput({ on: true, schedule: { enabled: true, days: { mon: { windows: [] } } } }, NOW)).toMatchObject({ ok: false, error: 'empty_schedule' })
    expect(normalizeAwayInput({ on: true, schedule: { enabled: true, days: {} } }, NOW)).toMatchObject({ ok: false, error: 'empty_schedule' })
  })
  it('a disabled schedule is not stored; an explicit authorised list (even empty) is respected', () => {
    const r = normalizeAwayInput({ on: true, authorised: [], schedule: { enabled: false, days: {} } }, NOW)
    expect(r.ok && r.state.schedule).toBeUndefined()
    expect(r.ok && r.state.authorised).toEqual([])
  })
  it('round-trips through parseAwayState', () => {
    const r = normalizeAwayInput({ on: true, schedule: { enabled: true, days } }, NOW)
    expect(r.ok && parseAwayState(r.state).schedule).toEqual({ enabled: true, days })
  })
})

describe('the briefing of a scheduled state', () => {
  it('names the windows (local time) so the model knows it is not open-ended', () => {
    const s = scheduled({ mon: { windows: [], allDay: true } })
    const [line] = awayBriefingLines(s, 'worker', MON(10))
    expect(line).toContain("only inside the owner's scheduled windows")
    expect(line).toContain('Mon: all day')
    expect(awayBriefingLines(s, 'worker', TUE(10))).toEqual([])
  })
})
