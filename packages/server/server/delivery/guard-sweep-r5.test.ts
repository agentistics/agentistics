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
import { inGuardTransaction, withGuardEnvelope } from './guard-transaction'
import { effectiveSubtasks } from '../sessions/task-report'
import { guardedWrite } from './guard-host'
import { documentsShow, guardSweep } from './sweep'
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

test('QA OLD first tick never reverts accepted delivered members', async () => {
 const members = [...Array.from({length:14},(_,i)=>member('m'+i,'done')),member('m14','todo'),member('m15','todo'),member('m16','abandoned')];
 const w=await world([['g',{isGroup:true}],...members]);
 await writeCp(w,cp0('g'));
 forgeBoard(w,s=>['m14','m15','m16'].includes(s.id),{status:'done',done:true});
 const out=await w.svc.tick();
 console.log('OLD',out.actions, (await w.tasks.read()).subtasks.map(s=>[s.id,s.status]));
 for(let i=0;i<14;i++) expect((await sub(w,'m'+i)).status).toBe('done');
 expect(out.actions.filter((a: string) => a.includes('no_member_baseline'))).toHaveLength(17)
 expect((await w.guards.read()).checkpoints.g!.members).toBeUndefined()
 expect((await w.tasks.read()).comments.filter(c => c.author === 'flow:entrega')).toHaveLength(0)
});
test('QA MEMBERS more than one chunk all forged members restored', async () => {
 const members=[...Array.from({length:14},(_,i)=>member('m'+i,'done')),...Array.from({length:9},(_,i)=>member('f'+i,'todo'))];
 const w=await world([['g',{isGroup:true}],...members]);
 await writeCp(w,cp0('g',{members:Object.fromEntries(members.map(([id,x])=>[id,{status:x.status,at:ISO}]))} as never));
 forgeBoard(w,s=>s.id.startsWith('f'),{status:'done',done:true});
 const first = await w.svc.tick()
 expect(first.actions.filter((a: string) => a.startsWith('sweep-revert'))).toHaveLength(9)
 for(let i=0;i<2;i++){const out=await w.svc.tick();expect(sweepLines(out.actions)).toEqual([]);w.clock.now+=60_000;}
 const forged=(await w.tasks.read()).subtasks.filter(s=>s.id.startsWith('f'));
 console.log('CHUNKS-RESULT',forged.map(s=>[s.id,s.status]),(await w.guards.read()).checkpoints.g!.members);
 expect(forged.every(s=>s.status==='todo')).toBe(true);
});
test('QA RESTORE a changed high accepted member returns to its recorded status', async () => {
 const members=[member('m0','done'),member('m1','todo')];
 const w=await world([['g',{isGroup:true}],...members]);
 await writeCp(w,cp0('g',{members:Object.fromEntries(members.map(([id,x])=>[id,{status:x.status,at:ISO}]))} as never));
 forgeBoard(w,s=>s.id==='m0',{status:'ci',done:false});
 forgeBoard(w,s=>s.id==='m1',{status:'done',done:true});
 const out=await w.svc.tick();console.log('RESTORE',out.actions,(await sub(w,'m0')).status);
 expect((await sub(w,'m0')).status).toBe('done');
});
test('QA ACCEPTED member completed through guard before next tick remains accepted',async()=>{
 const members=[member('m0','todo'),member('m1','todo')];
 const w=await world([['g',{isGroup:true}],...members]);
 await writeCp(w,cp0('g',{members:Object.fromEntries(members.map(([id,x])=>[id,{status:x.status,at:ISO}]))} as never));
 await w.tasks.upsertSubtask({...await sub(w,'m0'),status:'done',done:true},SESSION);
 expect((await w.guards.read()).checkpoints.g!.members!.m0!.status).toBe('done')
 console.log('GUARD-ACCEPTED-MEMBERS',(await w.guards.read()).checkpoints.g!.members);
 forgeBoard(w,s=>s.id==='m1',{status:'done',done:true});
 const out=await w.svc.tick();console.log('GUARD-ACCEPTED-RESULT',out.actions,(await sub(w,'m0')).status);
 expect((await sub(w,'m0')).status).toBe('done');
});
test('QA BREAKER floor permits one no-checkpoint repair in a small store',async()=>{
 const w=await world([['p1']],0);
 forgeBoard(w,s=>s.id==='p1',{status:'done',done:true});
 const out=await w.svc.tick();console.log('BREAKER-FLOOR',out.actions);
 expect((await sub(w,'p1')).status).toBe('in_progress');
});

test('R4-6 Reflect requires a statically safe key', () => {
 expect(forbiddenCapabilities("const k = ['constructor'][0]; const C = Reflect.get(() => 0, k); C('return 7')();")).toContain('reflect-indirect')
 expect(forbiddenCapabilities("Reflect.get({ ok: 1 }, 'ok')")).toEqual([])
 expect(forbiddenCapabilities("Reflect.get(() => 0, 'constructor')")).toContain('constructor-reflect-get')
 expect(forbiddenCapabilities("const k = ['get'][0]; Reflect[k](() => 0, 'constructor')")).toContain('reflect-indirect')
 expect(forbiddenCapabilities("let k = 'safe'; k = ['constructor'][0]; Reflect.get(() => 0, k)")).toContain('reflect-indirect')
})

test('r5 member-only intent recovery checks the actual member write', () => {
  const target = cp0('g', { phase: null, members: { m0: { status: 'done', at: ISO } } })
  const group: any = { key: 'g', boardStatus: 'in_progress', record: null }
  const member: any = { key: 'm0', boardStatus: 'todo', record: null }
  const views = new Map([['g', group], ['m0', member]])
  expect(documentsShow({ ...target }, views)).toBe(false)
  member.boardStatus = 'done'
  expect(documentsShow({ ...target }, views)).toBe(true)
})

test('r5 an unreadable checkpoint refuses a member-only change with the guard error', async () => {
  const w = await world([['g', { isGroup: true }], member('m0', 'todo'), member('m1', 'todo')])
  await writeCp(w, cp0('g', { members: { m0: { status: 'todo', at: ISO }, m1: { status: 'todo', at: ISO } } }))
  writeFileSync(w.paths.guards, '{"version":1,"checkpoints":{},"intents":{}}')
  const before = readFileSync(w.paths.tasks, 'utf8')
  await expect(w.tasks.upsertSubtask({ ...(await sub(w, 'm0')), status: 'done', done: true }, SESSION)).rejects.toMatchObject({ code: 'guards_unreadable' })
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
})

for (const applied of [false, true]) test(`r5 member-only crash recovery: board write applied=${applied}`, async () => {
  const w = await world([['g', { isGroup: true }], member('m0', 'in_progress'), member('m1', 'in_progress')])
  await writeCp(w, cp0('g', { phase: null, members: { m0: { status: 'in_progress', at: ISO }, m1: { status: 'in_progress', at: ISO } } }))
  await expect(guardedWrite({
    raised: [], memberChanges: [{ key: 'g', id: 'm0', status: 'done' }], ctx: SESSION,
    paths: w.paths, locks: ['tasks', 'deliveries', 'guards'], alreadyHeld: [], wiring: { now: () => T },
    recordOf: async () => null, stateOf: () => { throw new Error('no raised piece') },
    writeDocuments: async () => {
      if (applied) forgeBoard(w, s => s.id === 'm0', { status: 'done', done: true })
      throw new Error('simulated crash')
    },
  })).rejects.toThrow('simulated crash')
  expect((await w.guards.read()).intents.g).toBeDefined()
  const out = await w.svc.tick()
  expect(out.actions).toContain(`sweep-intent-${applied ? 'committed' : 'dropped'} g`)
  expect((await w.guards.read()).checkpoints.g!.members!.m0!.status).toBe(applied ? 'done' : 'in_progress')
  expect((await sub(w, 'm0')).status).toBe(applied ? 'done' : 'in_progress')
})

test('r5 partially repaired members never become accepted on a later quiet aggregate tick', async () => {
  const members = [member('m0', 'todo'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...members])
  const recorded = { m0: { status: 'todo', at: ISO }, m1: { status: 'todo', at: ISO } }
  await writeCp(w, cp0('g', { members: recorded }))
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  const real = w.tasks.applyBoardReverts.bind(w.tasks)
  w.tasks.applyBoardReverts = async () => {} // Simulate an ineffective old writer; derived rank remains inside rank 0.
  await w.svc.tick()
  expect((await w.guards.read()).checkpoints.g!.members).toEqual(recorded)
  w.tasks.applyBoardReverts = real
  await w.svc.tick()
  expect((await sub(w, 'm1')).status).toBe('blocked') // The second attempted repair is the loop guard.
  const bytes = readFileSync(w.paths.tasks, 'utf8')
  await w.svc.tick()
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(bytes)
})

test('r5 a guarded member change between repair chunks survives while the other eight forgeries are repaired', async () => {
  const members = Array.from({ length: 9 }, (_, i) => member(`f${i}`, 'todo'))
  const w = await world([['g', { isGroup: true }], ...members])
  await writeCp(w, cp0('g', { phase: null, members: Object.fromEntries(members.map(([id]) => [id, { status: 'todo', at: ISO }])) }))
  forgeBoard(w, s => s.id.startsWith('f'), { status: 'done', done: true })
  let envelopes = 0, id = 0
  const actions: string[] = []
  await guardSweep({
    rule: async () => 'on',
    envelope: async fn => {
      if (++envelopes === 2) await w.tasks.upsertSubtask({ ...(await sub(w, 'f8')), status: 'in_review', done: false }, SESSION)
      return withGuardEnvelope(w.paths, fn)
    },
    guards: w.guards as never, tasks: w.tasks as never, store: w.store as never,
    statusStages: () => w.tasks.statusStageMirror(), guard: flowContext(),
    ids: { comment: () => `race-c${id++}`, event: () => `race-e${id++}` },
    effective: subs => effectiveSubtasks(subs as never) as never, now: () => T,
  }, actions)
  expect(actions.filter(a => a.startsWith('sweep-revert'))).toHaveLength(8)
  expect((await sub(w, 'f8')).status).toBe('in_review')
  expect((await w.guards.read()).checkpoints.g!.members!.f8!.status).toBe('in_review')
  for (let i = 0; i < 8; i++) expect((await sub(w, `f${i}`)).status).toBe('todo')
  expect(sweepLines((await w.svc.tick()).actions)).toEqual([])
})

test('r5 real stores: 142 tasks, 2130 subtasks, 1550 checkpoints keep each envelope below two seconds', async () => {
  const w = await world([], 0)
  const book = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  book.tasks = Array.from({ length: 142 }, (_, i) => ({ id: `t${i}`, title: 'Synthetic lock benchmark task', status: 'in_progress', createdAt: ISO, updatedAt: ISO }))
  book.subtasks = []
  const checkpoints: Record<string, PieceCheckpoint> = {}
  for (let i = 0; i < 88; i++) {
    book.subtasks.push(subtask(`g${i}`, { isGroup: true }))
    const members: Record<string, { status: string; at: string }> = {}
    for (let j = 0; j < 23; j++) {
      const id = `g${i}-m${j}`
      book.subtasks.push(subtask(id, { parentGroupId: `g${i}`, status: i === 0 && j < 9 ? 'done' : 'todo' }))
      members[id] = { status: 'todo', at: ISO }
    }
    checkpoints[`g${i}`] = cp0(`g${i}`, { phase: null, ...(i === 0 ? { members } : {}) })
  }
  for (let i = 0; i < 18; i++) book.subtasks.push(subtask(`p${i}`))
  for (let i = 88; i < 1550; i++) checkpoints[`absent-${i}`] = cp0(`absent-${i}`, { phase: null })
  writeFileSync(w.paths.tasks, JSON.stringify(book))
  await w.guards.write({ ...(await w.guards.read()), checkpoints })
  let maxHold = 0, count = 0, id = 0
  const actions: string[] = []
  const durations: number[] = []
  for (let tick = 0; tick < 3; tick++) {
    const start = performance.now()
    await guardSweep({
      rule: async () => 'on',
      envelope: fn => withGuardEnvelope(w.paths, async () => {
        const started = performance.now()
        try { return await fn() } finally { maxHold = Math.max(maxHold, performance.now() - started); count++ }
      }),
      guards: w.guards as never, tasks: w.tasks as never, store: w.store as never,
      statusStages: () => w.tasks.statusStageMirror(), guard: flowContext(),
      ids: { comment: () => `bench-c${id++}`, event: () => `bench-e${id++}` },
      effective: subs => effectiveSubtasks(subs as never) as never, now: () => T,
    }, actions)
    durations.push(performance.now() - start)
  }
  console.log('R5_LOCK_BENCH', JSON.stringify({ tasks: book.tasks.length, subtasks: book.subtasks.length, checkpoints: Object.keys(checkpoints).length, durations, maxHold, envelopes: count }))
  expect(actions.filter(a => a.startsWith('sweep-revert'))).toHaveLength(9)
  expect(Object.values((await w.guards.read()).checkpoints).filter(c => c.members)).toHaveLength(88)
  expect(maxHold).toBeLessThan(2000)
}, 60_000)
