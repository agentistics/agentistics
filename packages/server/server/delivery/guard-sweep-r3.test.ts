/** QA S2b r2 (Opus): adversarial probes on the r2 sweep — harness copied from guard-sweep-r2.test.ts. A (fail) is a finding. */
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
import { planSweep, sweepWarnings } from './sweep-plan'
import { forbiddenCapabilities } from './guard-ast.testing'
import { analyzeGuardIntegrity } from './owner-health'
import { flowContext } from './guard'
import { guardSweep } from './sweep'
import { inGuardTransaction } from './guard-transaction'
import { unattributedContext } from './guard'

const T = Date.parse('2026-11-13T10:00:00Z')
const ISO = new Date(T).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: new Date(now).toISOString(), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true),
  def('in_review', 'In review', 'leader', 4), def('pr_merge', 'PR merge', 'merge', 5), def('ci', 'CI', 'ci', 6)]
const subtask = (id: string, extra: Record<string, unknown> = {}) => ({ id, taskId: 't1', title: id, done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO, ...extra }) as never

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'qa-s2b-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function world(rule: 'off' | 'shadow' | 'on', subs: Array<[string, Record<string, unknown>?]> = [['p1']], migrated = true) {
  const clock = { now: T }
  const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
  const sessions = [{ id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: '/nowhere', harness: 'claude', worktree: false }]
  const deps = { sessions: async () => sessions, git: execGit }
  const tasks: TaskStore = createTaskStore(paths.tasks, { guard: { deps, now: () => clock.now } })
  await tasks.seedStatuses(DEFS)
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  for (const [id, extra] of subs) await tasks.upsertSubtask(subtask(id, extra), unattributedContext())
  for (let i = 0; i < 40; i++) await tasks.upsertTask({ id: `quiet-${i}`, title: 'quiet', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  const store = createDeliveryStore(paths.deliveries, { guard: { deps, now: () => clock.now } })
  const board: any = { comment: async () => undefined, subtaskFinished: async () => false, setPhaseStatus: async () => ({ ok: true }) }
  const logs: string[] = []
  const svc = createDeliveryService({
    store,
    facts: { subtask: async (id: string) => ({ id, taskId: 't1', title: id, status: 'in_progress', groupMember: false, blockedBy: [] }), sessions: async () => sessions, blockedSubtasks: async () => [] } as never,
    board,
    notify: { session: async (_id: string, text: string) => { logs.push(`notice:${text}`, `notice-held:${inGuardTransaction(paths)}`); return true }, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => clock.now,
    classify: { sessions: async () => sessions, git: execGit },
    guardsPath: paths.guards, autoReconcile: () => false, log: (line: string) => logs.push(line),
    sweep: { tasks: async () => tasks, paths },
  } as never) as any
  if (rule !== 'off') {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    expect(await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })).toEqual({ ok: true })
    if (rule === 'on') expect(await g.setState('a', 'on', { check, facts: facts(T) })).toEqual({ ok: true })
    if (migrated) {
      const guards = createGuardsStore(paths.guards)
      await guards.write({ ...(await guards.read()), migrations: { a: { version: 1, at: ISO } } })
    }
  }
  return { svc, tasks, store, guards: createGuardsStore(paths.guards), clock, paths, board, logs }
}
type W = Awaited<ReturnType<typeof world>>
const cp = (key: string, o: Partial<PieceCheckpoint> = {}): PieceCheckpoint => ({
  key, rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', revision: 2, headSha: null,
  auth: [{ kind: 'evidence', ids: ['e1'], sha256: ['aa'] }], by: { kind: 'flow', engine: 'entrega' }, at: ISO, transitionId: `tr-${key}`, ...o,
} as PieceCheckpoint)
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
const GROUP: Array<[string, Record<string, unknown>?]> = [['g', { isGroup: true }], ['m1', { parentGroupId: 'g' }], ['m2', { parentGroupId: 'g' }]]
const gcp0 = () => cp('g', { rank: 0, phase: 'executando', boardStatus: 'in_progress', boardStage: 'running', auth: [{ kind: 'grandfathered', at: ISO }] as never })
const comments = async (w: W, id: string) => (await w.tasks.read()).comments.filter(c => c.subtaskId === id).length

for (const [label, ctx] of [['owner', OWNER], ['session', SESSION], ['flow', flowContext()]] as const) {
  for (const withCp of [true, false]) {
    test(`R2-M1 (${label}, group checkpoint ${withCp ? 'rank 0' : 'absent'}) a LEGIT member move the guard ACCEPTS (m1 done, group stays open) is not reverted`, async () => {
      const w = await world('on', GROUP)
      if (withCp) await writeCp(w, gcp0())
      forgeDelivery(w, 'g', record('g', 'executando'))
      let accepted = true
      try { await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'done', done: true }, ctx) } catch (e) { accepted = false; console.log('refused', String(e).slice(0, 200)) }
      const t1 = await w.svc.tick(); w.clock.now += 60_000
      const after1 = (await sub(w, 'm1')).status
      const quiet = await w.svc.tick(); w.clock.now += 60_000
      // the worker (or the owner) marks it done again, as anyone would after seeing it undone
      try { await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'done', done: true }, ctx) } catch {}
      const t2 = await w.svc.tick()
      console.log(`R2-M1 ${label} cp=${withCp}`, JSON.stringify({ accepted, t1: sweepLines(t1.actions), after1, quiet: sweepLines(quiet.actions), t2: sweepLines(t2.actions), m1: (await sub(w, 'm1')).status, blockedReason: (await sub(w, 'm1')).blockedReason ?? null, gPhase: (await w.store.get('g'))!.phase, comments: await comments(w, 'm1') }))
      expect(accepted).toBe(true)
      expect(sweepLines(t1.actions).join(' ')).not.toContain('sweep-revert')
      expect(after1).toBe('done')
      expect((await w.store.get('g'))!.phase).not.toBe('bloqueado')
    })
  }
}

test('R2-M2 (owner) member moved to in_review while the group checkpoint is rank 0: kept', async () => {
  const w = await world('on', GROUP)
  await writeCp(w, gcp0())
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'in_review' }, OWNER)
  const t1 = await w.svc.tick()
  console.log('R2-M2', JSON.stringify({ t1: sweepLines(t1.actions), m1: (await sub(w, 'm1')).status }))
  expect((await sub(w, 'm1')).status).toBe('in_review')
})

for (const [label, ctx] of [['owner', OWNER], ['session', SESSION]] as const) {
  test(`R2-K2 (${label}) drags the card back (in_review → in_progress) while the delivery stays in revisao_lider: no "unknown writer" revert of the delivery`, async () => {
    const w = await world('on')
    await writeCp(w, cp('p1'))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    forgeBoard(w, s => s.id === 'p1', { status: 'in_review' })
    const ctl = await w.svc.tick(); w.clock.now += 60_000
    let accepted = true
    try { await w.tasks.upsertSubtask({ ...(await sub(w, 'p1')), status: 'in_progress' }, ctx) } catch (e) { accepted = false; console.log('refused', String(e).slice(0, 200)) }
    const c = (await w.guards.read()).checkpoints.p1!
    expect(c.phase).toBe('revisao_lider')
    expect(c.rank).toBe(1)
    if (label === 'owner') {
      expect(c.auth.some(a => a.kind === 'owner')).toBe(true)
      expect((c.by as any).kind).toBe('owner')
    }
    const out = await w.svc.tick()
    const rec = (await w.store.get('p1'))!
    console.log(`R2-K2 ${label}`, JSON.stringify({ accepted, control: sweepLines(ctl.actions), cpAfterRetreat: { rank: c.rank, phase: c.phase, boardStatus: c.boardStatus }, sweep: sweepLines(out.actions), board: (await sub(w, 'p1')).status, phase: rec.phase, revision: rec.revision, comments: await comments(w, 'p1') }))
    expect(sweepLines(ctl.actions)).toEqual([])
    expect(sweepLines(out.actions).join(' ')).not.toContain('sweep-revert')
    expect(rec.phase).toBe('revisao_lider')
  })
}

test('R2-B1 the no_checkpoint breaker trips: health (sweepWarnings + the migration line) must WARN, not only a log line', async () => {
  const w = await world('on')
  for (const id of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']) await w.tasks.upsertSubtask(subtask(id), unattributedContext())
  forgeBoard(w, s => ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].includes(s.id), { status: 'in_review' })
  const out = await w.svc.tick()
  const doc = await w.guards.read()
  const warns = sweepWarnings(doc.sweep, w.clock.now)
  console.log('R2-B1', JSON.stringify({ sweep: sweepLines(out.actions), logs: w.logs.filter(l => l.includes('breaker')), warns }))
  expect(sweepLines(out.actions)).toContain('sweep-skipped: no_checkpoint_breaker')
  expect(warns.join(' ')).toContain('breaker')
})

test('R2-B2 the breaker skips the WHOLE sweep: a real forged piece WITH a checkpoint is left forged while >20 unrelated pieces lack one', async () => {
  const w = await world('on')
  await writeCp(w, cp('p1'))
  forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
  forgeBoard(w, s => s.id === 'p1', { status: 'in_review' })
  expect(sweepLines((await w.svc.tick()).actions)).toEqual([])
  const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  raw.tasks = raw.tasks.map((t: any) => (t.id.startsWith('quiet-') && Number(t.id.slice(6)) < 21 ? { ...t, status: 'in_review' } : t))
  writeFileSync(w.paths.tasks, JSON.stringify(raw))
  forgeBoard(w, s => s.id === 'p1', { status: 'done' }); forgeDelivery(w, 'p1', { phase: 'publicado' })
  const out = await w.svc.tick()
  console.log('R2-B2', JSON.stringify({ sweep: sweepLines(out.actions), p1: (await sub(w, 'p1')).status, phase: (await w.store.get('p1'))!.phase }))
  // documents the design: report-only means even checkpointed forgeries stay. Not asserted as a failure.
})

test('R2-I1 report-only ticks never recover a pending intent (migration missing)', async () => {
  const w = await world('on', [['p1']], false)
  const { beginIntent } = await import('./guards-store')
  const doc = await w.guards.read()
  await w.guards.write(beginIntent(doc, cp('p1', { rank: 0, phase: null, boardStatus: 'in_progress', boardStage: 'running' }), ISO))
  const out = await w.svc.tick()
  console.log('R2-I1', JSON.stringify({ sweep: sweepLines(out.actions), intents: Object.keys((await w.guards.read()).intents) }))
})

test('R2-S1 safety-net memory survives only while the plan repeats: legit-looking member re-forged after a quiet tick counts as a 2nd revert', async () => {
  const w = await world('on', GROUP)
  await writeCp(w, cp('g', { rank: 1, auth: [{ kind: 'grandfathered', at: ISO }] as never }))
  forgeDelivery(w, 'g', record('g', 'revisao_lider'))
  forgeBoard(w, s => !!s.parentGroupId, { status: 'in_review' })
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  const t1 = await w.svc.tick(); w.clock.now += 60_000
  const t2 = await w.svc.tick(); w.clock.now += 60_000
  console.log('R2-S1', JSON.stringify({ t1: sweepLines(t1.actions), t2: sweepLines(t2.actions), m1: (await sub(w, 'm1')).status, plans: (await w.guards.read()).sweep?.plans ?? null }))
})

test('R2-3 breaker has its own bilingual health warning and one deduped leader notice', async () => {
  const w = await world('on')
  for (let i = 0; i < 6; i++) await w.tasks.upsertSubtask(subtask(`x${i}`), unattributedContext())
  forgeBoard(w, s => s.id.startsWith('x'), { status: 'done' })
  await w.svc.tick(); await w.svc.tick()
  const warnings = sweepWarnings((await w.guards.read()).sweep, T)
  const issues: any[] = []
  analyzeGuardIntegrity({ offWarnings: warnings }, issues)
  expect(issues.find(i => i.id === 'sweep-breaker')?.guide).not.toContain('guarantee off') // r3: per-kind guide, never "turn the guard off"
  expect(warnings.join(' ')).toContain('varredura')
  expect(w.logs.filter(l => l.startsWith('notice:') && l.includes('breaker'))).toHaveLength(1)
  expect(w.logs).not.toContain('notice-held:true')
  expect(w.logs.filter(l => l.includes('[guard] WARN') && l.includes('breaker'))).toHaveLength(1)
  forgeBoard(w, s => s.id.startsWith('x'), { status: 'in_progress' })
  await w.svc.tick()
  expect(sweepWarnings((await w.guards.read()).sweep, T)).toEqual([])
})

// R3-2 (r4) supersedes R2-4: the breaker judges only reverts with NO checkpoint; checkpointed ones are always repaired.
test('R2-4/R3-2 checkpointed forgeries are repaired, never counted by the no_checkpoint breaker', async () => {
  const w = await world('on')
  for (let i = 0; i < 3; i++) {
    const key = `x${i}`
    await w.tasks.upsertSubtask(subtask(key), unattributedContext())
    await writeCp(w, cp(key, { rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: null, auth: [] }))
  }
  forgeBoard(w, s => s.id.startsWith('x'), { status: 'done' })
  const out = await w.svc.tick()
  expect(out.actions.join(' ')).not.toContain('breaker')
  expect(out.actions.filter((a: string) => a.startsWith('sweep-revert'))).toHaveLength(3)
  expect((await sub(w, 'x0')).status).toBe('in_progress')
})

test('R2-6 leaving blocked clears the reason on a normal member write and a sweep repair', async () => {
  const w = await world('on', GROUP)
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'blocked', blockedReason: 'externo: old' }, unattributedContext())
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), status: 'in_progress' }, OWNER)
  expect((await sub(w, 'm1')).blockedReason).toBeUndefined()
  forgeBoard(w, s => s.id === 'm1', { blockedReason: 'externo: old' })
  await w.tasks.applyBoardReverts({ at: ISO, reverts: [{ key: 'm1', subtaskId: 'm1', to: 'in_progress', clearCi: false }], comments: [], events: [] })
  expect((await sub(w, 'm1')).blockedReason).toBeUndefined()
})

for (const src of [
  "const { get } = Reflect; get(f, 'constructor')",
  "Reflect.apply(Reflect.get, null, [f, 'constructor'])",
  '[{ constructor: C }] = [f]',
  'for ({ constructor: C } of [f]);',
]) test(`R2-7 refuses ${src}`, () => { expect(forbiddenCapabilities(src).length).toBeGreaterThan(0) })
test('R2-7 legitimate constructor controls stay clean', () => {
  for (const src of ['x.constructor.name', 'x.constructor === Map', 'x.constructor !== Object', 'class A { constructor() {} }']) expect(forbiddenCapabilities(src)).toEqual([])
})

test('R2-1 faithful migration of 122 advanced members in 15 open groups has zero first-tick reverts', async () => {
  const subs: Array<[string, Record<string, unknown>?]> = []
  for (let g = 0; g < 15; g++) {
    subs.push([`g${g}`, { isGroup: true }], [`open${g}`, { parentGroupId: `g${g}` }])
  }
  for (let i = 0; i < 122; i++) subs.push([`m${i}`, { parentGroupId: `g${i % 15}`, status: i < 114 ? 'done' : 'in_review', done: i < 114 }])
  const w = await world('on', subs)
  for (let g = 0; g < 15; g++) await writeCp(w, { ...gcp0(), key: `g${g}` })
  const before = readFileSync(w.paths.tasks, 'utf8')
  const out = await w.svc.tick()
  expect(out.actions.filter((a: string) => a.startsWith('sweep-revert'))).toEqual([])
  expect(out.actions.join(' ')).not.toContain('breaker')
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
})

test('R2-8 N10 a new revision cannot inherit the old catch-up authorization', async () => {
  const w = await world('on')
  await writeCp(w, cp('p1', { revision: 2 }))
  forgeDelivery(w, 'p1', record('p1', 'revisao_lider', { revision: 3, evidence: [] }))
  const tasks = createTaskStore(w.paths.tasks, { guard: { deps: {
    sessions: async () => [{ id: 'worker', taskId: 't1', subtaskId: 'p1', cwd: '/r3-revision-control' }],
    git: async (_cwd, args) => args.includes('--show-toplevel') ? '/r3-revision-control' : args[0] === 'status' || args[0] === 'diff' ? '' : 'a'.repeat(40),
  } } })
  await expect(tasks.upsertSubtask({ ...(await sub(w, 'p1')), status: 'in_review' }, flowContext())).rejects.toMatchObject({ code: 'evidence_required' })
  expect((await sub(w, 'p1')).status).toBe('in_progress')
})

test('R2-5 planning and slow catch-up run outside bounded lock chunks; changed pieces are skipped', async () => {
  let held = false, readsOutside = 0, batches = 0, maxHold = 0
  const statuses = DEFS
  let doc: any = { checkpoints: { p1: cp('p1') }, intents: {}, migrations: { a: { version: 1, at: ISO } } }
  const book: any = { statuses, tasks: Array.from({ length: 400 }, (_, i) => ({ id: `q${i}`, status: 'in_progress' })), subtasks: [subtask('p1'), ...Array.from({ length: 12 }, (_, i) => subtask(`x${i}`, { status: 'done' }))] }
  let changed = false
  const actions: string[] = []
  await guardSweep({
    rule: async () => 'on',
    envelope: async fn => {
      expect(readsOutside).toBeGreaterThan(0)
      // An accepted concurrent write after the snapshot must survive the sweep's apply.
      if (!changed) { book.subtasks.find((s: any) => s.id === 'x0').status = 'in_progress'; changed = true }
      held = true; const start = performance.now()
      try { return await fn() } finally { maxHold = Math.max(maxHold, performance.now() - start); held = false }
    },
    guards: { read: async () => doc, write: async d => { doc = d } },
    tasks: { read: async () => { if (!held) readsOutside++; return structuredClone(book) }, applyBoardReverts: async b => {
      expect(held).toBe(true); expect(b.reverts.length).toBeLessThanOrEqual(4); batches++
      for (const r of b.reverts) book.subtasks.find((s: any) => s.id === r.key).status = r.to
    } },
    store: { read: async () => ({ deliveries: { p1: record('p1', 'revisao_lider') } }), update: async () => undefined },
    statusStages: async () => undefined, guard: flowContext(), ids: { comment: () => 'c', event: () => 'e' }, effective: s => s, now: () => T,
    catchUp: async (_key, _phase, unchanged) => { expect(held).toBe(false); expect(await unchanged()).toBe(true); await Bun.sleep(50); return { ok: true } },
  }, actions)
  expect(readsOutside).toBeGreaterThan(0)
  expect(batches).toBeGreaterThanOrEqual(3)
  expect(actions.join(' ')).not.toContain('sweep-revert x0:')
  expect(book.subtasks.find((s: any) => s.id === 'x0').status).toBe('in_progress')
  console.log(`R2-5 measured max mock envelope hold: ${maxHold.toFixed(1)} ms`)
  expect(maxHold).toBeLessThan(2000)
})

test('R2-5 the real service tick releases its envelope before waking a loop-blocked piece leader', async () => {
  const w = await world('on')
  forgeDelivery(w, 'p1', record('p1', 'executando'))
  for (let i = 0; i < 2; i++) {
    forgeBoard(w, s => s.id === 'p1', { status: 'in_review' })
    await w.svc.tick(); w.clock.now += 60_000
  }
  expect(w.logs.some(l => l.startsWith('notice:'))).toBe(true)
  expect(w.logs).not.toContain('notice-held:true')
})
