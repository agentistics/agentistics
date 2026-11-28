/**
 * S7a — custody clocks against REAL stores (spec §5.4.1–5, .9–.12): deliveries.json and guarantees.json in a temp dir, the real
 * service `tick()` and the real service doors that stamp piece activity. Every negative control runs after a positive has
 * established custody in the same fixture; the state is RELOADED from disk (a fresh store + service) after each tick.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout } from 'bun:test'
import { ownedTests, REAL_STORE_TIMEOUT_MS } from './real-store-lifecycle.testing'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts, type RuleState } from './activation'
import { createDeliveryStore } from './store'
import { createDeliveryService } from './service'
import { newDelivery, type DeliveryRecord } from './machine'
import { orphanMsOf } from './custody'

const MIN = 60_000
const H = 3600_000
const N = orphanMsOf(undefined)
const T0 = Date.parse('2026-11-16T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: iso(now), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3', 'S7'], migrated: ['a', 'c'], unexplainedWouldRefuse: 0 })
const PROJECT = new Map<string, string>([['p1', 'acme/app'], ['p2', 'acme/app'], ['p3', 'acme/app'], ['px', 'acme/other'], ['pN', 'acme/app']])

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'custody-')) })
const { test, settled } = ownedTests()
setDefaultTimeout(REAL_STORE_TIMEOUT_MS)
afterEach(async () => { await settled(); rmSync(root, { recursive: true, force: true }) })

interface Row { id: string; role: string; taskId: string; alive: boolean; cwd: string; harness: string; worktree: boolean }
const row = (id: string, taskId: string, alive = true): Row => ({ id, role: 'leader', taskId, alive, cwd: '/nowhere', harness: 'claude', worktree: false })

const custodyMsgs = (w: { messages: Array<{ to: string; text: string }> }, to?: string) => w.messages.filter(m => m.text.includes('flow custódia') && (to === undefined || m.to === to))
const CUSTODY_FIELDS = ['leaderActivityAt', 'leaderActivityBy', 'leaderAbsentSince', 'custody', 'custodyLog'] as const
const custodyState = (r: any) => JSON.stringify(CUSTODY_FIELDS.map(k => r?.[k]))

interface World { svc: any; clock: { now: number }; fleet: { rows: Row[] | null }; messages: Array<{ to: string; text: string }>; comments: string[]; path: string; reload(): { svc: any; store: ReturnType<typeof createDeliveryStore> }; read(id: string): DeliveryRecord }

async function world(rule: RuleState, o: { dir?: string; custody?: boolean } = {}): Promise<World> {
  const dir = o.dir ?? root
  const clock = { now: T0 }
  const fleet: World['fleet'] = { rows: [] }
  const messages: World['messages'] = []
  const comments: string[] = []
  const path = join(dir, 'deliveries.json')
  const build = () => {
    const store = createDeliveryStore(path)
    const svc = createDeliveryService({
      store,
      facts: { subtask: async (id: string) => ({ id, taskId: `t-${id}`, title: id, status: 'in_review', groupMember: false, blockedBy: [] }), sessions: async () => { if (!fleet.rows) throw new Error('fleet unreadable'); return fleet.rows }, blockedSubtasks: async () => [] } as never,
      board: { comment: async (_t: string, id: string, text: string) => { comments.push(`${id}: ${text}`) }, subtaskFinished: async () => false, setPhaseStatus: async () => ({ ok: true }) } as never,
      notify: { session: async (to: string, text: string) => { messages.push({ to, text }); return fleet.rows?.find(r => r.id === to)?.alive === true }, owner: async () => undefined } as never,
      autonomous: async () => true, emit: async () => undefined, now: () => clock.now, autoReconcile: () => false,
      ...(o.custody === false ? {} : { custody: { projectsOf: async (pieces: ReadonlyArray<{ subtaskId: string }>) => new Map(pieces.map(p => [p.subtaskId, PROJECT.get(p.subtaskId) ?? ''] as const)), orphanAfterHours: async () => undefined } }),
    } as never) as any
    return { svc, store }
  }
  const first = build()
  if (rule !== 'off') {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    expect(await g.setState('c', 'shadow', { check, facts: facts(T0 - 25 * H) })).toEqual({ ok: true })
    if (rule === 'on') expect(await g.setState('c', 'on', { check, facts: facts(T0) })).toEqual({ ok: true })
  }
  return {
    svc: first.svc, clock, fleet, messages, comments, path,
    reload: build,
    read: id => JSON.parse(readFileSync(path, 'utf8')).deliveries[id],
  }
}

const seed = (w: World, id: string, o: Partial<DeliveryRecord> = {}) => {
  let raw: any
  try { raw = JSON.parse(readFileSync(w.path, 'utf8')) } catch { raw = { version: 1, deliveries: {} } }
  const r = newDelivery({ subtaskId: id, taskId: `t-${id}`, at: iso(T0 - H) }) as any
  r.phase = 'revisao_lider'; r.revision = 2
  r.history = [{ from: 'fila', to: 'revisao_lider', at: iso(T0 - H), actor: 'flow:entrega', revision: 2, detail: 'x' }]
  raw.deliveries[id] = Object.assign(r, o)
  writeFileSync(w.path, JSON.stringify(raw))
}
const tickAt = async (w: World, ms: number) => { w.clock.now = ms; return (await w.reload().svc.tick()).actions as string[] }
const upTo = async (w: World, from: number, to: number, step = 5 * MIN) => { let last: string[] = []; for (let t = from; t <= to; t += step) last = await tickAt(w, t); return last }

/**
 * The positive (§5.4.1) on real stores: L1 filed p1 and acted at T0, then died; L2 is a live leader of the same project with
 * recent activity on p2. p1 gets L2's custody, L2 is messaged once, and the state survives a reload.
 */
async function established(rule: RuleState = 'on'): Promise<World> {
  const w = await world(rule)
  seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
  seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
  w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
  await upTo(w, T0 + 5 * MIN, T0 + N - 5 * MIN)
  if (rule === 'on') {
    expect(w.read('p1').leaderAbsentSince).toBe(iso(T0))
    expect(w.read('p1').custody).toBeUndefined()
  }
  await upTo(w, T0 + N, T0 + N + 10 * MIN)
  return w
}

describe('§5.4.1 positive — real stores, reload after the tick', () => {
  test('custody = the live same-project leader, ONE message delivered, the assignment survives a reload', async () => {
    const w = await established()
    const rec = w.reload().store.get('p1')
    const c = (await rec)!.custody!
    expect(c).toMatchObject({ sessionId: 'L2', via: 'project-leader', project: 'acme/app' })
    expect(c.notifiedAt).toBeTruthy()
    expect(custodyMsgs(w, 'L2')).toHaveLength(1)
    expect(custodyMsgs(w)[0]!.text).toContain('p1')
    expect((await w.reload().store.get('p1'))!.custodyLog?.map(e => e.event)).toEqual(['assigned'])
  })
  test('shadow reports and writes NOTHING: no field, no message', async () => {
    const w = await established('shadow')
    expect(w.read('p1').leaderAbsentSince).toBeUndefined()
    expect(w.read('p1').custody).toBeUndefined()
    expect(custodyMsgs(w)).toHaveLength(0)
  })
  test('shadow says what it would do', async () => {
    const w = await world('shadow')
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    w.fleet.rows = [row('L1', 't-p1', false)]
    const actions = await tickAt(w, T0 + N + 10 * MIN)
    expect(actions.join(' | ')).toContain('custody would-queued p1')
  })
})

describe('OFF — rule C off changes nothing a machine did before', () => {
  test('with custody wired and rule C off, the tick and a leader\'s piece action leave deliveries.json byte-identical to a build WITHOUT custody', async () => {
    const run = async (dir: string, custody: boolean) => {
      mkdirSync(dir, { recursive: true })
      const w = await world('off', { dir, custody })
      seed(w, 'p1', { leaderSessionId: 'L1' })
      w.fleet.rows = [row('L1', 't-p1')]
      await upTo(w, T0 + 5 * MIN, T0 + N + 30 * MIN, 30 * MIN)
      w.clock.now = T0 + N + 40 * MIN
      await w.reload().svc.configure('p1', { versionTarget: '2.0.0' }, 'L1')
      await tickAt(w, T0 + N + 50 * MIN)
      return { bytes: readFileSync(w.path, 'utf8'), w }
    }
    const withCustody = await run(join(root, 'with'), true)
    const without = await run(join(root, 'without'), false)
    expect(withCustody.bytes).toBe(without.bytes)
    const after = JSON.parse(withCustody.bytes).deliveries.p1
    for (const k of CUSTODY_FIELDS) expect(k in after).toBe(false)
    expect(custodyMsgs(withCustody.w)).toHaveLength(0)
  })
})

describe('§5.4.2 zombie, §5.4.3 keep-alive cheats — after the positive', () => {
  test('a zombie (alive row, nothing else) on a sibling piece is orphaned; plain comments and heartbeats never reset it', async () => {
    const w = await established()
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0 + 2 * H) })
    w.fleet.rows = [...w.fleet.rows!, row('Z', 't-p3')]
    // Z comments on p3 every hour (a board comment, not a piece action) and its row stays alive the whole time
    // (a comment is a board write: it never reaches the delivery store, so nothing can stamp the piece's activity)
    for (let t = T0 + 2 * H + 10 * MIN; t < T0 + 2 * H + N; t += H) w.comments.push(`p3: plain comment at ${iso(t)}`)
    await upTo(w, T0 + N + 15 * MIN, T0 + 2 * H + N - 5 * MIN)
    expect(w.read('p3').custody).toBeUndefined() // still inside its N from the last piece action
    await upTo(w, T0 + 2 * H + N, T0 + 2 * H + N + 10 * MIN)
    expect(w.read('p3').custody).toMatchObject({ sessionId: 'L2' })
    expect(w.read('p3').leaderAbsentSince).toBe(iso(T0 + 2 * H))
  })
  test('(d) the original leader\'s REAL piece action through the service door resets absence and returns custody', async () => {
    const w = await established()
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })
    w.fleet.rows = w.fleet.rows!.map(r => (r.id === 'L1' ? { ...r, alive: true } : r)) // the leader comes back
    w.clock.now = T0 + N + 20 * MIN
    const out = await w.reload().svc.configure('p1', { versionTarget: '2.201.0' }, 'L1')
    expect(out.ok).toBe(true)
    expect(w.read('p1')).toMatchObject({ leaderActivityBy: 'L1', leaderActivityAt: iso(T0 + N + 20 * MIN) })
    await tickAt(w, T0 + N + 21 * MIN)
    const rec = (await w.reload().store.get('p1'))!
    expect(rec.custody).toBeUndefined()
    expect(rec.leaderAbsentSince).toBeNull()
    expect(rec.custodyLog?.map(e => e.event)).toEqual(['assigned', 'ended'])
  })
  test('an actor that does not lead the piece stamps nothing (a worker, a stranger, the owner)', async () => {
    const w = await established()
    for (const actor of ['owner', 'stranger-session']) await w.reload().svc.configure('p1', { versionTarget: '2.201.0' }, actor)
    expect(w.read('p1').leaderActivityBy).toBe('L1')
    expect(w.read('p1').leaderActivityAt).toBe(iso(T0))
  })
})

describe('§5.4.4 never-led, §5.4.5 restart', () => {
  test('a piece created with no leader: absence = its stage entry; custody after N, on the real tick', async () => {
    const w = await established()
    const E = T0 + 3 * H
    seed(w, 'pN', { taskId: 't-pN', history: [{ from: 'fila', to: 'revisao_lider', at: iso(E), actor: 'flow:entrega', revision: 2, detail: 'x' }] as never })
    // L2 keeps acting so it stays the project leader
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(E + N - 10 * MIN) })
    await upTo(w, T0 + N + 15 * MIN, E + N - 5 * MIN)
    expect(w.read('pN').leaderAbsentSince).toBe(iso(E))
    expect(w.read('pN').custody).toBeUndefined()
    await upTo(w, E + N, E + N + 10 * MIN)
    expect(w.read('pN').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('restart: absence is read back from disk and the assignment lands at the right instant', async () => {
    const w = await world('on')
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
    w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
    await tickAt(w, T0 + 5 * MIN)
    expect(w.read('p1').leaderAbsentSince).toBe(iso(T0))
    // every in-memory thing is gone: a fresh store and service over the same files, the server was down for 3 h
    await tickAt(w, T0 + 3 * H)
    expect(w.read('p1').leaderAbsentSince).toBe(iso(T0))
    expect(w.read('p1').custody).toBeUndefined()
    await tickAt(w, T0 + N + MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })
  })
})

describe('§5.4.9 custodian dies, §5.4.11 fleet unknown', () => {
  test('the custodian dies: the piece goes back to the queue (no other leader), on disk', async () => {
    const w = await established()
    w.fleet.rows = w.fleet.rows!.map(r => (r.id === 'L2' ? { ...r, alive: false } : r))
    await tickAt(w, T0 + N + 20 * MIN)
    const rec = (await w.reload().store.get('p1'))!
    expect(rec.custody).toMatchObject({ sessionId: null, via: 'queue', project: 'acme/app' })
    expect(rec.custodyLog?.map(e => e.event)).toEqual(['assigned', 'lost', 'queued'])
  })
  test('a fleet that cannot be read changes NOTHING on disk, however far the clock moves', async () => {
    const w = await established()
    const before = ['p1', 'p2'].map(id => custodyState(w.read(id)))
    w.fleet.rows = null
    const actions = await tickAt(w, T0 + 30 * H)
    expect(actions.join(' | ')).toContain('custody-skipped')
    expect(['p1', 'p2'].map(id => custodyState(w.read(id)))).toEqual(before)
  })
})

describe('§5.4.10 cross-project', () => {
  test('a leader of another repository never receives the piece (after the same-project assignment works)', async () => {
    const w = await established()
    seed(w, 'px', { taskId: 't-px', leaderSessionId: 'LX', leaderActivityBy: 'LX', leaderActivityAt: iso(T0 + N + 15 * MIN) })
    w.fleet.rows = [...w.fleet.rows!.map(r => (r.id === 'L2' ? { ...r, alive: false } : r)), row('LX', 't-px')]
    await tickAt(w, T0 + N + 20 * MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: null, via: 'queue' })
    expect(custodyMsgs(w, 'LX')).toHaveLength(0)
  })
})
