/** The agy replay's IO half over the fixture: which conversations are runs, the child agent, the cursor. */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { buildFixtureRoot } from './fixture-db'
import { createAntigravityReplay } from './index'
import { childAgentIdOf, mainAgentIdOf } from './replay-core'

const FIX = join(import.meta.dir, '../../../test/fixtures/antigravity-replay')
const P = 'aaaaaaaa-0000-4000-8000-000000000001'
const C = 'cccccccc-0000-4000-8000-000000000002'
const LATER = Date.parse('2027-01-01T00:00:00Z')

describe('agy replay — discovery', () => {
  test('a run is a parsed conversation with no parsed ancestor; a child and a bootstrap are not runs', async () => {
    const root = buildFixtureRoot(FIX)
    const r = createAntigravityReplay({ rootDir: root, now: () => LATER })
    expect(await r.discover()).toEqual([{ sessionId: P, sourceRef: `antigravity:${P}` }])
  })

  test('an unreadable store is an empty list, never a throw', async () => {
    const r = createAntigravityReplay({ rootDir: '/nonexistent/agy', now: () => LATER })
    expect(await r.discover()).toEqual([])
  })
})

describe('agy replay — one run', () => {
  test('the child conversation is a child Agent of this run, and its rows are read once, under it', async () => {
    const root = buildFixtureRoot(FIX)
    const r = createAntigravityReplay({ rootDir: root, now: () => LATER })
    const [src] = await r.discover()
    const { events } = await r.replay(src!, null)
    const runIds = new Set(events.map(e => e.runId))
    expect(runIds.size).toBe(1)
    const child = childAgentIdOf(P, C)
    const start = events.find(e => e.type === 'agent.started' && e.agentId === child)!
    expect(start.data).toMatchObject({ kind: 'subagent', parentAgentId: mainAgentIdOf(P) })
    const completed = events.filter(e => e.type === 'model.completed')
    expect(completed.filter(e => e.agentId === mainAgentIdOf(P))).toHaveLength(3)
    expect(completed.filter(e => e.agentId === child)).toHaveLength(1)
    // one run: exactly one run.started / run.ended, the end at the child's last step
    expect(events.filter(e => e.type === 'run.started')).toHaveLength(1)
    expect(events.find(e => e.type === 'run.ended')!.occurredAt).toBe('2026-08-14T10:40:00.000Z')
    // every id is distinct
    expect(new Set(events.map(e => e.eventId)).size).toBe(events.length)
  })

  test('replaying twice re-derives identical ids; an unchanged settled run returns nothing', async () => {
    const root = buildFixtureRoot(FIX)
    const a = createAntigravityReplay({ rootDir: root, now: () => LATER })
    const b = createAntigravityReplay({ rootDir: root, now: () => LATER })
    const [src] = await a.discover()
    const first = await a.replay(src!, null)
    const again = await b.replay(src!, null)
    expect(again.events.map(e => e.eventId)).toEqual(first.events.map(e => e.eventId))
    const resumed = await a.replay(src!, first.cursor)
    expect(resumed.events).toEqual([])
  })

  test('a run still being written is not final: no *.ended, and the next settled read closes it', async () => {
    const root = buildFixtureRoot(FIX)
    const nowMs = Date.now()
    const live = createAntigravityReplay({ rootDir: root, now: () => nowMs, settledMs: 60_000 })
    const [src] = await live.discover()
    const open = await live.replay(src!, null)
    expect(open.events.some((e: AgentisticsEvent) => e.type.endsWith('.ended') && e.type !== 'turn.ended')).toBe(false)
    const settled = createAntigravityReplay({ rootDir: root, now: () => nowMs + 120_000, settledMs: 60_000 })
    const closed = await settled.replay(src!, open.cursor)
    expect(closed.events.some(e => e.type === 'session.ended')).toBe(true)
  })

  test('the SQLite files are opened read-only: no -wal / -shm appears beside them', async () => {
    const root = buildFixtureRoot(FIX)
    for (const f of readdirSync(join(root, 'conversations'))) utimesSync(join(root, 'conversations', f), 1, 1)
    const r = createAntigravityReplay({ rootDir: root, now: () => LATER })
    const [src] = await r.discover()
    await r.replay(src!, null)
    const files = readdirSync(join(root, 'conversations'))
    expect(files.filter(f => f.endsWith('-wal') || f.endsWith('-shm'))).toEqual([])
    expect(existsSync(join(root, 'conversations', `${P}.db`))).toBe(true)
  })
})

describe('agy replay — the redacted real parent/child pair (test/fixtures/antigravity-replay-real)', () => {
  // A real invoke_subagent parent and its child, every text replaced (paths by /work/proj/f<n>,
  // edit payloads by the same NUMBER of lines, prompts and commands by a placeholder), and their
  // gen_metadata rows reduced to the structural fields fixture-db.ts re-encodes.
  const REAL = join(import.meta.dir, '../../../test/fixtures/antigravity-replay-real')
  const RP = 'a92a18d1-1b62-4115-8134-c4dab56e85fe'
  const RC = '02a1ff3a-3c11-483d-813d-140c5e729b84'

  test('the expected event stream, by type and agent', async () => {
    const r = createAntigravityReplay({ rootDir: buildFixtureRoot(REAL), now: () => LATER })
    const src = await r.discover()
    expect(src.map(s => s.sessionId)).toEqual([RP])
    const { events } = await r.replay(src[0]!, null)
    const count = (type: string, agentId?: string) =>
      events.filter(e => e.type === type && (agentId === undefined || e.agentId === agentId)).length
    const main = mainAgentIdOf(RP), child = childAgentIdOf(RP, RC)
    expect({
      session: [count('session.started'), count('session.ended')],
      run: [count('run.started'), count('run.ended')],
      agents: [count('agent.started', main), count('agent.started', child), count('agent.ended')],
      turns: [count('turn.started', main), count('turn.ended', main), count('turn.started', child)],
      model: [count('model.completed', main), count('model.completed', child)],
      tools: [count('tool.requested'), count('tool.completed'), count('tool.failed')],
    }).toEqual({
      session: [1, 1], run: [1, 1], agents: [1, 1, 2], turns: [3, 3, 0], model: [29, 30], tools: [50, 31, 5],
    })
    // every gen_metadata row counted exactly once: main + child == legacy's rolled-up session
    const sum = (k: 'input' | 'output' | 'cacheRead') => events
      .filter((e): e is AgentisticsEvent<'model.completed'> => e.type === 'model.completed')
      .reduce((n, e) => n + (e.data.usage[k] ?? 0), 0)
    expect([sum('input'), sum('output'), sum('cacheRead')]).toEqual([1059186, 35378, 2367988])
    expect(events.some(e => e.type === 'model.completed' && 'cacheWrite' in (e.data as { usage: object }).usage)).toBe(false)
  })
})
