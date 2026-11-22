/**
 * S7a r3 — the independent QA's probes (N1–N3) and the two surviving mutants (Q4, Q6), against REAL stores in a temp dir.
 * Every negative runs after a positive in the same fixture (the control proves the fixture can do the thing).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts, type RuleState } from './activation'
import { createDeliveryStore } from './store'
import { createDeliveryService } from './service'
import { newDelivery, type DeliveryRecord } from './machine'
import { orphanMsOf } from './custody'
import { lockFile } from '../sessions/file-lock'
import { createTaskStore } from '../sessions/task-store'

const MIN = 60_000
const H = 3600_000
const N = orphanMsOf(undefined)
const T0 = Date.parse('2026-11-16T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: iso(now), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3', 'S7'], migrated: ['a', 'c'], unexplainedWouldRefuse: 0 })
const PROJECT = new Map<string, string>([['p1', 'acme/app'], ['p2', 'acme/app'], ['p3', 'acme/app'], ['t-tl', 'acme/app']])

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'custody-r3-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface Row { id: string; role: string; taskId: string; alive: boolean; cwd: string; harness: string; worktree: boolean }
const row = (id: string, taskId: string, alive = true, role = 'leader'): Row => ({ id, role, taskId, alive, cwd: '/nowhere', harness: 'claude', worktree: false })

interface World {
  clock: { now: number }; fleet: { rows: Row[] }; messages: Array<{ to: string; text: string }>; path: string
  hooks: { onNotify?: (to: string) => void }
  tasks: ReturnType<typeof createTaskStore>; svc(): any; read(id: string): any
}
async function world(rules: { a?: RuleState; c: RuleState }): Promise<World> {
  const clock = { now: T0 }
  const fleet = { rows: [] as Row[] }
  const messages: World['messages'] = []
  const hooks: World['hooks'] = {}
  const path = join(root, 'deliveries.json')
  const tasks = createTaskStore(join(root, 'tasks.json'))
  const svc = () => createDeliveryService({
    store: createDeliveryStore(path) as never,
    facts: { subtask: async (id: string) => ({ id, taskId: id.startsWith('t-') ? id : `t-${id}`, title: id, status: 'in_review', groupMember: false, blockedBy: [] }), sessions: async () => fleet.rows, blockedSubtasks: async () => [], gh: async () => '', git: async () => '' } as never,
    board: { comment: async () => undefined, subtaskFinished: async () => false, setPhaseStatus: async () => ({ ok: true }), setCi: async () => undefined } as never,
    notify: { session: async (to: string, text: string) => { messages.push({ to, text }); hooks.onNotify?.(to); return fleet.rows.find(r => r.id === to)?.alive === true }, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => clock.now, autoReconcile: () => false,
    custody: { tasks: async () => tasks, projectsOf: async (pieces: ReadonlyArray<{ subtaskId: string }>) => new Map(pieces.map(p => [p.subtaskId, PROJECT.get(p.subtaskId) ?? ''] as const)), orphanAfterHours: async () => undefined },
  } as never) as any
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  for (const [rule, state] of [['c', rules.c], ['a', rules.a ?? 'off']] as const) {
    if (state === 'off') continue
    expect(await g.setState(rule, 'shadow', { check, facts: facts(T0 - 25 * H) })).toEqual({ ok: true })
    if (state === 'on') expect(await g.setState(rule, 'on', { check, facts: facts(T0) })).toEqual({ ok: true })
  }
  return { clock, fleet, messages, hooks, path, tasks, svc, read: id => JSON.parse(readFileSync(path, 'utf8')).deliveries[id] }
}
const seed = (w: World, id: string, o: Partial<DeliveryRecord> = {}) => {
  let raw: any
  try { raw = JSON.parse(readFileSync(w.path, 'utf8')) } catch { raw = { version: 1, deliveries: {} } }
  const r = newDelivery({ subtaskId: id, taskId: id.startsWith('t-') ? id : `t-${id}`, at: iso(T0 - H) }) as any
  r.phase = 'revisao_lider'; r.revision = 2
  r.history = [{ from: 'fila', to: 'revisao_lider', at: iso(T0 - H), actor: 'flow:entrega', revision: 2, detail: 'x' }]
  raw.deliveries[id] = Object.assign(r, o)
  writeFileSync(w.path, JSON.stringify(raw))
}
const tickAt = async (w: World, ms: number) => { w.clock.now = ms; return (await w.svc().tick()).actions as string[] }
const upTo = async (w: World, from: number, to: number, step = 10 * MIN) => { for (let t = from; t <= to; t += step) await tickAt(w, t) }
const custodyMsgs = (w: World, to?: string) => w.messages.filter(m => m.text.includes('flow custódia') && (to === undefined || m.to === to))

/** L1 filed p1, acted at T0, died; L2 (live leader of the same project) takes custody at N+. */
async function established(rules: { a?: RuleState; c: RuleState } = { c: 'on' }): Promise<World> {
  const w = await world(rules)
  seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
  seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
  w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
  await upTo(w, T0 + 10 * MIN, T0 + N - 10 * MIN)
  expect(w.read('p1').custody).toBeUndefined()
  await upTo(w, T0 + N, T0 + N + 10 * MIN, 5 * MIN)
  expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2', via: 'project-leader' })
  expect(custodyMsgs(w, 'L2')).toHaveLength(1)
  return w
}

describe('N1 — a door under rule C on is fail-closed whatever rule A says (§2.6.1: never write after a timeout while another holds the lock)', () => {
  for (const a of ['off', 'shadow'] as const) {
    test(`A ${a} / C on: a leader configure while another process holds deliveries.json answers guard_busy and writes nothing`, async () => {
      const w = await established({ a, c: 'on' })
      w.clock.now = T0 + N + 20 * MIN
      const ok = await w.svc().configure('p2', { versionTarget: '1.0.0' }, 'L2')
      expect(ok.ok).toBe(true) // control: with a free lock the same door stamps
      expect(w.read('p2').leaderActivityAt).toBe(iso(w.clock.now))
      const before = readFileSync(w.path, 'utf8')
      const held = await lockFile(w.path)
      expect(held.contended).toBe(false)
      let out: any
      try { w.clock.now += MIN; out = await w.svc().configure('p2', { versionTarget: '2.0.0' }, 'L2') } finally { await held.release() }
      expect(readFileSync(w.path, 'utf8')).toBe(before)
      expect(out.ok).toBe(false)
      expect(out.status).toBe(409)
      expect(out.code).toBe('guard_busy')
    }, 30_000)
  }
  test('C off / A off: the door keeps the old path (unchanged behaviour, no custody stamp)', async () => {
    const w = await world({ c: 'off' })
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2' })
    w.fleet.rows = [row('L2', 't-p2')]
    const out = await w.svc().configure('p2', { versionTarget: '1.0.0' }, 'L2')
    expect(out.ok).toBe(true)
    expect(w.read('p2').leaderActivityAt).toBeUndefined()
  })
})

describe('N2 — a worker\'s verified block/decision never masks the custodian\'s activity', () => {
  const comment = (w: World, id: string, who: string, kind: string, at: number) => w.tasks.addComment({ id, taskId: 't-p1', subtaskId: 'p1', threadId: 'th1', role: 'session', sessionId: who, kind, author: who, body: 'x', createdAt: iso(at) } as never)
  async function scene() {
    const w = await established()
    w.fleet.rows = [...w.fleet.rows, row('L3', 't-p3'), row('W1', 't-p1', true, 'worker')]
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'L3', leaderActivityBy: 'L3', leaderActivityAt: iso(T0 + N + 3 * H) })
    return { w, assignedAt: Date.parse(w.read('p1').custody.since) }
  }
  test('control: the custodian\'s own decision keeps it custodian past N after the assignment', async () => {
    const { w, assignedAt } = await scene()
    await comment(w, 'c-l2', 'L2', 'decision', assignedAt + 3 * H)
    await tickAt(w, assignedAt + N + 5 * MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('attack: a verified worker block after it does not take the custody away (L3 is never assigned p1)', async () => {
    const { w, assignedAt } = await scene()
    await comment(w, 'c-l2', 'L2', 'decision', assignedAt + 3 * H)
    await comment(w, 'c-w1', 'W1', 'block', assignedAt + 3 * H + 30 * MIN)
    await tickAt(w, assignedAt + N + 5 * MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })
    expect((w.read('p1').custodyLog ?? []).map((e: any) => `${e.event}:${e.sessionId}`)).toEqual(['assigned:L2'])
  })
  test('attack on the archived leader: a worker block never erases the live filed leader\'s presence or candidacy', async () => {
    const w = await world({ c: 'on' })
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0 + 2 * H) })
    seed(w, 'p9', { taskId: 't-p9', leaderSessionId: 'L9', leaderActivityBy: 'L9', leaderActivityAt: iso(T0) })
    w.fleet.rows = [row('L1', 't-p1'), row('L9', 't-p9', false), row('W1', 't-p1', true, 'worker')]
    await comment(w, 'c-w1', 'W1', 'block', T0 + 3 * H)
    await tickAt(w, T0 + 2 * H + N - 10 * MIN)
    expect(w.read('p1').leaderAbsentSince ?? null).toBeNull()
    expect(w.read('p1').custody).toBeUndefined()
  })
})

describe('N3 — task-level piece: an unverified board status event is not a keep-alive', () => {
  const statusEvent = (w: World, at: number, actor: string) => w.tasks.logEvents([{ id: `e-${at}-${actor}`, taskId: 't-tl', at: iso(at), actor, kind: 'status', from: 'in_progress', to: 'in_progress' } as never])
  async function scene() {
    const w = await established()
    seed(w, 't-tl', { taskId: 't-tl', leaderSessionId: 'LZ', leaderActivityBy: 'LZ', leaderActivityAt: iso(T0 + N) })
    w.fleet.rows = [...w.fleet.rows, row('LZ', 't-tl')]
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + 2 * N) })
    return w
  }
  test('control: the zombie leader (alive, no action) of a task-level piece is taken at N+', async () => {
    const w = await scene()
    await upTo(w, T0 + N + 20 * MIN, T0 + 2 * N + 20 * MIN, 20 * MIN)
    expect(w.read('t-tl').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('attack: an hourly idempotent in_progress→in_progress status event with actor "LZ" (free text) keeps nobody present', async () => {
    const w = await scene()
    for (let t = T0 + N + 20 * MIN; t <= T0 + 2 * N + 20 * MIN; t += 20 * MIN) {
      if ((t - T0) % H === 20 * MIN) await statusEvent(w, t - MIN, 'LZ')
      await tickAt(w, t)
    }
    expect(w.read('t-tl').custody?.sessionId).toBe('L2')
  })
})

describe('Q4 — the delivery mark only lands on the custodian that was actually told', () => {
  test('custody moving to another session between the message and the mark leaves notifiedAt unset', async () => {
    const w = await world({ c: 'on' })
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
    w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
    await upTo(w, T0 + 10 * MIN, T0 + N - 10 * MIN)
    w.hooks.onNotify = () => { // between the send and the mark, another process hands the piece to L3
      const raw = JSON.parse(readFileSync(w.path, 'utf8'))
      raw.deliveries.p1.custody = { ...raw.deliveries.p1.custody, sessionId: 'L3' }
      writeFileSync(w.path, JSON.stringify(raw))
      w.hooks.onNotify = undefined
    }
    await tickAt(w, T0 + N + 5 * MIN)
    expect(custodyMsgs(w, 'L2')).toHaveLength(1)
    expect(w.read('p1').custody.sessionId).toBe('L3')
    expect(w.read('p1').custody.notifiedAt).toBeUndefined()
  })
  test('control: with the custody unchanged the mark lands', async () => {
    const w = await established()
    expect(w.read('p1').custody.notifiedAt).toBeDefined()
  })
})

describe('Q6 — a release declaration stamps the pieces it changed, and only them', () => {
  test('the filed leader declares: the changed piece carries the stamp in the same write; an untouched one does not', async () => {
    const w = await world({ c: 'on' })
    seed(w, 'p1', { leaderSessionId: 'L1' })
    seed(w, 'p2', { taskId: 't-p1', leaderSessionId: 'L1', phase: 'ci', versionTarget: '2.0.0', mergeSha: 'a'.repeat(40), tag: 'v2.0.0', releaseRepo: 'acme/app', ci: { mergedMain: true, releaseGreen: false, tagPublished: false, tag: 'v2.0.0', pr: null } } as never)
    w.fleet.rows = [row('L1', 't-p1')]
    w.clock.now = T0 + 5 * MIN
    const out = await w.svc().release({ version: '2.0.0', mergeSha: 'a'.repeat(40), subtaskIds: ['p1', 'p2'], repo: 'acme/app' }, 'L1')
    expect(out.ok).toBe(true)
    expect(w.read('p1')).toMatchObject({ phase: 'ci', leaderActivityBy: 'L1', leaderActivityAt: iso(w.clock.now) })
    expect(w.read('p2').leaderActivityAt).toBeUndefined()
  })
  test('control: rule C off stamps nothing', async () => {
    const w = await world({ c: 'off' })
    seed(w, 'p1', { leaderSessionId: 'L1' })
    w.fleet.rows = [row('L1', 't-p1')]
    const out = await w.svc().release({ version: '2.0.0', mergeSha: 'a'.repeat(40), subtaskIds: ['p1'], repo: 'acme/app' }, 'L1')
    expect(out.ok).toBe(true)
    expect(w.read('p1').leaderActivityAt).toBeUndefined()
  })
})

const boardComment = (w: World, id: string, piece: string, by: string, kind: 'decision' | 'block', at: number) =>
  w.tasks.addComment({ id, taskId: `t-${piece}`, subtaskId: piece, threadId: 'th1', role: 'session', sessionId: by, kind, author: by, body: kind, createdAt: iso(at) } as never)

describe('N5 (r5) — a co-leader of the task who acted and then died anchors the absence at ITS action, not at the old filed leader\'s stamp', () => {
  const coLeader = async (l4Dies: boolean) => {
    const w = await world({ c: 'on' })
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + 4 * H) })
    w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2'), row('L4', 't-p1')]
    await boardComment(w, 'c-l4', 'p1', 'L4', 'decision', T0 + 3 * H)
    await upTo(w, T0 + 3 * H + 10 * MIN, T0 + 3 * H + 30 * MIN)
    expect(w.read('p1').custody ?? null).toBeNull() // L4 present
    if (l4Dies) w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2'), row('L4', 't-p1', false)]
    await upTo(w, T0 + 3 * H + 40 * MIN, T0 + 4 * H + 10 * MIN)
    return w
  }
  test('control: L4 alive → no custody 70 min after its decision', async () => {
    expect((await coLeader(false)).read('p1').custody ?? null).toBeNull()
  })
  test('attack: L4 dies 30 min after its decision → no custody before T0+3h+N; absence anchored at ≥ its action', async () => {
    const rec = (await coLeader(true)).read('p1')
    expect(rec.custody ?? null).toBeNull()
    expect(Date.parse(rec.leaderAbsentSince)).toBeGreaterThanOrEqual(T0 + 3 * H)
  })
  // Remaining limit (S7b): eligibility is read off the fleet registry; if the co-leader's row is PURGED its eligibility vanishes and
  // the absence falls back to the filed leader's stamp. Closing that needs the comment to carry the author's role+task.
})

describe('N6 (r5) — eligibility on the task board and on the record\'s own stamp', () => {
  test('R4-P4: a live leader of ANOTHER task posting a verified block on the piece is not eligible', async () => {
    const w = await established()
    w.fleet.rows = [...w.fleet.rows, row('L3', 't-p3'), row('LX', 't-other')]
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'L3', leaderActivityBy: 'L3', leaderActivityAt: iso(T0 + N + 3 * H) })
    const assignedAt = Date.parse(w.read('p1').custody.since)
    await boardComment(w, 'c-l2', 'p1', 'L2', 'decision', assignedAt + 3 * H)
    await boardComment(w, 'c-lx', 'p1', 'LX', 'block', assignedAt + 3 * H + 30 * MIN)
    await tickAt(w, assignedAt + N + 5 * MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })
    expect(w.read('p1').custodyLog.map((e: any) => `${e.event}:${e.sessionId}`)).toEqual(['assigned:L2'])
    expect(custodyMsgs(w, 'LX')).toHaveLength(0)
  })
  const stamped = async (by: string, rows: Row[]) => {
    const w = await world({ c: 'on' })
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: by, leaderActivityAt: iso(T0 + 3 * H) })
    seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + 8 * H) })
    w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2'), ...rows]
    await tickAt(w, T0 + 4 * H)
    return w.read('p1')
  }
  test('the record stamp of a DEAD co-leader of the same task anchors the absence at its instant', async () => {
    const rec = await stamped('L4', [row('L4', 't-p1', false)])
    expect(rec.leaderAbsentSince).toBe(iso(T0 + 3 * H))
  })
  test('the record stamp of a worker, or of a leader of another task, anchors nothing (absence = now)', async () => {
    for (const r of [row('W1', 't-p1', true, 'worker'), row('LX', 't-other', false)]) {
      const rec = await stamped(r.id, [r])
      expect(rec.leaderAbsentSince).toBe(iso(T0 + 4 * H))
    }
  })
})
