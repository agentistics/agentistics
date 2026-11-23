/**
 * S7b — custody AUTHORITY (ENTREGA.GARANTIDA §5.2.2–4, acceptance §5.4.6–8), against REAL stores in a temp dir.
 *
 *   §5.4.6  the custodian passes `leads()` (configure = a leader-owned gate, the release declaration) and is still refused
 *           `evidence_required` when it raises the piece into review with no evidence — custody is not evidence;
 *   §5.4.7  custody is not filing: the custodian's conversation stays owned by its OWN task (`conversationOwners`);
 *   §5.4.8  no project leader → queue; a leader that STARTS in the project discovers the piece in its SessionStart context
 *           (discovery grants nothing), and the NEXT tick assigns it and messages it (the assignment wins);
 *   wake    a wake for a piece in custody goes to the custodian (block wake, review nudge), never to the absent leader;
 *   inert   rule C off: a custody field on a record (forged) changes no door (leads, wake, nudge, check-in, discovery).
 *
 * Every negative runs after a positive in the same fixture (the control proves the fixture can do the thing).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts, type RuleState } from './activation'
import { createDeliveryStore } from './store'
import { createDeliveryService } from './service'
import { newDelivery, type DeliveryRecord } from './machine'
import { orphanMsOf } from './custody'
import { readCustodyView, withCustodyDiscovery } from './host'
import { createTaskStore } from '../sessions/task-store'
import { conversationOwners } from '../sessions/task-conversations'
import { contextText } from '../sessions/agentistics-context'

const MIN = 60_000
const H = 3600_000
const N = orphanMsOf(undefined)
const T0 = Date.parse('2026-11-16T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: iso(now), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3', 'S7'], migrated: ['a', 'c'], unexplainedWouldRefuse: 0 })
/** Every piece and every task of this fixture is in project acme/app, except `t-other` (another repository). */
const projectOf = (id: string) => (id === 't-other' || id === 'po' ? 'other/repo' : 'acme/app')
const SHA = 'a'.repeat(40)

// Each case runs dozens of real ticks (and one a real git checkout): ~1 s alone, far more on a loaded machine. 5 s timed out
// under a concurrent full-suite pre-commit.
setDefaultTimeout(60_000)

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'custody-s7b-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface Row { id: string; role: string; taskId: string; alive: boolean; cwd: string; harness: string; worktree: boolean; createdAt?: string }
const row = (id: string, taskId: string, alive = true, role = 'leader', createdAt?: string): Row => ({ id, role, taskId, alive, cwd: '/nowhere', harness: 'claude', worktree: false, ...(createdAt ? { createdAt } : {}) })

interface World {
  clock: { now: number }; fleet: { rows: Row[] }; messages: Array<{ to: string; text: string }>; path: string
  tasks: ReturnType<typeof createTaskStore>; svc(): any; read(id: string): any
}
async function world(rules: { a?: RuleState; c: RuleState }): Promise<World> {
  const clock = { now: T0 }
  const fleet = { rows: [] as Row[] }
  const messages: World['messages'] = []
  const path = join(root, 'deliveries.json')
  const tasks = createTaskStore(join(root, 'tasks.json'))
  const svc = () => createDeliveryService({
    store: createDeliveryStore(path) as never,
    facts: {
      subtask: async (id: string) => ({ id, taskId: id.startsWith('t-') ? id : `t-${id}`, title: id, status: 'in_review', groupMember: false, blockedBy: [] }),
      sessions: async () => fleet.rows, blockedSubtasks: async () => [], gh: async () => '', git: async () => '',
    } as never,
    board: { comment: async () => undefined, subtaskFinished: async () => false, setPhaseStatus: async () => ({ ok: true }), setCi: async () => undefined, logStep: async () => undefined } as never,
    notify: { session: async (to: string, text: string) => { messages.push({ to, text }); return fleet.rows.find(r => r.id === to)?.alive === true }, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => clock.now, autoReconcile: () => false,
    custody: { tasks: async () => tasks, projectsOf: async (pieces: ReadonlyArray<{ subtaskId: string }>) => new Map(pieces.map(p => [p.subtaskId, projectOf(p.subtaskId)] as const)), orphanAfterHours: async () => undefined },
  } as never) as any
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  for (const [rule, state] of [['c', rules.c], ['a', rules.a ?? 'off']] as const) {
    if (state === 'off') continue
    expect(await g.setState(rule, 'shadow', { check, facts: facts(T0 - 25 * H) })).toEqual({ ok: true })
    if (state === 'on') expect(await g.setState(rule, 'on', { check, facts: facts(T0) })).toEqual({ ok: true })
  }
  return { clock, fleet, messages, path, tasks, svc, read: id => JSON.parse(readFileSync(path, 'utf8')).deliveries[id] }
}
const seed = (w: World, id: string, o: Partial<DeliveryRecord> = {}, phase: DeliveryRecord['phase'] = 'revisao_lider') => {
  let raw: any
  try { raw = JSON.parse(readFileSync(w.path, 'utf8')) } catch { raw = { version: 1, deliveries: {} } }
  const r = newDelivery({ subtaskId: id, taskId: id.startsWith('t-') ? id : `t-${id}`, at: iso(T0 - H) }) as any
  r.phase = phase; r.revision = 2
  r.history = [{ from: 'fila', to: phase, at: iso(T0 - H), actor: 'flow:entrega', revision: 2, detail: 'x' }]
  raw.deliveries[id] = Object.assign(r, o)
  writeFileSync(w.path, JSON.stringify(raw))
}
const tickAt = async (w: World, ms: number) => { w.clock.now = ms; return (await w.svc().tick()).actions as string[] }
const upTo = async (w: World, from: number, to: number, step = 10 * MIN) => { for (let t = from; t <= to; t += step) await tickAt(w, t) }
const custodyMsgs = (w: World, to?: string) => w.messages.filter(m => m.text.includes('flow custódia') && (to === undefined || m.to === to))
/** The IO view's deps, pointed at this fixture (no real data dir, no real board). */
const viewDeps = (w: World) => ({
  dataDir: root,
  records: async () => Object.values(JSON.parse(readFileSync(w.path, 'utf8')).deliveries) as DeliveryRecord[],
  projectsOf: async (pieces: ReadonlyArray<{ subtaskId: string }>) => new Map(pieces.map(p => [p.subtaskId, projectOf(p.subtaskId)] as const)),
})

/** L1 filed p1, acted at T0, died; L2 (live leader of the same project, task t-p2) takes custody at N+. */
async function established(rules: { a?: RuleState; c: RuleState } = { c: 'on' }, phase: DeliveryRecord['phase'] = 'revisao_lider'): Promise<World> {
  const w = await world(rules)
  seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) }, phase)
  seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
  w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
  await upTo(w, T0 + 10 * MIN, T0 + N - 10 * MIN)
  expect(w.read('p1').custody).toBeUndefined()
  await upTo(w, T0 + N, T0 + N + 10 * MIN, 5 * MIN)
  expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2', via: 'project-leader' })
  expect(custodyMsgs(w, 'L2')).toHaveLength(1)
  return w
}

describe('§5.4.6 — the custodian actually acts: leads() accepts it; custody is never evidence', () => {
  test('before custody L2 is refused; after it, L2 configures p1 (a leader-owned gate) and declares its release; a non-custodian leader stays refused', async () => {
    const w = await world({ c: 'on' })
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
    w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
    w.clock.now = T0 + 30 * MIN
    const early = await w.svc().configure('p1', { versionTarget: '1.0.0' }, 'L2')
    expect(early).toMatchObject({ ok: false, status: 403, code: 'so_o_lider' })
    await upTo(w, T0 + N, T0 + N + 10 * MIN, 5 * MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })

    // POSITIVE: the custodian drives the orphan.
    w.clock.now = T0 + N + 20 * MIN
    const cfg = await w.svc().configure('p1', { versionTarget: '1.0.0', allowDeletions: { paths: ['old.ts'], reason: 'dead code' } }, 'L2')
    expect(cfg.ok).toBe(true)
    expect(w.read('p1').versionTarget).toBe('1.0.0')
    expect(w.read('p1').allowDeletions).toMatchObject({ paths: ['old.ts'] })
    seed(w, 'p1', { ...w.read('p1'), phase: 'pr_merge', revision: 3 })
    const rel = await w.svc().release({ version: '1.0.0', mergeSha: SHA, subtaskIds: ['p1'] }, 'L2')
    expect(rel.code).not.toBe('so_o_lider')
    expect(rel.code).not.toBe('outra_tarefa')
    expect(rel.ok).toBe(true)
    expect(w.read('p1').phase).toBe('ci')

    // NEGATIVE after the positive: a live leader of the same project that does NOT hold custody is still refused.
    w.fleet.rows = [...w.fleet.rows, row('L3', 't-p3')]
    const other = await w.svc().configure('p1', { versionTarget: '9.9.9' }, 'L3')
    expect(other).toMatchObject({ ok: false, status: 403, code: 'so_o_lider' })
    expect(w.read('p1').versionTarget).toBe('1.0.0')
  })

  test('the custodian unblocks the orphan (a leader-owned lift); a stranger cannot', async () => {
    const w = await established()
    w.clock.now = T0 + N + 20 * MIN
    expect((await w.svc().block('p1', 'externo', 'waiting on a vendor', 'owner')).ok).toBe(true)
    w.fleet.rows = [...w.fleet.rows, row('L3', 't-p3')]
    expect(await w.svc().unblock('p1', 'L3')).toMatchObject({ ok: false, code: 'so_o_lider' })
    const out = await w.svc().unblock('p1', 'L2')
    expect(out.ok).toBe(true)
    expect(w.read('p1').phase).not.toBe('bloqueado')
  })

  test('custody is not evidence: rule A on, the custodian raising the orphan into review with no evidence is refused evidence_required', async () => {
    const w = await established({ a: 'on', c: 'on' }, 'qa')
    w.clock.now = T0 + N + 20 * MIN
    // control: the custodian IS accepted by leads() on this very piece (so the refusals below are not authority refusals)
    expect((await w.svc().configure('p1', { versionTarget: '1.0.0' }, 'L2')).ok).toBe(true)
    seed(w, 'p1', { ...w.read('p1'), headSha: SHA })
    const before = readFileSync(w.path, 'utf8')
    // the delivery door: qa → revisao_lider with an APROVADO verdict and no evidence is refused at the `evidencia` gate
    const out = await w.svc().transition('p1', 'revisao_lider', { verdict: 'APROVADO', findings: 'looks right' }, 'L2')
    expect(out).toMatchObject({ ok: false, code: 'portao' })
    expect(out.missing.join(' ')).toMatch(/evidencia/)
    expect(w.read('p1').phase).toBe('qa')
    // the store choke point: the custodian's own context raising the rank with no evidence → evidence_required, nothing written
    // (a real checkout for the piece, so the guard can classify it and judges the EVIDENCE — the worker W1 works on p1 there)
    const { contextOfActor } = await import('./guard')
    const { originWithClone, gitSync, put } = await import('./git-fixture.testing')
    const { execGit } = await import('./classify-host')
    const { repo } = originWithClone(root, 'r'); gitSync(repo, 'checkout', '-b', 'feat/x'); put(repo, 'packages/web/src/a.tsx'); gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'web')
    const checkout = [{ id: 'W1', role: 'worker', taskId: 't-p1', subtaskId: 'p1', alive: true, cwd: repo, harness: 'claude', worktree: true, createdAt: iso(T0) }, ...w.fleet.rows]
    const raw = createDeliveryStore(w.path, { guard: { deps: { sessions: async () => checkout, git: execGit } as never, now: () => w.clock.now } as never })
    const mid = readFileSync(w.path, 'utf8')
    let code: string | undefined
    try { await raw.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: contextOfActor('L2') }) } catch (e) { code = (e as { code?: string }).code }
    expect(code).toBe('evidence_required')
    expect(readFileSync(w.path, 'utf8')).toBe(mid)
    expect(before.length).toBeGreaterThan(0)
  })
})

describe('§5.4.7 — filing invariant: custody never moves the custodian\'s conversation', () => {
  test('after custody, conversationOwners still maps the custodian\'s conversation to its own task', async () => {
    const w = await established()
    const registry = [
      { id: 'L2', conversationId: 'conv-l2', taskId: 't-p2', createdAt: iso(T0 - 2 * H) },
      { id: 'L1', conversationId: 'conv-l1', taskId: 't-p1', createdAt: iso(T0 - 2 * H) },
    ]
    // control: the custody really exists and the custodian really acted on the orphan
    expect(w.read('p1').custody.sessionId).toBe('L2')
    w.clock.now = T0 + N + 20 * MIN
    expect((await w.svc().configure('p1', { versionTarget: '1.0.0' }, 'L2')).ok).toBe(true)
    const owners = conversationOwners(registry as never)
    expect(owners.get('conv-l2')).toBe('t-p2')
    expect(owners.get('conv-l1')).toBe('t-p1')
    // custody is stored on the delivery record only: no filing field, and the board holds no new session link
    expect(Object.keys(w.read('p1').custody).sort()).toEqual(['notifiedAt', 'project', 'sessionId', 'since', 'via'])
    const book = await w.tasks.read() as any
    expect(book.historicalSessions ?? []).toEqual([])
  })
})

describe('§5.2.3 — wakes for a piece in custody go to the custodian', () => {
  test('a block wake on the orphan reaches L2, never the absent L1', async () => {
    const w = await established()
    w.messages.length = 0
    w.clock.now = T0 + N + 20 * MIN
    const out = await w.svc().block('p1', 'externo', 'vendor', 'owner')
    expect(out.ok).toBe(true)
    const wakes = w.messages.filter(m => m.text.startsWith('[entrega p1]'))
    expect(wakes.map(m => m.to)).toEqual(['L2'])
  })
  test('the tick\'s blocked-piece chase (every 30 min) of an orphan in custody reaches L2, never L1', async () => {
    const w = await established()
    w.clock.now = T0 + N + 20 * MIN
    expect((await w.svc().block('p1', 'externo', 'vendor', 'owner')).ok).toBe(true)
    w.messages.length = 0
    await upTo(w, T0 + N + 60 * MIN, T0 + N + 2 * H, 10 * MIN)
    const chased = w.messages.filter(m => m.text.includes('p1') && !m.text.includes('flow custódia') && !m.text.startsWith('[entrega revisão]'))
    expect(chased.length).toBeGreaterThan(0)
    expect(chased.map(m => m.to).every(t => t === 'L2')).toBe(true)
  })
  test('the review nudge of an orphan in review reaches the custodian (before custody: nobody)', async () => {
    const w = await established()
    const nudges = w.messages.filter(m => m.text.startsWith('[entrega revisão]') && m.text.includes('p1'))
    expect(nudges.every(m => m.to === 'L2')).toBe(true)
    w.messages.length = 0
    await upTo(w, T0 + N + 20 * MIN, T0 + N + 3 * H, 30 * MIN)
    const after = w.messages.filter(m => m.text.startsWith('[entrega revisão]') && m.text.includes('p1'))
    expect(after.length).toBeGreaterThan(0)
    expect(after.map(m => m.to).every(t => t === 'L2')).toBe(true)
  })
})

describe('§5.2.3 — the check-in lists the caller\'s custody (and its project\'s queue)', () => {
  test('L2\'s view holds p1; L1 and a leader of another project hold nothing', async () => {
    const w = await established()
    const mine = await readCustodyView({ sessionId: 'L2', taskId: 't-p2' }, viewDeps(w))
    expect(mine?.held.map(p => p.key)).toEqual(['p1'])
    expect((await readCustodyView({ sessionId: 'L1', taskId: 't-p1' }, viewDeps(w)))?.held).toEqual([])
    expect((await readCustodyView({ sessionId: 'LX', taskId: 't-other' }, viewDeps(w)))?.held).toEqual([])
  })
})

describe('§5.4.8 — queue: SessionStart discovery is information; the next tick\'s assignment (with its message) is the authority', () => {
  async function queued(): Promise<World> {
    const w = await world({ c: 'on' })
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    seed(w, 'po', { taskId: 't-other', leaderSessionId: 'LO', leaderActivityBy: 'LO', leaderActivityAt: iso(T0 + N) })
    w.fleet.rows = [row('L1', 't-p1', false), row('LO', 't-other')]
    await upTo(w, T0 + N, T0 + N + 10 * MIN, 5 * MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: null, via: 'queue', project: 'acme/app' })
    expect(custodyMsgs(w)).toHaveLength(0)
    return w
  }
  test('a leader that starts in the project discovers p1; it is NOT custodian until the tick; the tick assigns and messages it', async () => {
    const w = await queued()
    const start = T0 + N + 15 * MIN
    w.clock.now = start
    w.fleet.rows = [...w.fleet.rows, row('L5', 't-p5', true, 'leader', iso(start))]
    const ctx = await withCustodyDiscovery({ sessionId: 'L5', role: 'leader', taskId: 't-p5' }, viewDeps(w))
    expect(ctx.custodyQueue).toContain('p1')
    const text = contextText({ ...ctx, lang: 'en' } as never)
    expect(text).toContain('p1')
    // discovery grants nothing: before the tick L5 does not lead p1
    expect(await w.svc().configure('p1', { versionTarget: '1.0.0' }, 'L5')).toMatchObject({ ok: false, code: 'so_o_lider' })
    const frozen = ctx.custodyQueue
    const actions = await tickAt(w, start + MIN)
    expect(actions).toContain('custody-assigned p1 → L5')
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L5', via: 'project-leader' })
    expect(custodyMsgs(w, 'L5')).toHaveLength(1)
    expect((await w.svc().configure('p1', { versionTarget: '1.0.0' }, 'L5')).ok).toBe(true)
    // the SessionStart context is never retroactively changed (it was a value computed at the start)
    expect(ctx.custodyQueue).toBe(frozen)
    // NEGATIVE after the positive: a leader starting in ANOTHER project discovers nothing and is never assigned
    const ctxO = await withCustodyDiscovery({ sessionId: 'L6', role: 'leader', taskId: 't-other' }, viewDeps(w))
    expect(ctxO.custodyQueue).toBeUndefined()
  })
  test('a worker never gets the discovery section, and a leader with nothing queued in its project gets none', async () => {
    const w = await queued()
    const leader = await withCustodyDiscovery({ sessionId: 'L5', role: 'leader', taskId: 't-p5' }, viewDeps(w))
    expect(leader.custodyQueue).toContain('p1') // control
    const worker = await withCustodyDiscovery({ sessionId: 'W5', role: 'worker', taskId: 't-p5' }, viewDeps(w))
    expect(worker.custodyQueue).toBeUndefined()
    const text = contextText({ sessionId: 'W5', role: 'worker', taskId: 't-p5', lang: 'en', custodyQueue: leader.custodyQueue } as never)
    expect(text).not.toContain('p1')
  })
  test('a started leader older than N is not a candidate (start counts only within N): the piece stays queued', async () => {
    const w = await queued()
    const start = T0 + N + 15 * MIN
    w.fleet.rows = [...w.fleet.rows, row('L5', 't-p5', true, 'leader', iso(start - N - MIN))]
    await tickAt(w, start + MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: null, via: 'queue' })
  })
})

describe('inert with rule C off — a forged custody field changes no door', () => {
  async function forged(): Promise<World> {
    const w = await world({ c: 'off' })
    seed(w, 'p1', { leaderSessionId: 'L1', custody: { sessionId: 'L2', since: iso(T0), via: 'project-leader', project: 'acme/app' }, leaderAbsentSince: iso(T0 - N) } as never)
    w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
    return w
  }
  test('leads(): L2 is refused on configure, release and unblock (the filed leader L1 is accepted — control)', async () => {
    const w = await forged()
    w.clock.now = T0 + MIN
    expect((await w.svc().configure('p1', { versionTarget: '1.0.0' }, 'L1')).ok).toBe(true)
    expect(await w.svc().configure('p1', { versionTarget: '2.0.0' }, 'L2')).toMatchObject({ ok: false, code: 'so_o_lider' })
    expect((await w.svc().block('p1', 'externo', 'x', 'owner')).ok).toBe(true)
    expect(await w.svc().unblock('p1', 'L2')).toMatchObject({ ok: false, code: 'so_o_lider' })
    seed(w, 'p1', { ...w.read('p1'), phase: 'pr_merge', revision: 9, block: undefined })
    expect(await w.svc().release({ version: '1.0.0', mergeSha: SHA, subtaskIds: ['p1'] }, 'L2')).toMatchObject({ ok: false })
  })
  test('wake goes to the filed leader, the check-in view and the discovery are empty', async () => {
    const w = await forged()
    w.clock.now = T0 + MIN
    w.messages.length = 0
    await w.svc().block('p1', 'externo', 'x', 'owner')
    expect(w.messages.filter(m => m.text.startsWith('[entrega p1]')).map(m => m.to)).toEqual(['L1'])
    expect(await readCustodyView({ sessionId: 'L2', taskId: 't-p2' }, viewDeps(w))).toBeNull()
    expect((await withCustodyDiscovery({ sessionId: 'L5', role: 'leader', taskId: 't-p5' }, viewDeps(w))).custodyQueue).toBeUndefined()
  })
})
