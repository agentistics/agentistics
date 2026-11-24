/**
 * S7b — the PURE rules behind custody authority (ENTREGA.GARANTIDA §5.2.3–4, §5.4.8): a leader that STARTED in the project within N
 * is a project-leader candidate; the view a session reads (held + its project's queue); the discovery section and its place in
 * the SessionStart context (leaders only). Injected clock, no IO.
 */
import { describe, expect, test } from 'bun:test'
import { custodyCheckinLine, custodyDiscoverySection, custodyViewFor, orphanMsOf, planCustody, type CustodyPiece } from './custody'
import { projectQueries, withLeaderProjects } from './custody-tick'
import { contextText } from '../sessions/agentistics-context'

const H = 3600_000
const MIN = 60_000
const N = orphanMsOf(undefined)
const T0 = Date.parse('2026-11-16T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const queuedPiece: CustodyPiece = {
  key: 'p1', taskId: 't-p1', phase: 'revisao_lider', project: 'acme/app', stageSince: iso(T0 - H), leaderSessionId: 'L1',
  leaderActivityBy: 'L1', leaderActivityAt: iso(T0), leaderAbsentSince: iso(T0),
  custody: { sessionId: null, since: iso(T0 + N + MIN), via: 'queue', project: 'acme/app' },
}

describe('§5.4.8 — a leader that starts in a queued project is assigned on the next tick', () => {
  const now = T0 + N + 20 * MIN
  test('a live leader started within N in the project takes the queued piece', () => {
    const plan = planCustody({ now, orphanMs: N, pieces: [queuedPiece], sessions: [{ id: 'L1', alive: false }, { id: 'L5', alive: true, role: 'leader', taskId: 't-p5', startedAt: iso(now - 5 * MIN), project: 'acme/app' }] })
    expect(plan.patches[0]?.custody).toMatchObject({ sessionId: 'L5', via: 'project-leader' })
    expect(plan.assignments).toEqual([{ sessionId: 'L5', project: 'acme/app', keys: ['p1'] }])
  })
  test('negatives (after the positive): another project, a worker, a dead leader, a start older than N, no start at all', () => {
    const cases = [
      { id: 'L5', alive: true, role: 'leader', startedAt: iso(now - 5 * MIN), project: 'other/repo' },
      { id: 'W5', alive: true, role: 'worker', startedAt: iso(now - 5 * MIN), project: 'acme/app' },
      { id: 'L5', alive: false, role: 'leader', startedAt: iso(now - 5 * MIN), project: 'acme/app' },
      { id: 'L5', alive: true, role: 'leader', startedAt: iso(now - N - MIN), project: 'acme/app' },
      { id: 'L5', alive: true, role: 'leader', project: 'acme/app' },
    ]
    for (const s of cases) {
      const plan = planCustody({ now, orphanMs: N, pieces: [queuedPiece], sessions: [{ id: 'L1', alive: false }, s] })
      expect(plan.patches).toEqual([])
      expect(plan.assignments).toEqual([])
    }
  })
  test('ranking: the more recent of activity or start wins; the absent filed leader is never its own custodian', () => {
    const active: CustodyPiece = { key: 'p2', taskId: 't-p2', phase: 'revisao_lider', project: 'acme/app', stageSince: iso(T0), leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(now - 30 * MIN) }
    const plan = planCustody({ now, orphanMs: N, pieces: [queuedPiece, active], sessions: [{ id: 'L1', alive: true, role: 'leader', taskId: 't-p1', startedAt: iso(now - MIN), project: 'acme/app' }, { id: 'L2', alive: true, role: 'leader', taskId: 't-p2' }, { id: 'L5', alive: true, role: 'leader', taskId: 't-p5', startedAt: iso(now - 10 * MIN), project: 'acme/app' }] })
    expect(plan.patches.find(p => p.key === 'p1')?.custody).toMatchObject({ sessionId: 'L5' })
  })
  test('the tick asks for each started leader\'s own task and stamps its project', () => {
    const fleet = [{ id: 'L5', alive: true, role: 'leader', taskId: 't-p5', startedAt: iso(now) }, { id: 'W', alive: true, role: 'worker', taskId: 't-w', startedAt: iso(now) }, { id: 'L6', alive: true, role: 'leader', taskId: 't-p6' }]
    expect(projectQueries([], fleet)).toEqual([{ taskId: 't-p5', subtaskId: 't-p5' }])
    const out = withLeaderProjects(fleet, new Map([['t-p5', 'acme/app'], ['t-w', 'acme/app'], ['t-p6', 'acme/app']]))
    expect(out.map(s => s.project)).toEqual(['acme/app', undefined, undefined])
  })
})

describe('§5.2.3 — the view a session reads (check-in)', () => {
  const recs = [
    { subtaskId: 'a', taskId: 't-a', phase: 'revisao_lider', custody: { sessionId: 'L2', since: iso(T0 + 2 * MIN), via: 'project-leader' as const, project: 'acme/app' } },
    { subtaskId: 'b', taskId: 't-b', phase: 'executando', custody: { sessionId: null, since: iso(T0), via: 'queue' as const, project: 'acme/app' } },
    { subtaskId: 'c', taskId: 't-c', phase: 'ci', custody: { sessionId: null, since: iso(T0), via: 'queue' as const, project: 'other/repo' } },
    { subtaskId: 'd', taskId: 't-d', phase: 'publicado', custody: { sessionId: 'L2', since: iso(T0), via: 'project-leader' as const, project: 'acme/app' } },
    { subtaskId: 'e', taskId: 't-e', phase: 'revisao_lider' },
  ]
  test('held = own custody on a running piece; queue = own project only', () => {
    const v = custodyViewFor(recs, 'L2', new Set(['acme/app']))
    expect(v.held.map(p => p.key)).toEqual(['a'])
    expect(v.queue.map(p => p.key)).toEqual(['b'])
    expect(custodyCheckinLine(v)).toContain('a (revisao_lider)')
    expect(custodyCheckinLine(v)).toContain('b (executando)')
    expect(custodyViewFor(recs, 'LX', new Set())).toEqual({ held: [], queue: [] })
    expect(custodyCheckinLine({ held: [], queue: [] })).toBe('')
  })
})

describe('§5.2.4 — discovery is information, said as such, and reaches leaders only', () => {
  const q = [{ key: 'p1', taskId: 't-p1', phase: 'revisao_lider', project: 'acme/app', since: iso(T0) }]
  test('the section names the piece and says the assignment message is what gives custody', () => {
    const s = custodyDiscoverySection(q)
    expect(s).toContain('p1')
    expect(s).toContain('DISCOVERY only')
    expect(s).toContain('assignment message')
    expect(custodyDiscoverySection([])).toBe('')
  })
  test('contextText draws it for a leader and never for a worker', () => {
    const base = { sessionId: 's', cwd: '/x', lang: 'en' as const, custodyQueue: custodyDiscoverySection(q) }
    expect(contextText({ ...base, role: 'leader' })).toContain('p1 (revisao_lider)')
    expect(contextText({ ...base, role: 'worker' })).not.toContain('p1 (revisao_lider)')
  })
})
