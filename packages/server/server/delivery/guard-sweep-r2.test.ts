/**
 * QA S2b (Opus): adversarial probes of the guard sweep on the REAL stores + the real service tick (the author's harness, copied).
 * Each test LOGS what happened; the expectations state what a correct sweep must do, so a (fail) here is a finding.
 */
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
    notify: { session: async () => true, owner: async () => undefined } as never,
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

test('G1 forged GROUP MEMBERS (derived group status): the sweep must repair it or stay quiet, never loop forever', async () => {
  const w = await world('on', [['g', { isGroup: true }], ['m1', { parentGroupId: 'g' }], ['m2', { parentGroupId: 'g' }]])
  await writeCp(w, cp('g', { rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: null, auth: [{ kind: 'grandfathered', at: ISO }] }))
  await w.svc.tick() // Establish the old-store member baseline before simulating a raw writer.
  forgeBoard(w, s => s.parentGroupId === 'g', { status: 'done', done: true }) // an older binary finishing both members
  const per: unknown[] = []
  for (let i = 0; i < 5; i++) {
    const out = await w.svc.tick()
    const book = await w.tasks.read()
    per.push({ tick: i, sweep: sweepLines(out.actions), g: (await sub(w, 'g')).status, members: book.subtasks.filter(s => (s as any).parentGroupId === 'g').map(s => s.status), comments: book.comments.filter(c => c.subtaskId === 'g').length })
    w.clock.now += 60_000
  }
  console.log('G1', JSON.stringify(per))
  const last = per.at(-1) as any
  expect((per[2] as any).sweep).toEqual([])
  expect((await w.tasks.read()).subtasks.filter(s => s.parentGroupId === 'g').map(s => s.status)).toEqual(['in_progress', 'in_progress'])
  expect(last.sweep).toEqual([])          // quiet by the 5th tick
  expect(last.comments).toBeLessThanOrEqual(2)
})

test('C1 crash mid-sweep (deliveries reverted, board write throws once): no false loop block, both repaired next tick', async () => {
  const w = await world('on')
  forgeDelivery(w, 'p1', record('p1', 'executando'))
  forgeBoard(w, s => s.id === 'p1', { status: 'in_review' }); forgeDelivery(w, 'p1', { phase: 'revisao_lider' })
  const real = w.tasks.applyBoardReverts.bind(w.tasks)
  let crash = true
  ;(w.tasks as any).applyBoardReverts = async (b: any) => { if (crash) { crash = false; throw new Error('crash between the two documents') } return real(b) }
  const t1 = await w.svc.tick()
  const mid = { board: (await sub(w, 'p1')).status, phase: (await w.store.get('p1'))!.phase, memory: (await w.guards.read()).sweep }
  w.clock.now += 60_000
  const t2 = await w.svc.tick()
  const after = { board: (await sub(w, 'p1')).status, phase: (await w.store.get('p1'))!.phase, memory: (await w.guards.read()).sweep }
  console.log('C1', JSON.stringify({ t1: sweepLines(t1.actions), mid, t2: sweepLines(t2.actions), after }))
  expect(after.board).toBe('in_progress')
  expect(after.phase).toBe('executando')
  expect(sweepLines(t2.actions).join(' ')).not.toContain('loop')
})

test('S1 SHADOW: the sweep writes nothing — tasks.json and guards.json bytes identical across a tick with a forged piece', async () => {
  const w = await world('shadow')
  forgeBoard(w, s => s.id === 'p1', { status: 'in_review' })
  const before = { t: readFileSync(w.paths.tasks, 'utf8'), g: readFileSync(w.paths.guards, 'utf8') }
  const out = await w.svc.tick()
  const same = { tasks: readFileSync(w.paths.tasks, 'utf8') === before.t, guards: readFileSync(w.paths.guards, 'utf8') === before.g }
  console.log('S1', JSON.stringify({ sweep: sweepLines(out.actions), same }))
  expect(same).toEqual({ tasks: true, guards: true })
})

test('O1 a move MADE BY THE OWNER (by.kind owner, auth evidence) whose evidence later goes stale: reverted? (spec §3.5.15 vi: no)', async () => {
  const w = await world('on')
  await writeCp(w, cp('p1', { by: { kind: 'owner', via: 'legacy-browser' } as never }))
  forgeDelivery(w, 'p1', record('p1', 'revisao_lider', { evidence: [] }))
  forgeBoard(w, s => s.id === 'p1', { status: 'in_review' })
  const out = await w.svc.tick()
  console.log('O1', JSON.stringify({ sweep: sweepLines(out.actions), board: (await sub(w, 'p1')).status, phase: (await w.store.get('p1'))!.phase }))
  expect(sweepLines(out.actions).join(' ')).not.toContain('sweep-revert')
})

test('K1 the checkpoint rank is the HIGHEST ever authorized: after a legit retreat + new review, a raw jump back to ci is not reverted', async () => {
  const w = await world('on')
  // reached ci once (rank 3), went back to ajuste (rev 3), came back to review with fresh evidence at rev 4: guard-host keeps rank max(1, 3) = 3
  await writeCp(w, cp('p1', { rank: 3, boardStatus: 'in_review', phase: 'revisao_lider', revision: 4, auth: [{ kind: 'evidence', ids: ['e2'], sha256: ['bb'] }] }))
  const hist = [{ from: 'fila', to: 'executando', at: ISO, actor: 'flow:entrega', revision: 1 }, { from: 'ci', to: 'ajuste', at: ISO, actor: 'flow:entrega', revision: 3 }, { from: 'qa', to: 'revisao_lider', at: ISO, actor: 'flow:entrega', revision: 4 }]
  forgeDelivery(w, 'p1', record('p1', 'revisao_lider', { revision: 4, history: hist, evidence: [{ id: 'e2', sha256: 'bb', revision: 3 }] }))
  forgeBoard(w, s => s.id === 'p1', { status: 'in_review' })
  const control = await w.svc.tick()
  forgeBoard(w, s => s.id === 'p1', { status: 'ci' }); forgeDelivery(w, 'p1', { phase: 'ci' }) // the forge
  w.clock.now += 60_000
  const out = await w.svc.tick()
  console.log('K1', JSON.stringify({ control: sweepLines(control.actions), sweep: sweepLines(out.actions), board: (await sub(w, 'p1')).status, phase: (await w.store.get('p1'))!.phase }))
  expect((await w.store.get('p1'))!.phase).toBe('revisao_lider')
})

test('B1 the loop guard writes `blocked` with no blockedReason (the board rule blocked_needs_reason is bypassed)', async () => {
  const w = await world('on')
  for (let i = 0; i < 2; i++) { forgeBoard(w, s => s.id === 'p1', { status: 'in_review' }); await w.svc.tick(); w.clock.now += 3600_000 }
  const s = await sub(w, 'p1')
  console.log('B1', JSON.stringify({ status: s.status, blockedReason: s.blockedReason ?? null, blockedBy: s.blockedBy ?? null }))
  expect(s.status).toBe('blocked')
  expect(typeof s.blockedReason).toBe('string')
  expect(s.blockedReason).toBe('externo: an unknown writer keeps moving this piece')
})

test('S2B-7 Reflect.get and assignment destructuring constructor escapes are refused; controls stay clean', () => {
  for (const src of ["Reflect.get(x, 'constructor')('x')", "Reflect['get'](x, `constructor`)", "const key = 'constructor'; Reflect.get(x, key)", "Reflect.get(x, 'con' + 'structor')", "({ constructor: C } = x)", "({ ['constructor']: C } = x)"]) expect(forbiddenCapabilities(src).length, src).toBeGreaterThan(0)
  for (const src of ['x.constructor.name', 'x.constructor === Map', 'x.constructor !== Object', 'class C { constructor() {} }', "Reflect.get(x, 'size')"]) expect(forbiddenCapabilities(src), src).toEqual([])
  // r5: a runtime proxy key cannot prove that it excludes 'constructor'.
  expect(forbiddenCapabilities('new Proxy(x, { get(target, prop) { return Reflect.get(target, prop, target) } })')).toContain('reflect-indirect')
})

const piece = (extra = {}) => ({ key: 'p1', taskId: 't1', subtaskId: 'p1', boardStatus: 'in_review', boardRank: 1, ciRank: 0, record: record('p1', 'revisao_lider'), ...extra })
const plan = (pieces: any[], checkpoints: any = { p1: cp('p1') }, memory: any = { reverts: {} }, statuses = DEFS) => planSweep({ pieces, checkpoints, memory, statuses, now: T })
test('Q2 override exemption survives stale evidence and raw rank increases', () => {
  for (const via of ['legacy-browser', 'vault-credential'] as const) expect(plan([piece({ boardRank: 3, record: record('p1', 'ci', { evidence: [] }) })], { p1: cp('p1', { auth: [{ kind: 'override', via, reason: 'approved' }] }) }).reverts).toEqual([])
})
test('Q3 short SHA prefix HEAD is the same authorized commit', () => {
  expect(plan([piece({ record: record('p1', 'revisao_lider', { headSha: 'abcdef1234567' }) })], { p1: cp('p1', { headSha: 'abcdef1' }) }).reverts).toEqual([])
})
test('Q4 record-only piece without a board entry is still judged', async () => {
  const w = await world('on')
  await writeCp(w, cp('orphan', { rank: 0, phase: 'executando', boardStatus: '', auth: [] }))
  forgeDelivery(w, 'orphan', record('orphan', 'ci'))
  await w.svc.tick()
  expect((await w.store.get('orphan'))!.phase).toBe('executando')
})
test('Q5 checkpoint custom board status wins over another status at the same rank', () => {
  const statuses = [...DEFS, def('custom-review', 'Review', 'leader', 9)]
  expect(plan([piece({ boardRank: 3 })], { p1: cp('p1', { boardStatus: 'custom-review' }) }, undefined, statuses).reverts[0]!.board!.to).toBe('custom-review')
})
test('Q7 quiet tick prunes expired loop memory durably', async () => {
  const w = await world('on')
  await w.guards.write({ ...(await w.guards.read()), sweep: { reverts: { vanished: [new Date(T - 25 * 3600_000).toISOString()] } } })
  await w.svc.tick()
  expect((await w.guards.read()).sweep!.reverts).toEqual({})
})
test('S2B-5 health has one sweep-loop WARN, full ids, own EN/PT sentence and off guide', () => {
  const ids = ['s-full-piece-111111', 's-full-piece-222222']
  const issues: any[] = []
  analyzeGuardIntegrity({ offWarnings: sweepWarnings({ reverts: Object.fromEntries(ids.map(id => [id, [ISO, ISO]])) }, T) }, issues)
  expect(issues).toHaveLength(1)
  expect(issues[0].id).toBe('sweep-loop')
  for (const id of ids) expect(issues[0].description).toContain(id)
  expect(issues[0].description).not.toContain('owner turned')
  expect(issues[0].description).toContain('escritor desconhecido')
  expect(issues[0].guide).not.toContain('guarantee off') // r3: per-kind guide
})
test('S2B-4 migration missing makes ON report-only even with caller activation facts', async () => {
  const w = await world('on', [['p1']], false)
  forgeBoard(w, s => s.id === 'p1', { status: 'done', deliveredAt: ISO })
  const before = readFileSync(w.paths.tasks, 'utf8')
  const out = await w.svc.tick()
  expect(out.actions).toContain('sweep-skipped: migration_missing')
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
})

test('S2B-2 authorized delivery retreat lowers its durable checkpoint before a raw jump', async () => {
  const w = await world('on')
  await writeCp(w, cp('p1', { rank: 3, phase: 'ci', boardStatus: 'ci', boardStage: 'ci' }))
  forgeDelivery(w, 'p1', record('p1', 'ci'))
  await w.store.update(doc => { const r = doc.deliveries.p1!; r.phase = 'revisao_lider'; r.revision++; r.history.push({ from: 'ci', to: 'revisao_lider', revision: r.revision, at: ISO, actor: 'flow:entrega', detail: 'authorized retreat' }) }, { guard: flowContext() })
  expect((await w.guards.read()).checkpoints.p1!.rank).toBe(1)
  forgeDelivery(w, 'p1', { phase: 'ci' })
  await w.svc.tick()
  expect((await w.store.get('p1'))!.phase).toBe('revisao_lider')
})

test('S2B-2 authorized board retreat lowers its checkpoint too', async () => {
  const w = await world('on')
  await writeCp(w, cp('p1', { rank: 3, phase: null, boardStatus: 'ci', boardStage: 'ci' }))
  forgeBoard(w, s => s.id === 'p1', { status: 'ci' })
  await w.tasks.upsertSubtask({ ...(await sub(w, 'p1')), status: 'in_review' }, flowContext())
  expect((await w.guards.read()).checkpoints.p1!.rank).toBe(1)
  forgeBoard(w, s => s.id === 'p1', { status: 'ci' })
  await w.svc.tick()
  expect((await sub(w, 'p1')).status).toBe('in_review')
})

test('S2B-5 Q1 board-only second revert blocks the existing record too', async () => {
  const w = await world('on')
  forgeDelivery(w, 'p1', record('p1', 'executando'))
  for (let i = 0; i < 2; i++) { forgeBoard(w, s => s.id === 'p1', { status: 'in_review' }); await w.svc.tick(); w.clock.now += 60_000 }
  expect((await w.store.get('p1'))!.phase).toBe('bloqueado')
  expect((await sub(w, 'p1')).blockedReason).toBe('externo: an unknown writer keeps moving this piece')
})

test('S2B-4 breaker rejects over five percent and over twenty missing checkpoints; boundary is allowed', async () => {
  const w = await world('on') // More than five candidates AND over 5% trips the percentage breaker.
  const forge = (count: number) => {
    const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
    raw.tasks = raw.tasks.map((t: any, i: number) => i > 0 ? { ...t, status: i <= count ? 'done' : 'in_progress' } : t)
    writeFileSync(w.paths.tasks, JSON.stringify(raw))
  }
  forge(6)
  const before = readFileSync(w.paths.tasks, 'utf8')
  expect((await w.svc.tick()).actions).toContain('sweep-skipped: no_checkpoint_breaker')
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
  expect((await w.guards.read()).sweep?.warning).toContain('sweep-breaker:')
  forge(21)
  expect((await w.svc.tick()).actions).toContain('sweep-skipped: no_checkpoint_breaker')
  forge(0); forge(2)
  expect((await w.svc.tick()).actions.join(' ')).toContain('sweep-revert')
})

test('S2B-4 reverting a delivered piece preserves the timestamp and records it in the event', async () => {
  const w = await world('on')
  forgeBoard(w, s => s.id === 'p1', { status: 'done', done: true, deliveredAt: ISO })
  await w.svc.tick()
  expect((await sub(w, 'p1')).deliveredAt).toBe(ISO)
  expect((await w.tasks.read()).events.find(e => e.actor === 'flow:sweep')!.detail).toContain(ISO)
})

test('S2B-4 breaker absolute limit applies below five percent; twenty at exactly five percent is allowed', async () => {
  const w = await world('on')
  const book = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  book.tasks = [book.tasks[0], ...Array.from({ length: 499 }, (_, i) => ({ id: `bulk-${i}`, title: 'bulk', status: i < 21 ? 'done' : 'in_progress', createdAt: ISO, updatedAt: ISO }))]
  writeFileSync(w.paths.tasks, JSON.stringify(book))
  const before = readFileSync(w.paths.tasks, 'utf8')
  expect((await w.svc.tick()).actions).toContain('sweep-skipped: no_checkpoint_breaker')
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
  book.tasks = book.tasks.slice(0, 400)
  book.tasks[21].status = 'in_progress'
  writeFileSync(w.paths.tasks, JSON.stringify(book))
  const out = await w.svc.tick()
  expect(out.actions.filter((l: string) => l.startsWith('sweep-revert'))).toHaveLength(20)
})

test('G1 legitimate members share the group evidence and are not judged as recordless', async () => {
  const w = await world('on', [['g', { isGroup: true }], ['m1', { parentGroupId: 'g' }], ['m2', { parentGroupId: 'g' }]])
  await writeCp(w, cp('g'))
  forgeDelivery(w, 'g', record('g', 'revisao_lider'))
  forgeBoard(w, s => !!s.parentGroupId, { status: 'in_review' })
  const out = await w.svc.tick()
  expect(out.actions.join(' ')).not.toContain('sweep-revert')
  expect((await sub(w, 'm1')).status).toBe('in_review')
  expect(sweepLines((await w.svc.tick()).actions)).toEqual([])
})

test('G1 board-only member loops block their shared group record once', async () => {
  const w = await world('on', [['g', { isGroup: true }], ['m1', { parentGroupId: 'g' }], ['m2', { parentGroupId: 'g' }]])
  await writeCp(w, cp('g', { rank: 0, phase: 'executando', boardStatus: 'in_progress', auth: [] }))
  forgeDelivery(w, 'g', record('g', 'executando'))
  await w.svc.tick() // Establish accepted members before the two raw forgeries.
  for (let i = 0; i < 2; i++) { forgeBoard(w, s => !!s.parentGroupId, { status: 'done' }); await w.svc.tick(); w.clock.now += 60_000 }
  expect((await w.store.get('g'))!.phase).toBe('bloqueado')
  expect((await w.store.get('g'))!.history.filter(h => h.actor === 'flow:sweep' && h.to === 'bloqueado')).toHaveLength(1)
  expect((await sub(w, 'm1')).status).toBe('blocked')
  const before = readFileSync(w.paths.tasks, 'utf8')
  await w.svc.tick()
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
})

test('G1 catch-up repairs stored members once instead of repeating a derived group write', async () => {
  const w = await world('on', [['g', { isGroup: true }], ['m1', { parentGroupId: 'g' }], ['m2', { parentGroupId: 'g' }]])
  await writeCp(w, cp('g'))
  forgeDelivery(w, 'g', record('g', 'revisao_lider'))
  w.board.setPhaseStatus = async (key: string) => { await w.tasks.upsertSubtask({ ...(await sub(w, key)), status: 'in_review' }, flowContext()); return { ok: true } }
  const first = await w.svc.tick()
  expect(first.actions.filter((l: string) => l.startsWith('sweep-catch-up'))).toHaveLength(2)
  expect((await sub(w, 'm1')).status).toBe('in_review')
  expect(sweepLines((await w.svc.tick()).actions)).toEqual([])
})

test('S1 SHADOW intent recovery is report-only, including guards bytes', async () => {
  const w = await world('shadow')
  const target = cp('p1', { rank: 0, phase: null, boardStatus: 'in_progress' })
  await w.guards.write({ ...(await w.guards.read()), intents: { p1: { transitionId: target.transitionId, target, at: ISO } } })
  const before = readFileSync(w.paths.guards, 'utf8')
  await w.svc.tick()
  expect(readFileSync(w.paths.guards, 'utf8')).toBe(before)
})

test('S2B-3 catch-up refusals and throws report once per piece/code until cleared', async () => {
  const w = await world('on')
  await writeCp(w, cp('p1'))
  forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
  w.board.setPhaseStatus = async () => ({ ok: false, message: 'classification_required' })
  for (let i = 0; i < 3; i++) await w.svc.tick()
  expect(w.logs.filter(l => l === 'sweep-catch-up-failed p1: classification_required')).toHaveLength(1)
  w.board.setPhaseStatus = async () => { throw Object.assign(new Error('busy'), { code: 'guard_busy' }) }
  for (let i = 0; i < 3; i++) await w.svc.tick()
  expect(w.logs.filter(l => l === 'sweep-catch-up-failed p1: guard_busy')).toHaveLength(1)
  w.board.setPhaseStatus = async () => ({ ok: true })
  await w.svc.tick()
  w.board.setPhaseStatus = async () => ({ ok: false, message: 'classification_required' })
  await w.svc.tick()
  expect(w.logs.filter(l => l === 'sweep-catch-up-failed p1: classification_required')).toHaveLength(2)
})

test('S2B-1 identical ineffective member plan never writes or comments again', async () => {
  let writes = 0
  let doc: any = { checkpoints: {}, intents: {}, migrations: { a: { version: 1, at: ISO } } }
  const book: any = { tasks: [{ id: 't1', status: 'in_progress' }], statuses: DEFS, subtasks: [{ id: 'g', taskId: 't1', status: 'in_progress' }, { id: 'm', taskId: 't1', parentGroupId: 'g', status: 'done' }] }
  const deps: any = { rule: async () => 'on', envelope: (fn: any) => fn(), guards: { read: async () => doc, write: async (d: any) => { doc = d } }, tasks: { read: async () => book, applyBoardReverts: async () => { writes++ } }, store: { read: async () => ({ deliveries: {} }) }, statusStages: async () => undefined, effective: (subs: any) => subs.map((s: any) => s.id === 'g' ? { ...s, status: 'in_progress' } : s), ids: { comment: () => 'c', event: () => 'e' }, now: () => T }
  await guardSweep(deps, [])
  const second: string[] = [], third: string[] = []
  await guardSweep(deps, second)
  await guardSweep(deps, third)
  expect(writes).toBe(0)
  expect(second).toEqual([])
  expect(third).toEqual([])
})
