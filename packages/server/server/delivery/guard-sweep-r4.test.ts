/** S2b r4: the live re-QA r3 findings (R3-1..R3-6). Harness copied from guard-sweep-r3.test.ts. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createDeliveryStore } from './store'
import { createGuardsStore, type PieceCheckpoint } from './guards-store'
import { createDeliveryService } from './service'
import { execGit } from './classify-host'
import { newDelivery } from './machine'
import { createTaskStore, type TaskStore } from '../sessions/task-store'
import { forbiddenCapabilities } from './guard-ast.testing'
import { flowContext } from './guard'
import { inGuardTransaction } from './guard-transaction'
import { unattributedContext } from './guard'

const T = Date.parse('2026-11-13T10:00:00Z')
const ISO = new Date(T).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: new Date(now).toISOString(), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true),
  def('in_review', 'In review', 'leader', 4), def('pr_merge', 'PR merge', 'merge', 5), def('ci', 'CI', 'ci', 6), def('abandoned', 'Abandoned', 'queue', 7)]
const subtask = (id: string, extra: Record<string, unknown> = {}) => ({ id, taskId: 't1', title: id, done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO, ...extra }) as never

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'qa-s2b-r4-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function world(subs: Array<[string, Record<string, unknown>?]> = [['p1']], quiet = 40) {
  const clock = { now: T }
  const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
  const sessions = [{ id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: '/nowhere', harness: 'claude', worktree: false }]
  const deps = { sessions: async () => sessions, git: execGit }
  const tasks: TaskStore = createTaskStore(paths.tasks, { guard: { deps, now: () => clock.now } })
  await tasks.seedStatuses(DEFS)
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  for (const [id, extra] of subs) await tasks.upsertSubtask(subtask(id, extra), unattributedContext())
  for (let i = 0; i < quiet; i++) await tasks.upsertTask({ id: `quiet-${i}`, title: 'quiet', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  const store = createDeliveryStore(paths.deliveries, { guard: { deps, now: () => clock.now } })
  const calls: string[] = []
  const board: any = { comment: async () => undefined, subtaskFinished: async () => false, setPhaseStatus: async (key: string) => { calls.push(key); return { ok: true } } }
  const logs: string[] = []
  const svc = createDeliveryService({
    store,
    facts: { subtask: async (id: string) => ({ id, taskId: 't1', title: id, status: 'in_progress', groupMember: false, blockedBy: [] }), sessions: async () => sessions, blockedSubtasks: async () => [] } as never,
    board,
    notify: { session: async () => true, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => clock.now,
    classify: { sessions: async () => sessions, git: execGit },
    guardsPath: paths.guards, autoReconcile: () => false, log: (line: string) => logs.push(line),
    sweep: { tasks: async () => tasks, paths },
  } as never) as any
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  expect(await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })).toEqual({ ok: true })
  expect(await g.setState('a', 'on', { check, facts: facts(T) })).toEqual({ ok: true })
  const guards = createGuardsStore(paths.guards)
  await guards.write({ ...(await guards.read()), migrations: { a: { version: 1, at: ISO } } })
  return { svc, tasks, store, guards, clock, paths, board, logs, calls }
}
type W = Awaited<ReturnType<typeof world>>
const cp = (key: string, o: Partial<PieceCheckpoint> = {}): PieceCheckpoint => ({
  key, rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', revision: 2, headSha: null,
  auth: [{ kind: 'evidence', ids: ['e1'], sha256: ['aa'] }], by: { kind: 'flow', engine: 'entrega' }, at: ISO, transitionId: `tr-${key}`, ...o,
} as PieceCheckpoint)
const cp0 = (key: string, o: Partial<PieceCheckpoint> = {}) => cp(key, { rank: 0, phase: 'executando', boardStatus: 'in_progress', boardStage: 'running', auth: [{ kind: 'grandfathered', at: ISO }] as never, ...o })
const writeCp = async (w: W, c: PieceCheckpoint) => { const doc = await w.guards.read(); await w.guards.write({ ...doc, checkpoints: { ...doc.checkpoints, [c.key]: c } }) }
const record = (id: string, phase: string, extra: Record<string, unknown> = {}) => {
  const r = newDelivery({ subtaskId: id, taskId: 't1', at: ISO }) as any
  r.phase = phase; r.revision = 2
  r.history = [{ from: 'fila', to: 'executando', at: ISO, actor: 'flow:entrega', revision: 1, detail: 'start' }]
  r.evidence = [{ id: 'e1', sha256: 'aa', revision: 1 }]
  return Object.assign(r, extra)
}
const forgeBoard = (w: W, pick: (s: any) => boolean, patch: Record<string, unknown>) => {
  const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  raw.subtasks = raw.subtasks.map((s: any) => (pick(s) ? { ...s, ...patch } : s))
  writeFileSync(w.paths.tasks, JSON.stringify(raw))
}
const forgeDelivery = (w: W, id: string, patch: Record<string, unknown>) => {
  let raw: any
  try { raw = JSON.parse(readFileSync(w.paths.deliveries, 'utf8')) } catch { raw = { version: 1, deliveries: {} } }
  raw.deliveries[id] = { ...(raw.deliveries[id] ?? record(id, 'executando')), ...patch }
  writeFileSync(w.paths.deliveries, JSON.stringify(raw))
}
const sub = async (w: W, id: string) => (await w.tasks.read()).subtasks.find(s => s.id === id)! as any
const sweepLines = (a: string[]) => a.filter(x => x.startsWith('sweep'))
const OWNER = { principal: { kind: 'owner', via: 'legacy-browser' } } as never
const SESSION = { principal: { kind: 'session', id: 'worker-1', via: 'token' } } as never
const VAULT_OWNER = { principal: { kind: 'owner', via: 'vault-credential', grantId: 'g-1' } } as never
const UNATTRIBUTED = { principal: { kind: 'unattributed' } } as never
const member = (id: string, status: string) => [id, { parentGroupId: 'g', status, done: status === 'done' }] as [string, Record<string, unknown>]
const at = { status: 'done', at: ISO }

test('R3-1 a group of 17: 14 guard-accepted done members stay, only the 3 forged ones revert (incl. the abandoned one), then quiet', async () => {
  const members = [...Array.from({ length: 14 }, (_, i) => member(`m${i}`, 'done')), member('m14', 'todo'), member('m15', 'todo'), member('m16', 'abandoned')]
  const w = await world([['g', { isGroup: true }], ...members])
  const recorded = Object.fromEntries(members.map(([id, x]) => [id, { status: x.status, at: ISO }]))
  await writeCp(w, cp0('g', { members: recorded } as never))
  forgeBoard(w, s => ['m14', 'm15', 'm16'].includes(s.id), { status: 'done', done: true })
  const t1 = await w.svc.tick()
  const reverted = sweepLines(t1.actions).filter(a => a.startsWith('sweep-revert')).map(a => a.split(' ')[1]!.replace(':', '')).sort()
  expect(reverted).toEqual(['m14', 'm15', 'm16'])
  for (let i = 0; i < 14; i++) expect((await sub(w, `m${i}`)).status).toBe('done')
  expect([(await sub(w, 'm14')).status, (await sub(w, 'm15')).status, (await sub(w, 'm16')).status]).toEqual(['todo', 'todo', 'abandoned'])
  w.clock.now += 60_000
  expect(sweepLines((await w.svc.tick()).actions)).toEqual([])
})

test('R3-1 a quiet tick records the accepted member statuses once (no further writes afterwards)', async () => {
  const w = await world([['g', { isGroup: true }], member('m1', 'done'), member('m2', 'in_progress')])
  await writeCp(w, cp0('g'))
  await w.svc.tick()
  const members = (await w.guards.read()).checkpoints.g!.members as any
  expect(Object.fromEntries(Object.entries(members).map(([k, v]: any) => [k, v.status]))).toEqual({ m1: 'done', m2: 'in_progress' })
  const before = readFileSync(w.paths.guards, 'utf8')
  w.clock.now += 60_000
  await w.svc.tick()
  expect(readFileSync(w.paths.guards, 'utf8')).toBe(before)
})

test('R3-1 the guard records the member statuses it accepts when the owner retreats the group', async () => {
  const w = await world([['g', { isGroup: true }], member('m1', 'done'), member('m2', 'done')])
  await writeCp(w, cp('g', { rank: 4, boardStatus: 'done', boardStage: 'published', phase: null, members: { m1: { status: 'done', at: ISO }, m2: { status: 'done', at: ISO } } } as never))
  // the group is done (rank 4); the owner reopens ONE member: a guarded retreat that accepts only that member's new status
  // r8 A: the LEGACY owner (headers, no vault proof) is refused (accepted_reopen) and the piece stays; the owner WITH vault proof reopens
  const refused = await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'in_progress', done: false }, OWNER).then(() => null, (e: any) => e?.code)
  expect(refused).toBe('accepted_reopen')
  expect((await sub(w, 'm1')).status).toBe('done')
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'in_progress', done: false }, VAULT_OWNER)
  const c = (await w.guards.read()).checkpoints.g!
  expect(Object.fromEntries(Object.entries(c.members as any).map(([k, v]: any) => [k, v.status]))).toEqual({ m1: 'in_progress', m2: 'done' })
  w.clock.now += 60_000
  expect(sweepLines((await w.svc.tick()).actions).filter(a => a.startsWith('sweep-revert'))).toEqual([])
})

test('R3-2 forged pieces WITH a checkpoint are repaired even in a small store and next to many checkpoint-less forgeries', async () => {
  const w = await world([['x0'], ['x1'], ['x2']], 0)
  for (const id of ['x0', 'x1', 'x2']) await writeCp(w, cp0(id, { phase: null, auth: [] }))
  forgeBoard(w, s => s.id.startsWith('x'), { status: 'done' })
  const out = await w.svc.tick()
  expect(out.actions.join(' ')).not.toContain('breaker')
  expect(out.actions.filter((a: string) => a.startsWith('sweep-revert'))).toHaveLength(3)
  expect((await sub(w, 'x0')).status).toBe('in_progress')
})

test('R3-2 a checkpointed forgery is repaired while the no_checkpoint breaker trips for the others', async () => {
  const subs: Array<[string, Record<string, unknown>?]> = [['p1'], ...Array.from({ length: 25 }, (_, i) => [`n${i}`] as [string])]
  const w = await world(subs)
  await writeCp(w, cp0('p1', { phase: null, auth: [] }))
  forgeBoard(w, s => s.id === 'p1' || s.id.startsWith('n'), { status: 'done' })
  const out = await w.svc.tick()
  expect(out.actions).toContain('sweep-skipped: no_checkpoint_breaker')
  expect(out.actions.some((a: string) => a.startsWith('sweep-revert p1'))).toBe(true)
  expect((await sub(w, 'p1')).status).toBe('in_progress')
  expect((await sub(w, 'n0')).status).toBe('done')
})

test('R3-2 checkpointed reverts have their own absolute ceiling', async () => {
  const subs = Array.from({ length: 101 }, (_, i) => [`c${i}`] as [string])
  const w = await world(subs, 0)
  for (let i = 0; i < 101; i++) await writeCp(w, cp0(`c${i}`, { phase: null, auth: [] }))
  forgeBoard(w, s => s.id.startsWith('c'), { status: 'done' })
  const before = readFileSync(w.paths.tasks, 'utf8')
  const out = await w.svc.tick()
  expect(out.actions).toContain('sweep-skipped: checkpoint_ceiling')
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
})

for (const [label, ctx] of [['owner', OWNER], ['session', SESSION], ['unattributed', UNATTRIBUTED]] as const) {
  test(`R3-3 (${label}) a guard-accepted drag back is never caught up again, the card stays`, async () => {
    const w = await world()
    await writeCp(w, cp('p1'))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    forgeBoard(w, s => s.id === 'p1', { status: 'in_review' })
    await w.svc.tick(); w.clock.now += 60_000
    await w.tasks.upsertSubtask({ ...(await sub(w, 'p1')), status: 'in_progress' }, ctx)
    for (let i = 0; i < 2; i++) { const out = await w.svc.tick(); w.clock.now += 60_000; expect(sweepLines(out.actions)).toEqual([]) }
    expect((await sub(w, 'p1')).status).toBe('in_progress')
    expect(w.calls).toEqual([])
  })
}

test('R3-3 abandoned is a decision, never caught up', async () => {
  const w = await world()
  await writeCp(w, cp('p1'))
  forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
  forgeBoard(w, s => s.id === 'p1', { status: 'abandoned' })
  expect(sweepLines((await w.svc.tick()).actions)).toEqual([])
  expect(w.calls).toEqual([])
})

test('R3-3 CU1 a board that lagged with no recorded retreat is still caught up', async () => {
  const w = await world()
  await writeCp(w, cp('p1'))
  forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
  const out = await w.svc.tick()
  expect(out.actions.some((a: string) => a.startsWith('sweep-catch-up p1'))).toBe(true)
  expect(w.calls).toEqual(['p1'])
})

test('R3-4 a CI signal forged on the GROUP repairs the group only, never a legitimately finished member', async () => {
  const w = await world([['g', { isGroup: true }], member('m1', 'in_progress'), member('m2', 'in_progress')])
  await writeCp(w, cp0('g'))
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'done', done: true }, OWNER)
  forgeBoard(w, s => s.id === 'g', { ci: { tagPublished: false } })
  const out = await w.svc.tick()
  const lines = sweepLines(out.actions)
  expect(lines.some(l => l.startsWith('sweep-revert g'))).toBe(true)
  expect(lines.some(l => l.startsWith('sweep-revert m1'))).toBe(false)
  expect(lines.some(l => l.includes('no_member_baseline'))).toBe(false)
  expect((await sub(w, 'm1')).status).toBe('done')
})

test('R3-5 the constructor ceiling follows spreads and refuses indirect Reflect', () => {
  const P = "const f = () => 0; let C: any;"
  const attacks = [
    `${P} [...[{ constructor: C }]] = [f]`,
    `${P} ({ ...{ constructor: C } } = {})`,
    `${P} const R = Reflect; R.get(f, 'constructor')`,
    `${P} let g: any; ({ get: g } = Reflect); g(f, 'constructor')`,
    `${P} const a: any = [f, 'constructor']; Reflect.apply(Reflect.get, null, a)`,
    `${P} Reflect.get.call(null, f, 'constructor')`,
    `${P} Reflect.get.bind(null)(f, 'constructor')`,
    `${P} const { get: g } = Reflect; g(f, 'constructor')`,
    `${P} for ({ constructor: C } in { k: 0 });`,
  ]
  for (const src of attacks) expect(forbiddenCapabilities(src).length, src).toBeGreaterThan(0)
  const controls = [
    'const x = new Map(); console.log(x.constructor.name)',
    'const x: unknown = new Map(); if ((x as any).constructor === Map) console.log(1)',
    'class A { constructor(readonly n: number) {} }; console.log(new A(1).n)',
    'const o = { a: 1 }; console.log(Reflect.get(o, "a"))',
    'let a: any, b: any; [{ a }, b] = [{ a: 1 }, 2]; console.log(a, b)',
  ]
  for (const src of controls) expect(forbiddenCapabilities(src), src).toEqual([])
})

test('R3-6 a REST write between the snapshot and the catch-up envelope yields sweep_changed and no write', async () => {
  const run = async (inject: boolean) => {
    const w = await world()
    await writeCp(w, cp('p1'))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    const real = w.tasks.read.bind(w.tasks)
    let reads = 0, armed = -1
    ;(w.tasks as any).read = async () => {
      reads++
      // The first read INSIDE the guard envelope is the catch-up's `unchanged()` snapshot: a write landing just before it (a REST
      // write after the loop's own snapshot) must be seen there. Without that check this read never happens and nothing is injected.
      if (inject && armed < 0 && inGuardTransaction(w.paths)) { armed = reads; forgeBoard(w, s => s.id === 'p1', { status: 'blocked', blockedReason: 'externo: rest' }) }
      return real()
    }
    return { w, count: () => reads, arm: (n: number) => { armed = n } }
  }
  const control = await run(false)
  await control.w.svc.tick()
  expect(control.w.calls).toEqual(['p1'])
  rmSync(root, { recursive: true, force: true }); root = mkdtempSync(join(tmpdir(), 'qa-s2b-r4-'))
  const hit = await run(true)
  const out = await hit.w.svc.tick()
  expect(sweepLines(out.actions).some(a => a.startsWith('sweep-catch-up p1'))).toBe(false)
  expect(hit.w.calls).toEqual([])
  expect((await sub(hit.w, 'p1')).status).toBe('blocked')
})
