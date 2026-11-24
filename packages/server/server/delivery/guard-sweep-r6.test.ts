/** S2b r6: the re-QA r5 findings (R5-1..R5-6), ported from the QA's own probes (qa-eg-s2b-r5/r5-attacks.test.ts) before the fix. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createDeliveryStore } from './store'
import { createGuardsStore, type PieceCheckpoint } from './guards-store'
import { createDeliveryService } from './service'
import { execGit } from './classify-host'
import { createTaskStore, type TaskStore } from '../sessions/task-store'
import { inGuardTransaction } from './guard-transaction'
import { effectiveSubtasks } from '../sessions/task-report'
import { SWEEP_NO_BASELINE_WARN_MS, sweepWarnings } from './sweep-plan'
import { unattributedContext } from './guard'

const T = Date.parse('2026-11-13T10:00:00Z')
const ISO = new Date(T).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: new Date(now).toISOString(), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true),
  def('in_review', 'In review', 'leader', 4), def('pr_merge', 'PR merge', 'merge', 5), def('ci', 'CI', 'ci', 6), def('abandoned', 'Abandoned', 'queue', 7)]
const subtask = (id: string, extra: Record<string, unknown> = {}) => ({ id, taskId: 't1', title: id, done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO, ...extra }) as never

const hook: { wrap?: (t: TaskStore) => TaskStore } = {}
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'eg-s2b-r6-')) })
afterEach(() => { hook.wrap = undefined; rmSync(root, { recursive: true, force: true }) })

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
    sweep: { tasks: async () => (hook.wrap ? hook.wrap(tasks) : tasks), paths },
  } as never) as any
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  expect(await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })).toEqual({ ok: true })
  expect(await g.setState('a', 'on', { check, facts: facts(T) })).toEqual({ ok: true })
  const guards = createGuardsStore(paths.guards)
  await guards.write({ ...(await guards.read()), migrations: { a: { version: 1, at: ISO } } })
  return { svc, tasks, store, guards, clock, paths, board, logs }
}
type W = Awaited<ReturnType<typeof world>>
const cp = (key: string, o: Partial<PieceCheckpoint> = {}): PieceCheckpoint => ({
  key, rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', revision: 2, headSha: null,
  auth: [{ kind: 'evidence', ids: ['e1'], sha256: ['aa'] }], by: { kind: 'flow', engine: 'entrega' }, at: ISO, transitionId: `tr-${key}`, ...o,
} as PieceCheckpoint)
const cp0 = (key: string, o: Partial<PieceCheckpoint> = {}) => cp(key, { rank: 0, phase: 'executando', boardStatus: 'in_progress', boardStage: 'running', auth: [{ kind: 'grandfathered', at: ISO }] as never, ...o })
const writeCp = async (w: W, c: PieceCheckpoint) => { const doc = await w.guards.read(); await w.guards.write({ ...doc, checkpoints: { ...doc.checkpoints, [c.key]: c } }) }
const forgeBoard = (w: W, pick: (s: any) => boolean, patch: Record<string, unknown>) => {
  const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  raw.subtasks = raw.subtasks.map((s: any) => (pick(s) ? { ...s, ...patch } : s))
  writeFileSync(w.paths.tasks, JSON.stringify(raw))
}
const dropBoard = (w: W, pick: (s: any) => boolean) => {
  const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  raw.subtasks = raw.subtasks.filter((s: any) => !pick(s))
  writeFileSync(w.paths.tasks, JSON.stringify(raw))
}
const addBoard = (w: W, s: Record<string, unknown>) => {
  const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  raw.subtasks.push(s)
  writeFileSync(w.paths.tasks, JSON.stringify(raw))
}
const sub = async (w: W, id: string) => (await w.tasks.read()).subtasks.find(s => s.id === id) as any
const sweepLines = (a: string[]) => a.filter(x => x.startsWith('sweep'))
const SESSION = { principal: { kind: 'session', id: 'worker-1', via: 'token' } } as never
const OWNER = { principal: { kind: 'owner', via: 'legacy-browser' } } as never
const member = (id: string, status: string, group = 'g') => [id, { parentGroupId: group, status, done: status === 'done' }] as [string, Record<string, unknown>]
const groupStatusNow = async (w: W, id = 'g') => (effectiveSubtasks((await w.tasks.read()).subtasks as never) as any[]).find(s => s.id === id)!.status
const recordedAll = (members: Array<[string, Record<string, unknown>?]>) => Object.fromEntries(members.map(([id, x]) => [id, { status: (x as any).status, at: ISO }]))
const members = async (w: W, key = 'g') => (await w.guards.read()).checkpoints[key]!.members as Record<string, { status: string }> | undefined
const ticks = async (w: W, n: number, step = 60_000) => { const outs: string[][] = []; for (let i = 0; i < n; i++) { outs.push(sweepLines((await w.svc.tick()).actions)); w.clock.now += step } return outs }

// ── R5-1: members removed / moved out by a raw writer ────────────────────────────────────────────────────────────────

test('QA5 REMOVE: a raw writer deleting the open member never leaves a baselined group published', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  expect(await groupStatusNow(w)).toBe('todo')
  dropBoard(w, s => s.id === 'm1')
  expect(await groupStatusNow(w)).toBe('done')
  const outs = await ticks(w, 3)
  expect(await groupStatusNow(w)).not.toBe('done')
  expect(outs[0]).toContain('sweep-revert m1: member_removed')
  expect(outs.slice(1).flat()).toEqual([])
  const m1 = await sub(w, 'm1')
  expect(m1).toMatchObject({ parentGroupId: 'g', status: 'todo', taskId: 't1' })
  expect(String(m1.title)).toContain('guard sweep')
  const doc = await w.guards.read()
  expect(sweepWarnings(doc.sweep as never, w.clock.now).some(x => x.includes('member_removed') && x.includes('g'))).toBe(true)
  expect((await w.tasks.read()).comments.some(c => c.author === 'flow:entrega' && c.body.includes('m1'))).toBe(true)
})

test('QA5 MOVE-OUT: a raw writer moving the open member out of the group gets its parentGroupId put back', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  forgeBoard(w, s => s.id === 'm1', { parentGroupId: undefined })
  const outs = await ticks(w, 3)
  expect(await groupStatusNow(w)).not.toBe('done')
  expect(outs[0]).toContain('sweep-revert m1: member_moved_out')
  expect(outs.slice(1).flat()).toEqual([])
  expect(await sub(w, 'm1')).toMatchObject({ parentGroupId: 'g', status: 'todo' })
  expect(sweepWarnings((await w.guards.read()).sweep as never, w.clock.now).some(x => x.includes('member_moved_out'))).toBe(true)
})

test('R5-1 a moved-out member forged above its accepted status comes back at the accepted status, in one revert', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  forgeBoard(w, s => s.id === 'm1', { parentGroupId: undefined, status: 'done', done: true })
  const outs = await ticks(w, 2)
  expect(outs[0]).toEqual(['sweep-revert m1: member_moved_out'])
  expect(outs[1]).toEqual([])
  expect(await sub(w, 'm1')).toMatchObject({ parentGroupId: 'g', status: 'todo', done: false })
})

test('QA5 CONTROL: the same removal through the guarded store is refused', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  let refused: unknown = null
  try { await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), parentGroupId: undefined }, SESSION) } catch (e) { refused = (e as any)?.code ?? String(e) }
  expect(refused).not.toBeNull()
  expect(await groupStatusNow(w)).toBe('todo')
})

test('R5-1 the real group shape (8 done, 1 abandoned, 4 todo): deleting the 4 todo is repaired, the 9 others untouched', async () => {
  const ms = [...Array.from({ length: 8 }, (_, i) => member(`d${i}`, 'done')), member('a0', 'abandoned'), ...Array.from({ length: 4 }, (_, i) => member(`t${i}`, 'todo'))]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  dropBoard(w, s => s.id.startsWith('t'))
  expect(await groupStatusNow(w)).toBe('done')
  const outs = await ticks(w, 3)
  expect(await groupStatusNow(w)).toBe('todo')
  expect(outs[0]!.filter(a => a.endsWith('member_removed')).sort()).toEqual(['t0', 't1', 't2', 't3'].map(id => `sweep-revert ${id}: member_removed`))
  expect(outs.slice(1).flat()).toEqual([])
  const after = (await w.tasks.read()).subtasks
  for (let i = 0; i < 8; i++) expect(after.find(s => s.id === `d${i}`)!.status).toBe('done')
  expect(after.find(s => s.id === 'a0')!.status).toBe('abandoned')
  for (let i = 0; i < 4; i++) expect(after.find(s => s.id === `t${i}`)).toMatchObject({ parentGroupId: 'g', status: 'todo' })
})

test('R5-1 a deleted member whose accepted status is done is not recreated (it cannot lower the group)', async () => {
  const ms = [member('m0', 'done'), member('m1', 'done'), member('m2', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  dropBoard(w, s => s.id === 'm0' || s.id === 'm2')
  const outs = await ticks(w, 1)
  expect(outs[0]).toEqual(['sweep report m0: accepted_member_missing', 'sweep-revert m2: member_removed']) // r3: a deleted accepted member is reported, never restored
  expect(await sub(w, 'm0')).toBeUndefined()
})

test('R5-1 shadow: the same removal is only reported (would-revert), nothing written', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  expect(await g.setState('a', 'shadow', { check, facts: facts(w.clock.now) })).toEqual({ ok: true })
  dropBoard(w, s => s.id === 'm1')
  const before = readFileSync(w.paths.tasks, 'utf8')
  const guardsBefore = readFileSync(w.paths.guards, 'utf8')
  const outs = await ticks(w, 1)
  expect(outs[0]).toContain('sweep would-revert m1: member_removed')
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
  expect(readFileSync(w.paths.guards, 'utf8')).toBe(guardsBefore)
})

test('R5-1 a member removed through the guarded store (not lifting the group) drops it from the accepted record, and the sweep stays quiet', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo'), member('m2', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  const book = await w.tasks.read()
  await w.tasks.upsertSubtask({ ...(book.subtasks.find(s => s.id === 'm2') as any), parentGroupId: undefined }, SESSION)
  expect((await members(w))!.m2).toBeUndefined()
  expect((await members(w))!.m1!.status).toBe('todo')
  const outs = await ticks(w, 2)
  expect(outs.flat()).toEqual([])
})

// ── R5-2: an unaccepted member in a baselined group is reverted when it lifts the group ───────────────────────────────

test('QA5 REPLACE: a raw writer replacing the open member with a new done member is reverted (above_checkpoint)', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  dropBoard(w, s => s.id === 'm1')
  addBoard(w, { id: 'n0', taskId: 't1', title: 'n0', parentGroupId: 'g', status: 'done', done: true, createdAt: ISO, updatedAt: ISO })
  const outs = await ticks(w, 3)
  expect(await groupStatusNow(w)).not.toBe('done')
  expect(outs[0]).toContain('sweep-revert n0: above_checkpoint')
  expect(outs.flat().some(a => a.includes('no_member_baseline'))).toBe(false)
  expect((await members(w))!.n0?.status).not.toBe('done')
})

test('R5-2 a raw-created member and a forged recorded member that together lift the group are both reverted', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  addBoard(w, { id: 'n0', taskId: 't1', title: 'n0', parentGroupId: 'g', status: 'done', done: true, createdAt: ISO, updatedAt: ISO })
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  const outs = await ticks(w, 2)
  expect(outs[0]).toContain('sweep-revert n0: above_checkpoint')
  expect(outs[0]).toContain('sweep-revert m1: above_checkpoint')
  expect(await groupStatusNow(w)).not.toBe('done')
})

// ── R5-3: the sweep never adds a member it only observed ─────────────────────────────────────────────────────────────

test('QA5 NEW MEMBER: a raw-created done member that does not lift the group is reported every tick and never baselined', async () => {
  const ms = [member('m0', 'todo'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  addBoard(w, { id: 'n0', taskId: 't1', title: 'n0', parentGroupId: 'g', status: 'done', done: true, createdAt: ISO, updatedAt: ISO })
  const outs = await ticks(w, 3)
  expect(outs.every(o => o.includes('sweep report n0: unaccepted_member'))).toBe(true)
  expect((await members(w))!.n0).toBeUndefined()
  // ... and once the other members are deleted the group would lift: n0 is reverted, never trusted
  dropBoard(w, s => s.id === 'm0' || s.id === 'm1')
  const later = await ticks(w, 2)
  expect(later[0]).toContain('sweep-revert n0: above_checkpoint')
  expect(await groupStatusNow(w)).not.toBe('done')
})

test('R5-3 a member created through the guarded store is recorded as accepted in the same write', async () => {
  const ms = [member('m0', 'todo'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  await w.tasks.upsertSubtask(subtask('n0', { parentGroupId: 'g', status: 'todo' }), SESSION)
  expect((await members(w))!.n0!.status).toBe('todo')
  expect((await ticks(w, 2)).flat()).toEqual([])
})

// ── R5-4: a guarded move does not launder a forged status ────────────────────────────────────────────────────────────

test('QA5 LAUNDER: a raw-forged loose piece moved into a group through an accepted write is not accepted at the forged status', async () => {
  const ms = [member('m0', 'todo'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms, ['x', { status: 'in_progress' }]])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  await writeCp(w, cp0('x'))
  forgeBoard(w, s => s.id === 'x', { status: 'done', done: true })
  let refused: unknown = null
  try { await w.tasks.upsertSubtask({ ...(await sub(w, 'x')), parentGroupId: 'g' }, SESSION) } catch (e) { refused = (e as any)?.code ?? String(e) }
  const recorded = await members(w)
  expect(refused !== null || recorded?.x?.status !== 'done').toBe(true)
  if (refused === null) {
    const outs = await ticks(w, 2)
    expect(outs[0]).toContain('sweep report x: unaccepted_member')
    expect((await members(w))!.x).toBeUndefined()
  }
})

test('R5-4 an authorized loose piece moved into a group keeps its status accepted', async () => {
  const ms = [member('m0', 'todo'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms, ['x', { status: 'in_progress' }]])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  await writeCp(w, cp0('x'))
  await w.tasks.upsertSubtask({ ...(await sub(w, 'x')), parentGroupId: 'g' }, SESSION)
  expect((await members(w))!.x!.status).toBe('in_progress')
  expect((await ticks(w, 2)).flat()).toEqual([])
})

test('R5-4 a member moved between groups keeps the status its old group accepted, never a forged one', async () => {
  const w = await world([['g', { isGroup: true }], ['h', { isGroup: true }], member('m0', 'todo'), member('m1', 'todo'), member('h0', 'todo', 'h'), member('h1', 'todo', 'h')])
  await writeCp(w, cp0('g', { members: { m0: { status: 'todo', at: ISO }, m1: { status: 'todo', at: ISO } } } as never))
  await writeCp(w, cp0('h', { members: { h0: { status: 'todo', at: ISO }, h1: { status: 'todo', at: ISO } } } as never))
  await w.tasks.upsertSubtask({ ...(await sub(w, 'h1')), parentGroupId: 'g' }, SESSION)
  expect((await members(w, 'g'))!.h1!.status).toBe('todo')
  expect((await members(w, 'h'))!.h1).toBeUndefined()
  forgeBoard(w, s => s.id === 'h0', { status: 'in_review' })
  await w.tasks.upsertSubtask({ ...(await sub(w, 'h0')), parentGroupId: 'g' }, OWNER).catch(() => undefined)
  const rec = (await members(w, 'g'))!.h0
  expect(rec?.status).not.toBe('in_review')
})

// ── R5-5: the old-store window ───────────────────────────────────────────────────────────────────────────────────────

test('QA5 OLD-FOREVER: old store forged before the upgrade reports every tick, never reverts, and raises a health WARN once it persists', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g'))
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  const first = await ticks(w, 1, 60_000)
  expect(sweepWarnings((await w.guards.read()).sweep as never, w.clock.now).some(x => x.includes('no_member_baseline'))).toBe(false)
  const outs = [...first, ...(await ticks(w, 4, 30 * 60_000))]
  expect(await groupStatusNow(w)).toBe('done')
  expect(await members(w)).toBeUndefined()
  expect(outs.every(o => o.some(a => a.includes('no_member_baseline')))).toBe(true)
  const warn = sweepWarnings((await w.guards.read()).sweep as never, w.clock.now)
  expect(warn.some(x => x.includes('no_member_baseline') && x.includes('m1'))).toBe(true)
  expect(SWEEP_NO_BASELINE_WARN_MS).toBe(60 * 60_000)
  // the WARN goes away once the report stops (a person repairs the group by hand)
  forgeBoard(w, s => s.id === 'm1', { status: 'todo', done: false })
  await ticks(w, 1)
  expect(sweepWarnings((await w.guards.read()).sweep as never, w.clock.now).some(x => x.includes('no_member_baseline'))).toBe(false)
})

test('QA5 OLD-QUIET: old store, quiet group gets baselined on the first ON tick, and a later forgery is repaired', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g'))
  await ticks(w, 1)
  expect(await members(w)).toBeDefined()
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  await ticks(w, 1)
  expect((await sub(w, 'm1')).status).toBe('todo')
})

test('QA5 NO-MIGRATION-STAMP: first ON tick without the stamp skips with migration_missing and writes no baseline', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g'))
  const doc = await w.guards.read(); delete (doc as any).migrations; await w.guards.write(doc)
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  const before = readFileSync(w.paths.tasks, 'utf8')
  const t1 = sweepLines((await w.svc.tick()).actions)
  expect(t1).toContain('sweep-skipped: migration_missing')
  expect(await members(w)).toBeUndefined()
  expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
})

// ── R5-6: a baseline is never rewritten over a divergent member (kills QA5-M2) ───────────────────────────────────────

for (const [label, forged] of [['lateral', 'blocked'], ['lower', 'todo']] as const) {
  test(`R5-6 a ${label} divergence never becomes the accepted record`, async () => {
    const ms = [member('m0', 'in_progress'), member('m1', 'todo')]
    const w = await world([['g', { isGroup: true }], ...ms])
    await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
    forgeBoard(w, s => s.id === 'm0', { status: forged, done: false })
    await ticks(w, 3)
    expect((await members(w))!.m0!.status).toBe('in_progress')
  })
}

test('R5-6 the migration baseline is refused while a member would be reverted', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g'))
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  await ticks(w, 2)
  expect(await members(w)).toBeUndefined()
})

// ── keep: a raw write inside the chunks is never consolidated (QA5 RACE) ──────────────────────────────────────────────

test('QA5 RACE: a raw write during the chunks is not consolidated and is repaired by the next tick', async () => {
  const ms = [...Array.from({ length: 14 }, (_, i) => member(`m${i}`, 'done')), ...Array.from({ length: 9 }, (_, i) => member(`f${i}`, 'todo'))]
  const w = await world([['g', { isGroup: true }], ...ms])
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  forgeBoard(w, s => s.id.startsWith('f'), { status: 'done', done: true })
  let inTx = 0, injected = false
  hook.wrap = (t) => {
    const wr = Object.create(t)
    wr.read = async () => {
      if (inGuardTransaction(w.paths) && ++inTx === 3 && !injected) { injected = true; forgeBoard(w, s => s.id === 'f8', { status: 'in_review', done: false }) }
      return t.read()
    }
    return wr
  }
  await ticks(w, 1)
  hook.wrap = undefined
  await ticks(w, 2)
  const forged = (await w.tasks.read()).subtasks.filter(s => s.id.startsWith('f')).map(s => s.status)
  expect(forged.every(s => s === 'todo')).toBe(true)
  expect((await members(w))!.f8!.status).toBe('todo')
})
