/** S2b.1: the LOW reservations B1..B6 of the r6 re-QA (qa-eg-s2b-r6-sonnet.md); GAP-M1/GAP-M2 ported from the QA's own probes. */
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
import * as sweepPlan from './sweep-plan'
import { sweepWarnings } from './sweep-plan'
const { LOOP_RELEASE, SWEEP_UNACCEPTED_WARN_MS } = sweepPlan as { LOOP_RELEASE: string; SWEEP_UNACCEPTED_WARN_MS: number }
const sweepIssues = (m: unknown, n: number) => (sweepPlan as unknown as { sweepIssues: (m: unknown, n: number) => Array<{ id: string; title: string; text: string; guide: string }> }).sweepIssues(m, n)
import { analyzeGuardIntegrity } from './owner-health'
const mayDismissPlaceholder = async (o: { principal: unknown; taskId: string; isTaskLeader: (s: string, t: string) => Promise<boolean> }) => (await import('../sessions/placeholder-dismiss')).mayDismissPlaceholder(o as never)
import { planNext } from '../sessions/task-next'
import { findTask } from '../sessions/task-report'
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
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'eg-s2b-1-')) })
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
const LEADER = { principal: { kind: 'session', id: 'leader', via: 'token' } } as never
const OWNER = { principal: { kind: 'owner', via: 'legacy-browser' } } as never
const VAULT_OWNER = { principal: { kind: 'owner', via: 'vault-credential', grantId: 'g-1' } } as never
const member = (id: string, status: string, group = 'g') => [id, { parentGroupId: group, status, done: status === 'done' }] as [string, Record<string, unknown>]
const groupStatusNow = async (w: W, id = 'g') => (effectiveSubtasks((await w.tasks.read()).subtasks as never) as any[]).find(s => s.id === id)!.status
const recordedAll = (members: Array<[string, Record<string, unknown>?]>) => Object.fromEntries(members.map(([id, x]) => [id, { status: (x as any).status, at: ISO }]))
const members = async (w: W, key = 'g') => (await w.guards.read()).checkpoints[key]!.members as Record<string, { status: string }> | undefined
const ticks = async (w: W, n: number, step = 60_000) => { const outs: string[][] = []; for (let i = 0; i < n; i++) { outs.push(sweepLines((await w.svc.tick()).actions)); w.clock.now += step } return outs }


const tickN = async (w: W, n: number) => ticks(w, n)
const two = [member('m0', 'done'), member('m1', 'todo')]
async function restoredWorld() {
  const w = await world([['g', { isGroup: true }], ...two], 3)
  await writeCp(w, cp0('g', { members: recordedAll(two) } as never))
  dropBoard(w, s => s.id === 'm1')
  await tickN(w, 1)
  return w
}
const isLeaderOf = async (sid: string, taskId: string) => sid === 'leader' && taskId === 't1'

// ── B4: a restored placeholder is never work ─────────────────────────────────────────────────────────────────────────
test('B4 the placeholder is marked structurally and says plainly what it is and how to dismiss it', async () => {
  const w = await restoredWorld()
  const m1 = await sub(w, 'm1')
  expect(m1.restoredBy).toBe('guard')
  expect(String(m1.title)).toContain('restored by the guard sweep')
  expect(String(m1.notes)).toContain('NOT A TASK')
  expect(String(m1.notes)).toContain('raw write deleted')
  expect(String(m1.notes)).toContain('task leader or the owner removes this subtask')
  expect(String(m1.notes)).toContain('NÃO É TAREFA')
})

test('B4 task_next and task_claim never hand a placeholder out, and the delivery queue and stage refuse it', async () => {
  const w = await restoredWorld()
  const book = await w.tasks.read()
  const next = planNext({ tasks: book.tasks, nowMs: T })
  expect(JSON.stringify(next)).not.toContain('"m1"')
  expect(findTask('m1', book.tasks)).toBeUndefined()
  expect(findTask(String((await sub(w, 'm1')).title), book.tasks)).toBeUndefined()
  // The delivery side: a placeholder moved out of its group is still never staged or queued.
  const facts = { subtask: async (id: string) => { const s = await sub(w, id); return s && { id, taskId: s.taskId, title: s.title, status: s.status, groupMember: Boolean(s.parentGroupId), ...(s.restoredBy ? { restoredBy: s.restoredBy } : {}), blockedBy: [] } }, sessions: async () => [], blockedSubtasks: async () => [] }
  const svc = createDeliveryService({
    store: w.store, facts: facts as never, board: { ...w.board, stage: async () => ({ ok: true }) } as never, notify: { session: async () => true, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => w.clock.now, classify: { sessions: async () => [], git: execGit }, guardsPath: w.paths.guards, autoReconcile: () => false,
  } as never) as any
  forgeBoard(w, s => s.id === 'm1', { parentGroupId: undefined })
  const reply = await svc.stage('m1', { prompt: 'x' }, 'leader')
  expect(reply.ok).toBe(false)
  expect(reply.code).toBe('guard_placeholder')
  expect((await svc.queueView('t1')).items ?? (await svc.queueView('t1')).queue ?? []).toEqual(expect.not.arrayContaining([expect.objectContaining({ subtaskId: 'm1' })]))
})

test('B4 the task leader and the owner dismiss the placeholder; it is not re-created and the group closes without it', async () => {
  for (const who of [LEADER, OWNER]) {
    const w = await restoredWorld()
    expect(await groupStatusNow(w)).toBe('todo')
    const dismissed = await w.tasks.removeSubtask('m1', { guard: who, dismissPlaceholder: who }).then(() => true, (e: unknown) => `refused: ${(e as { code?: string }).code}`)
    expect(dismissed).toBe(true)
    const outs = await ticks(w, 3)
    expect(outs.flat()).toEqual([])
    expect(await sub(w, 'm1')).toBeUndefined()
    expect((await members(w))!.m1).toBeUndefined()
    expect(await groupStatusNow(w)).toBe('done')
    rmSync(root, { recursive: true, force: true }); root = mkdtempSync(join(tmpdir(), 'eg-s2b-1-'))
  }
})

test('B4 a worker (or an unattributed caller) may not dismiss a placeholder; the leader and the owner may', async () => {
  const allow = (principal: any) => mayDismissPlaceholder({ principal, taskId: 't1', isTaskLeader: isLeaderOf })
  expect(await allow({ kind: 'session', id: 'worker-1' })).toBe(false)
  expect(await allow({ kind: 'session', id: 'leader' })).toBe(true)
  expect(await allow({ kind: 'owner' })).toBe(true)
  expect(await allow({ kind: 'unattributed' })).toBe(false)
  expect(await allow(undefined)).toBe(false)
  expect(await mayDismissPlaceholder({ principal: { kind: 'session', id: 'leader' }, taskId: 'other-task', isTaskLeader: isLeaderOf })).toBe(false)
})

// ── B3: a member moved to another task comes back to the group's task ────────────────────────────────────────────────
test('B3 QA6-COLLIDE: a member a raw writer moved to ANOTHER task is restored with the group and the group\'s task', async () => {
  const w = await world([['g', { isGroup: true }], ...two], 3)
  await writeCp(w, cp0('g', { members: recordedAll(two) } as never))
  forgeBoard(w, s => s.id === 'm1', { parentGroupId: undefined, taskId: 'quiet-1', status: 'done', done: true })
  const outs = await tickN(w, 3)
  expect(outs[0]).toContain('sweep-revert m1: member_moved_out')
  expect(await sub(w, 'm1')).toMatchObject({ parentGroupId: 'g', taskId: 't1', status: 'todo' })
  expect(await groupStatusNow(w)).toBe('todo')
  const ev = (await w.tasks.read()).events.find(e => e.actor === 'flow:sweep' && e.detail?.includes('member_moved_out'))
  expect(ev?.detail).toContain('crossTask: true')
  expect(ev?.taskId).toBe('t1')
})

test('B3 a same-task move-out carries no crossTask detail', async () => {
  const w = await world([['g', { isGroup: true }], ...two], 3)
  await writeCp(w, cp0('g', { members: recordedAll(two) } as never))
  forgeBoard(w, s => s.id === 'm1', { parentGroupId: undefined })
  await tickN(w, 1)
  const ev = (await w.tasks.read()).events.find(e => e.actor === 'flow:sweep' && e.detail?.includes('member_moved_out'))
  expect(ev?.detail).not.toContain('crossTask')
})

// ── B2: a forge carried by a guarded write is warned about after 60 ticks ────────────────────────────────────────────
test('B2 QA6-RIDE2: a forged member a SESSION write carried stays reported, and a WARN rises after 60 ticks (not before)', async () => {
  const ms = [member('m0', 'todo'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms, ['h', { isGroup: true }], ['hm', { parentGroupId: 'h', status: 'todo' }]], 3)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  await writeCp(w, cp0('h', { members: recordedAll([['hm', { status: 'todo' }]]) } as never))
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), parentGroupId: 'h' }, SESSION)
  const first = await tickN(w, 1)
  expect(first[0]).toContain('sweep report m1: unaccepted_member')
  const has = async () => sweepIssues((await w.guards.read()).sweep as never, w.clock.now).some(i => i.id === 'sweep-unaccepted-member' && i.text.includes('m1'))
  expect(await has()).toBe(false)
  w.clock.now += SWEEP_UNACCEPTED_WARN_MS - 10 * 60_000
  await tickN(w, 1)
  expect(await has()).toBe(false)
  w.clock.now += 12 * 60_000
  await tickN(w, 1)
  expect(await has()).toBe(true)
  expect((await sub(w, 'm1')).status).toBe('done') // declared residual risk: reported, never repaired
})

test('B2 the WARN goes away when the report stops', async () => {
  const ms = [member('m0', 'todo'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms, ['h', { isGroup: true }], ['hm', { parentGroup: undefined, parentGroupId: 'h', status: 'todo' }]], 3)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  await writeCp(w, cp0('h', { members: recordedAll([['hm', { status: 'todo' }]]) } as never))
  forgeBoard(w, s => s.id === 'm1', { status: 'done', done: true })
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), parentGroupId: 'h' }, SESSION)
  await tickN(w, 1)
  w.clock.now += SWEEP_UNACCEPTED_WARN_MS + 60_000
  await tickN(w, 1)
  dropBoard(w, s => s.id === 'm1')
  await tickN(w, 2)
  expect(sweepIssues((await w.guards.read()).sweep as never, w.clock.now).some(i => i.id === 'sweep-unaccepted-member')).toBe(false)
})

// ── B1: the loop-guard block says why and how to release it ──────────────────────────────────────────────────────────
test('B1 the sweep-loop WARN says why the piece is blocked and what the person does to release it', () => {
  const issues = sweepIssues({ reverts: { m1: [ISO, ISO] } }, T)
  const loop = issues.find(i => i.id === 'sweep-loop')!
  expect(loop.text).toContain(LOOP_RELEASE)
  expect(loop.text).toContain('stays blocked until a person sets its status back')
  expect(loop.text).toContain('continua bloqueada até uma pessoa')
})

test('B1 a group held blocked by the loop guard carries the release sentence in its WARN', async () => {
  const w = await restoredWorld()
  dropBoard(w, s => s.id === 'm1')
  await tickN(w, 2)
  expect(await groupStatusNow(w)).toBe('blocked')
  expect(sweepWarnings((await w.guards.read()).sweep as never, w.clock.now).some(t => t.includes('sets its status back'))).toBe(true)
})

// ── B6: health ids come from structured data ─────────────────────────────────────────────────────────────────────────
test('B6 the member WARN id is group + action, never a piece of the text, and not under the owner-turned-off frame', async () => {
  const w = await restoredWorld()
  const mem = (await w.guards.read()).sweep as never
  const issues = sweepIssues(mem, w.clock.now)
  expect(issues.map(i => i.id)).toContain('sweep-members:g:member_removed')
  const out: any[] = []
  analyzeGuardIntegrity({ offWarnings: [], sweepIssues: issues }, out)
  const one = out.find(i => i.id === 'sweep-members:g:member_removed')
  expect(one).toBeTruthy()
  expect(one.id.startsWith('guarantee-off')).toBe(false)
  expect(one.description).not.toContain('owner turned')
  expect(out.every(i => !i.id.includes(', ') && !i.id.includes('member_removed)'))).toBe(true)
})

test('B6 a moved-out and a removed member in one group give distinct, stable ids', () => {
  const issues = sweepIssues({ reverts: {}, memberAlerts: { g: { at: ISO, text: 't', actions: ['member_removed', 'member_moved_out', 'member_removed'] } } }, T)
  expect(issues.map(i => i.id)).toEqual(['sweep-members:g:member_moved_out+member_removed'])
})

// ── B5: GAP-M1 / GAP-M2 (QA probes) in the committed suite ───────────────────────────────────────────────────────────
test('B5 GAP-M1 an owner-authorized baselined group: a raw delete of an open member is never restored by the sweep', async () => {
  const w = await world([['g', { isGroup: true }], ...two], 3)
  await writeCp(w, cp0('g', { members: recordedAll(two), auth: [{ kind: 'owner', at: ISO }], by: { kind: 'owner', via: 'legacy-browser' } } as never))
  dropBoard(w, s => s.id === 'm1')
  const outs = await tickN(w, 2)
  expect(outs.flat()).toEqual([])
  expect(await sub(w, 'm1')).toBeUndefined()
})

test('B5 GAP-M2 a moved-out member a raw writer also lowered keeps its own lower status when restored', async () => {
  const ms = [member('m0', 'done'), member('m1', 'in_progress')]
  const w = await world([['g', { isGroup: true }], ...ms], 3)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  forgeBoard(w, s => s.id === 'm1', { parentGroupId: undefined, status: 'todo', done: false })
  await tickN(w, 2)
  expect(await sub(w, 'm1')).toMatchObject({ parentGroupId: 'g', status: 'todo' })
})

// ══ r2: the placeholder LEDGER is the authority, never the flag in tasks.json (Haiku re-QA: BLOCKER B4-forge) ═══════════════════════
const dismissDeps = (w: W, leaderOf: Record<string, string> = { leader: 't1' }) => ({
  world: async () => ({ store: w.tasks, book: await w.tasks.read(), registryRows: [...Object.entries(leaderOf).map(([id, taskId]) => ({ id, taskId })), { id: 'worker-1', taskId: 't1' }] }),
  roleOf: async (row: { id: string }) => (row.id.startsWith('leader') ? 'leader' : 'worker'),
})
const dismiss = async (w: W, id: string, guard: unknown, leaderOf?: Record<string, string>) => {
  // as `removeVia`: a thrown backstop is returned as a value so the test's own `reason` assertion kills a weakened door
  try { return await (await import('../sessions/task-web')).dismissPlaceholder(id, guard as never, dismissDeps(w, leaderOf) as never) }
  catch (e) { return { ok: false, reason: `threw:${(e as { code?: string }).code ?? String(e)}` } as never }
}

test('r2 the sweep records every restoration in its own ledger (group, task, time, random id); the board record is only a label', async () => {
  const w = await restoredWorld()
  const rec = (await w.guards.read()).sweep?.placeholders?.m1
  expect(rec).toMatchObject({ groupId: 'g', taskId: 't1', restoredAt: ISO })
  expect(String(rec!.restorationId).length).toBeGreaterThan(8)
  expect(rec!.dismissedAt).toBeUndefined()
  expect(await w.tasks.placeholderOf('m1')).toMatchObject({ groupId: 'g' })
})

test('r2 QA FORGE probe: a raw restoredBy mark on a REAL accepted member is not authority — dismissal refused, flag stripped, WARN raised, normal rules apply', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms], 3)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  forgeBoard(w, s => s.id === 'm0', { restoredBy: 'guard' })
  expect(await sub(w, 'm0')).toMatchObject({ restoredBy: 'guard' })
  expect(await w.tasks.placeholderOf('m0')).toBeNull()
  // the leader's dismissal door refuses it — at the door itself, before the store (whose own ledger check is a second layer)
  let reached = 0
  const loose = { ...dismissDeps(w), world: async () => ({ store: { ...w.tasks, removeSubtask: async () => { reached++; return true } } as never, book: await w.tasks.read(), registryRows: [{ id: 'leader', taskId: 't1' }] }) }
  expect(await (await import('../sessions/task-web')).dismissPlaceholder('m0', LEADER, loose as never)).toMatchObject({ ok: false, reason: 'not_a_placeholder' })
  expect(reached).toBe(0)
  expect(await dismiss(w, 'm0', LEADER)).toMatchObject({ ok: false, reason: 'not_a_placeholder' })
  expect(await dismiss(w, 'm0', OWNER)).toMatchObject({ ok: false, reason: 'not_a_placeholder' })
  expect(await sub(w, 'm0')).toBeTruthy()
  // the sweep reports it every tick, with a structured health id
  const outs = await ticks(w, 2)
  expect(outs.every(o => o.includes('sweep report m0: forged_restore_mark'))).toBe(true)
  const issue = sweepIssues((await w.guards.read()).sweep as never, w.clock.now).find(i => i.id === 'sweep-forged-restore-mark:m0')
  expect(issue).toBeTruthy()
  expect(issue!.text).toContain('forged_restore_mark')
  // the next guarded write strips the flag; the piece then follows the normal rules and the WARN stays for its window
  await w.tasks.upsertSubtask({ ...(await sub(w, 'm1')), title: 'renamed' }, SESSION)
  expect((await sub(w, 'm0')).restoredBy).toBeUndefined()
  expect(sweepIssues((await w.guards.read()).sweep as never, w.clock.now).some(i => i.id === 'sweep-forged-restore-mark:m0')).toBe(true)
})

test('r2 a forged mark on a piece of the ledger-less board leaves it a real piece for the delivery facts (stage / queue see no placeholder)', async () => {
  const { TASKS_FILE } = await import('../config')
  if (TASKS_FILE.startsWith('/home/mithrandir/.agentistics')) throw new Error('refusing to write the real store')
  const { defaultGateFacts } = await import('./gates')
  const store = createTaskStore(TASKS_FILE)
  await store.seedStatuses(DEFS)
  await store.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  const guards = createGuardsStore(join(TASKS_FILE, '..', 'guards.json'))
  const doc = await guards.read()
  await guards.write({ ...doc, sweep: { reverts: {}, placeholders: { ph: { groupId: 'g', taskId: 't1', restoredAt: ISO, restorationId: 'r-1' } } } })
  // (the flag is written raw: a guarded write would already strip the forged one)
  const raw = JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
  raw.subtasks.push(subtask('real', { restoredBy: 'guard' }), subtask('ph', { restoredBy: 'guard' }))
  writeFileSync(TASKS_FILE, JSON.stringify(raw))
  const f = defaultGateFacts()
  expect((await f.subtask('real'))!.restoredBy).toBeUndefined()
  expect((await f.subtask('ph'))!.restoredBy).toBe('guard')
  // The facts function itself (no store write in between could have stripped the flag first):
  const { placeholderFact } = await import('./gates')
  const stub = { placeholderOf: async (id: string) => (id === 'ph' ? { groupId: 'g' } : null) }
  expect(await placeholderFact(stub, { id: 'real', restoredBy: 'guard' })).toEqual({})
  expect(await placeholderFact(stub, { id: 'ph', restoredBy: 'guard' })).toEqual({ restoredBy: 'guard' })
  expect(await placeholderFact(stub, { id: 'ph' })).toEqual({})
})

test('r2 the leader dismisses a ledger placeholder; the ledger marks it dismissed in the same section and it is never resurrected', async () => {
  const w = await restoredWorld()
  expect(await dismiss(w, 'm1', LEADER)).toEqual({ ok: true })
  expect(await sub(w, 'm1')).toBeUndefined()
  const rec = (await w.guards.read()).sweep?.placeholders?.m1
  expect(rec?.dismissedAt).toBeTruthy()
  expect(await w.tasks.placeholderOf('m1')).toBeNull()
  expect((await ticks(w, 3)).flat()).toEqual([])
  expect(await sub(w, 'm1')).toBeUndefined()
  expect(await groupStatusNow(w)).toBe('done')
})

test('r2 a worker, an unattributed caller and a forged session are refused; a dismissed placeholder is no longer one', async () => {
  const w = await restoredWorld()
  expect(await dismiss(w, 'm1', SESSION)).toMatchObject({ ok: false, reason: 'placeholder_protected' })
  expect(await dismiss(w, 'm1', { principal: { kind: 'unattributed' } })).toMatchObject({ ok: false, reason: 'placeholder_protected' })
  expect(await dismiss(w, 'm1', undefined)).toMatchObject({ ok: false, reason: 'placeholder_protected' })
  expect(await sub(w, 'm1')).toBeTruthy()
  expect(await dismiss(w, 'nope', LEADER)).toMatchObject({ ok: false, reason: 'no_such_subtask' })
})

test('r2 QA-M3: a leader of ANOTHER task is refused on dismiss and on removeSubtask', async () => {
  const w = await restoredWorld()
  const other = { principal: { kind: 'session', id: 'leader-b', via: 'token' } } as never
  const deps = dismissDeps(w, { 'leader-b': 't2' })
  const web = await import('../sessions/task-web')
  expect(await web.dismissPlaceholder('m1', other, deps as never)).toMatchObject({ ok: false, reason: 'placeholder_protected' })
  expect(await web.removeSubtask('m1', other, deps as never)).toMatchObject({ ok: false, reason: 'placeholder_protected' })
  expect(await sub(w, 'm1')).toBeTruthy()
  expect(await web.removeSubtask('m1', LEADER, dismissDeps(w) as never)).toBe(true)
})

test('r2 the placeholder note names the doors that exist (MCP, CLI, REST), not the ones that do not', async () => {
  const notes = sweepPlan.PLACEHOLDER_NOTES
  expect(notes).toContain('dismissPlaceholder: true')
  expect(notes).toContain('agentop task subtask dismiss')
  expect(notes).not.toContain('agentop task subtask remove')
  expect(notes).not.toContain('DELETE')
})

test('r2 the CLI door: leader ok, worker refused, non-placeholder refused', async () => {
  const { runSubtaskDismiss } = await import('../sessions/cli-task')
  const web = await import('../sessions/task-web')
  const lines: string[] = []
  const log = console.log; console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
  try {
    const run = async (w: W, id: string, principal: unknown) => runSubtaskDismiss(['t1', id, '--json'], { principal: async () => (principal as { principal: never }).principal, dismiss: (sid, g) => web.dismissPlaceholder(sid, g, dismissDeps(w) as never) })
    const w = await restoredWorld()
    expect(await run(w, 'm1', SESSION)).toBe(1)
    expect(await run(w, 'm0', LEADER)).toBe(1) // a real member
    expect(await sub(w, 'm0')).toBeTruthy()
    expect(await run(w, 'm1', LEADER)).toBe(0)
    expect(await sub(w, 'm1')).toBeUndefined()
    expect(lines.join('\n')).toContain('not_a_placeholder')
  } finally { console.log = log }
  expect(await runSubtaskDismiss(['only-one'])).toBe(2)
})

// ══ r3: the general removal door and accepted members (Haiku re-QA r2 BLOCKER, Q4 / ATK-7) ═══════════════════════════════════════
// A thrown refusal (the store's backstop firing where the door should have answered) comes back as a value, so a
// weakened door is caught by the test's own assertion on `reason`, never by an exception escaping the test.
const removeVia = async (w: W, id: string, guard: unknown, leaderOf?: Record<string, string>) => {
  try { return await (await import('../sessions/task-web')).removeSubtask(id, guard as never, dismissDeps(w, leaderOf) as never) }
  catch (e) { return { ok: false, reason: `threw:${(e as { code?: string }).code ?? String(e)}` } as never }
}
async function acceptedWorld() {
  const w = await world([['g', { isGroup: true }], ...two], 3)
  await writeCp(w, cp0('g', { members: recordedAll(two) } as never))
  return w
}

test('r3 Q4/ATK-7: a leader (or a worker) with a valid session cannot remove an accepted (done) member: member_accepted, nothing changes', async () => {
  const w = await acceptedWorld()
  for (const who of [LEADER, SESSION]) {
    const out = await removeVia(w, 'm0', who)
    expect(out).toMatchObject({ ok: false, reason: 'member_accepted' })
    expect((out as { message: string }).message).toContain('only the owner')
    expect(await sub(w, 'm0')).toBeTruthy()
  }
  expect(await removeVia(w, 'm0', undefined)).toMatchObject({ ok: false, reason: 'member_accepted' })
  expect(await removeVia(w, 'm0', { principal: { kind: 'unattributed' } })).toMatchObject({ ok: false, reason: 'member_accepted' })
  expect(await sub(w, 'm0')).toBeTruthy()
})

test('r3 the owner removes an accepted member: ok, recorded in the ledger as an owner removal, the sweep neither restores it nor warns, the group is not raised', async () => {
  const w = await acceptedWorld()
  expect(await removeVia(w, 'm0', VAULT_OWNER)).toBe(true)
  expect(await sub(w, 'm0')).toBeUndefined()
  const rec = (await w.guards.read()).sweep?.ownerRemoved?.m0
  expect(rec).toMatchObject({ groupId: 'g' })
  // the group's accepted record may still name the member (a stale or re-written one): the OWNER record is what keeps the sweep quiet
  await writeCp(w, cp0('g', { members: recordedAll(two) } as never))
  const outs = (await ticks(w, 3)).flat()
  expect(outs).toEqual([])
  expect(await sub(w, 'm0')).toBeUndefined()
  const issues = sweepIssues((await w.guards.read()).sweep as never, w.clock.now)
  expect(issues.filter(i => i.id.includes('accepted-member-missing'))).toEqual([])
  expect(await groupStatusNow(w)).toBe('todo')
})

test('r3 an owner removal of an OPEN accepted member (store call with the owner context) is never restored by the sweep', async () => {
  const ms = [member('m0', 'done'), member('m1', 'in_progress')]
  const w = await world([['g', { isGroup: true }], ...ms], 3)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  expect(await w.tasks.removeSubtask('m1', { guard: VAULT_OWNER, ownerRemoval: VAULT_OWNER })).toBe(true)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  expect((await ticks(w, 3)).flat()).toEqual([])
  expect(await sub(w, 'm1')).toBeUndefined()
})

test('r3 a raw delete of an accepted (done) member is reported every tick with a structured WARN id and never raises or restores the group', async () => {
  const w = await acceptedWorld()
  const before = await groupStatusNow(w)
  dropBoard(w, s => s.id === 'm0')
  const outs = await ticks(w, 3)
  for (const o of outs) expect(o).toContain('sweep report m0: accepted_member_missing')
  expect(await sub(w, 'm0')).toBeUndefined()
  expect(await groupStatusNow(w)).toBe(before)
  const issues = sweepIssues((await w.guards.read()).sweep as never, w.clock.now)
  const one = issues.find(i => i.id === 'sweep-accepted-member-missing:m0')!
  expect(one).toBeTruthy()
  expect(one.guide).toContain('Only the owner may remove an accepted piece')
  const out: any[] = []
  analyzeGuardIntegrity({ offWarnings: [], sweepIssues: issues }, out)
  expect(out.find(i => i.id === 'sweep-accepted-member-missing:m0')?.severity).toBe('warning')
})

test('r3 every sweep WARN has its own guide and none points at turning the guard off', () => {
  const memory = {
    reverts: { a: [ISO, ISO] }, warning: 'sweep-breaker: 9/10 pieces need a revert', forgedMarks: { f1: ISO }, noBaselineSince: { n1: new Date(T - 2 * 3600_000).toISOString() },
    unacceptedSince: { u1: new Date(T - 2 * 3600_000).toISOString() }, memberAlerts: { g: { at: ISO, text: 't', actions: ['member_removed'] } }, acceptedMissing: { m0: { groupId: 'g', at: ISO } },
  }
  const issues = sweepIssues(memory, T)
  expect(issues.map(i => i.id.split(':')[0]).sort()).toEqual(['sweep-accepted-member-missing', 'sweep-breaker', 'sweep-forged-restore-mark', 'sweep-loop', 'sweep-members', 'sweep-no-member-baseline', 'sweep-unaccepted-member'])
  for (const i of issues) { expect(i.guide).not.toContain('guarantee off'); expect(i.guide.length).toBeGreaterThan(20) }
  expect(new Set(issues.map(i => i.guide)).size).toBe(issues.length)
  expect(issues.find(i => i.id.startsWith('sweep-forged-restore-mark'))!.guide).toContain('removed on the next guarded write')
  expect(issues.find(i => i.id.startsWith('sweep-members'))!.guide).toContain('agentop task subtask dismiss')
  expect(issues.find(i => i.id.startsWith('sweep-unaccepted-member'))!.guide).toContain('dismiss')
  const out: any[] = []
  analyzeGuardIntegrity({ offWarnings: ['sweep-breaker: x', 'sweep-loop: a', 'sweep-skipped: migration_missing — m'], sweepIssues: issues }, out)
  for (const i of out) expect(i.guide).not.toContain('guarantee off')
})

test('r3 B1 a group that stays todo: an open placeholder deleted again is not restored and raises no loop or WARN', async () => {
  const quiet = [member('m0', 'todo'), member('m1', 'todo')]
  const q = await world([['g', { isGroup: true, status: 'todo' }], ...quiet], 3)
  await writeCp(q, cp0('g', { members: recordedAll(quiet), boardStatus: 'todo', boardStage: 'queue' } as never))
  dropBoard(q, s => s.id === 'm1')
  expect((await ticks(q, 3)).flat()).toEqual([])
  expect(await groupStatusNow(q)).toBe('todo')
  expect(sweepIssues((await q.guards.read()).sweep as never, q.clock.now)).toEqual([])
})

test('r3 B1 a rising group: the loop blocks the placeholder and the WARN text and guide explain how to release', async () => {
  const w = await restoredWorld()
  dropBoard(w, s => s.id === 'm1')
  const outs = (await tickN(w, 2)).flat()
  expect(outs.some(l => l.includes('(loop: blocked)'))).toBe(true)
  expect(await groupStatusNow(w)).toBe('blocked')
  const issues = sweepIssues((await w.guards.read()).sweep as never, w.clock.now)
  const loop = issues.find(i => i.id === 'sweep-loop')!
  expect(loop.text).toContain('sets its status back')
  expect(loop.guide).not.toContain('guarantee off')
})

// ══ r4: Haiku re-QA r3 (A1 header-forged owner, A2 open-member 500, A4 breaker text) ═════════════════════════════════════════════════
type RestDeps = { mode: 'legacy' | 'required'; grant?: string; browser?: { originOwn: boolean; sameOriginFetch: boolean } }
async function restRemove(w: W, id: string, d: RestDeps, body: Record<string, unknown> = {}) {
  const { removeSubtaskRequest } = await import('./web')
  return removeSubtaskRequest(id, { id, remove: true, ...body }, { principal: { kind: 'unattributed' } } as never, {
    remove: (sid, ctx) => removeVia(w, sid, ctx),
    principalDeps: {
      verify: async () => null,
      mode: async () => d.mode,
      browser: { loopbackPeer: true, originOwn: d.browser?.originOwn ?? true, sameOriginFetch: d.browser?.sameOriginFetch ?? true, grantHeader: d.grant ?? null },
      consumeGrant: (token: string) => (token === 'good-grant' ? { ok: true as const, grantId: 'grant-1' } : { ok: false as const, code: 'grant-invalid' }),
    },
    legacyOwnerGate: async () => null,
  })
}

test('r4 A1 (QA R6): no session + own Origin + same-origin in LEGACY mode does NOT remove an accepted member: 403 owner_proof_required, the member stays', async () => {
  const w = await acceptedWorld()
  const out = await restRemove(w, 'm0', { mode: 'legacy' })
  expect(out.status).toBe(403)
  expect(out.body).toMatchObject({ ok: false, reason: 'owner_proof_required' })
  const text = JSON.stringify(out.body)
  expect(text).toContain('accepted')
  expect(text).toContain('owner proof')
  expect(await sub(w, 'm0')).toBeTruthy()
  expect((await w.guards.read()).sweep?.ownerRemoved?.m0).toBeUndefined()
})

test('r4 A1 the owner removes an accepted member with the vault grant (any mode), recorded in the ledger; required mode with a verified owner too; required without a grant is refused', async () => {
  for (const mode of ['legacy', 'required'] as const) {
    const w = await acceptedWorld()
    const out = await restRemove(w, 'm0', { mode, grant: 'good-grant' })
    expect(out).toMatchObject({ status: 200, body: { ok: true } })
    expect(await sub(w, 'm0')).toBeUndefined()
    expect((await w.guards.read()).sweep?.ownerRemoved?.m0).toMatchObject({ groupId: 'g' })
  }
  const w = await acceptedWorld()
  expect((await restRemove(w, 'm0', { mode: 'required' })).status).toBe(403)
  expect((await restRemove(w, 'm0', { mode: 'required', grant: 'bad-grant' })).status).toBe(403)
  expect(await sub(w, 'm0')).toBeTruthy()
})

test('r4 A1 no browser headers at all keeps the plain 422 member_accepted; a session claim never reaches the owner path', async () => {
  const w = await acceptedWorld()
  const out = await restRemove(w, 'm0', { mode: 'legacy', browser: { originOwn: false, sameOriginFetch: false } })
  expect(out).toMatchObject({ status: 422, body: { ok: false, reason: 'member_accepted' } })
  expect(await sub(w, 'm0')).toBeTruthy()
})

test('r4 A1 defence in depth: the service door itself refuses an owner principal that is only the legacy-browser heuristic', async () => {
  const w = await acceptedWorld()
  expect(await removeVia(w, 'm0', OWNER)).toMatchObject({ ok: false, reason: 'owner_proof_required' })
  expect(await sub(w, 'm0')).toBeTruthy()
})

test('r4 A2: removing an OPEN member works for the owner and for the leader (no guard_context_required / 500)', async () => {
  // (a fourth member keeps the group open: closing a group is a guarded forward move of its own and is not what A2 is about)
  const ms = [member('m0', 'done'), member('m1', 'todo'), member('m2', 'todo'), member('m3', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms], 3)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  expect(await removeVia(w, 'm1', LEADER)).toBe(true)
  expect(await sub(w, 'm1')).toBeUndefined()
  expect(await removeVia(w, 'm2', VAULT_OWNER)).toBe(true)
  expect(await sub(w, 'm2')).toBeUndefined()
  // and through the REST door, in legacy mode with headers
  const w2 = await world([['g', { isGroup: true }], ...ms], 3)
  await writeCp(w2, cp0('g', { members: recordedAll(ms) } as never))
  expect(await restRemove(w2, 'm1', { mode: 'legacy' })).toMatchObject({ status: 200, body: { ok: true } })
})

test('r4 A2 (QA live 500): removing the member that holds a group open carries the caller\'s guard context: a 422 refusal with its own code, never guard_context_required', async () => {
  const ms = [member('m0', 'done'), member('m1', 'todo')]
  const w = await world([['g', { isGroup: true }], ...ms], 3)
  await writeCp(w, cp0('g', { members: recordedAll(ms) } as never))
  const out = await restRemove(w, 'm1', { mode: 'legacy' }, { session: undefined })
  expect(out.status).toBe(422)
  expect(JSON.stringify(out.body)).not.toContain('guard_context_required')
  expect(await sub(w, 'm1')).toBeTruthy() // the closing move was refused, so the piece is still there
})

test('r4 A2: a store error that is a guard refusal becomes a 4xx with a sentence, never a thrown 500', async () => {
  const { removeSubtaskRequest } = await import('./web')
  const { GuardRefused } = await import('./guard')
  const refusal = { code: 'guard_context_required', piece: 'm1', missing: ['a guard context'], message: 'no context', messagePt: 'sem contexto' }
  const out = await removeSubtaskRequest('m1', { id: 'm1', remove: true }, { principal: { kind: 'unattributed' } } as never, {
    remove: async () => { throw new GuardRefused(refusal as never) },
    principalDeps: { verify: async () => null }, legacyOwnerGate: async () => null,
  }).catch((e: unknown) => ({ status: 500, body: String(e) }))
  expect(out.status).toBe(422)
  expect(JSON.stringify(out.body)).toContain('no context')
})

test('r4 ATK-3 (expectation updated): dismissing the same placeholder twice answers no_such_subtask the second time (the piece is gone), nothing is re-created', async () => {
  const w = await restoredWorld()
  expect(await dismiss(w, 'm1', LEADER)).toEqual({ ok: true })
  // QA's probe expected `not_a_placeholder`; the r2-accepted behaviour (report item 0.d) is that the removed piece no longer exists, so 404 `no_such_subtask`.
  expect(await dismiss(w, 'm1', LEADER)).toMatchObject({ ok: false, reason: 'no_such_subtask' })
  expect(await sub(w, 'm1')).toBeUndefined()
})

test('r4 A4: no sweep text, health text or guide (breaker included) cites `guarantee off`', async () => {
  const memory = {
    reverts: { a: [ISO, ISO] }, warning: 'sweep-breaker: 9/10 pieces need a revert', forgedMarks: { f1: ISO }, noBaselineSince: { n1: new Date(T - 2 * 3600_000).toISOString() },
    unacceptedSince: { u1: new Date(T - 2 * 3600_000).toISOString() }, memberAlerts: { g: { at: ISO, text: 't', actions: ['member_removed'] } }, acceptedMissing: { m0: { groupId: 'g', at: ISO } },
  }
  for (const i of sweepIssues(memory, T)) { expect(i.text).not.toContain('guarantee off'); expect(i.guide).not.toContain('guarantee off') }
  const plan = sweepPlan as unknown as Record<string, unknown>
  for (const k of ['SWEEP_ESCAPE', 'SWEEP_ESCAPE_PT', 'LOOP_RELEASE', 'LOOP_RELEASE_PT', 'LOOP_BLOCK_TEXT']) expect(String(plan[k])).not.toContain('guarantee off')
  // the breaker WARN is built inline in sweep.ts: no executable line there may carry the escape either
  for (const f of ['sweep.ts', 'sweep-plan.ts']) {
    const code = readFileSync(join(import.meta.dir, f), 'utf8').split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect(code).not.toContain('guarantee off')
  }
})

// ══ r5: Haiku re-QA r4 (D1/D2): the PLACEHOLDER door applies the accepted-member rule BEFORE its placeholder branch ═══════════════════
/** An ACCEPTED member (m0, done, in the group's checkpoint) that ALSO carries an active ledger placeholder (the QA's fixture). */
async function acceptedPlaceholderWorld() {
  const w = await acceptedWorld()
  const doc = await w.guards.read()
  await w.guards.write({ ...doc, sweep: { ...(doc.sweep ?? { reverts: {} }), placeholders: { m0: { groupId: 'g', taskId: 't1', restoredAt: ISO, restorationId: 'rid-accepted-0001' } } } } as never)
  expect(await w.tasks.placeholderOf('m0')).toMatchObject({ groupId: 'g' })
  return w
}
async function restDismiss(w: W, id: string, d: RestDeps, ctx: unknown = { principal: { kind: 'unattributed' } }) {
  const { removeSubtaskRequest } = await import('./web')
  const web = await import('../sessions/task-web')
  return removeSubtaskRequest(id, { id, dismissPlaceholder: true }, ctx as never, {
    remove: async (sid, c) => { const out = await web.dismissPlaceholder(sid, c, dismissDeps(w) as never); return out.ok ? true : out },
    principalDeps: {
      verify: async () => null,
      mode: async () => d.mode,
      browser: { loopbackPeer: true, originOwn: d.browser?.originOwn ?? true, sameOriginFetch: d.browser?.sameOriginFetch ?? true, grantHeader: d.grant ?? null },
      consumeGrant: (token: string) => (token === 'good-grant' ? { ok: true as const, grantId: 'grant-1' } : { ok: false as const, code: 'grant-invalid' }),
    },
    legacyOwnerGate: async () => null,
  })
}

test('r5 D1 (QA): a LEADER with a valid session cannot dismiss an accepted member that also has a placeholder: member_accepted, the piece stays', async () => {
  const w = await acceptedPlaceholderWorld()
  for (const who of [LEADER, SESSION]) {
    expect(await dismiss(w, 'm0', who)).toMatchObject({ ok: false, reason: 'member_accepted' })
    expect(await sub(w, 'm0')).toBeTruthy()
  }
  expect(await dismiss(w, 'm0', undefined)).toMatchObject({ ok: false, reason: 'member_accepted' })
  expect(await sub(w, 'm0')).toBeTruthy()
  expect((await w.guards.read()).sweep?.placeholders?.m0?.dismissedAt).toBeUndefined()
})

test('r5 D2 (QA): a legacy-browser owner (headers only) cannot dismiss an accepted member through the placeholder door: owner_proof_required, the piece stays', async () => {
  const w = await acceptedPlaceholderWorld()
  expect(await dismiss(w, 'm0', OWNER)).toMatchObject({ ok: false, reason: 'owner_proof_required' })
  expect(await sub(w, 'm0')).toBeTruthy()
  expect((await w.guards.read()).sweep?.ownerRemoved?.m0).toBeUndefined()
})

test('r5 the vault-proven owner dismisses an accepted placeholder member and it is recorded like a remove (ownerRemoved), never restored', async () => {
  const w = await acceptedPlaceholderWorld()
  expect(await dismiss(w, 'm0', VAULT_OWNER)).toEqual({ ok: true })
  expect(await sub(w, 'm0')).toBeUndefined()
  expect((await w.guards.read()).sweep?.ownerRemoved?.m0).toMatchObject({ groupId: 'g' })
  expect((await ticks(w, 3)).flat()).toEqual([])
  expect(await sub(w, 'm0')).toBeUndefined()
})

test('r5 D1/D2 over REST: header owner → 403 owner_proof_required, session → 422 member_accepted, vault grant → 200 + ledger; the piece stays until then', async () => {
  const w = await acceptedPlaceholderWorld()
  const legacy = await restDismiss(w, 'm0', { mode: 'legacy' })
  expect(legacy.status).toBe(403)
  expect(legacy.body).toMatchObject({ ok: false, reason: 'owner_proof_required' })
  expect(await sub(w, 'm0')).toBeTruthy()
  expect((await restDismiss(w, 'm0', { mode: 'required' })).status).toBe(403)
  expect(await restDismiss(w, 'm0', { mode: 'legacy', browser: { originOwn: false, sameOriginFetch: false } })).toMatchObject({ status: 422, body: { reason: 'member_accepted' } })
  expect(await restDismiss(w, 'm0', { mode: 'legacy' }, LEADER)).toMatchObject({ status: 422, body: { reason: 'member_accepted' } })
  expect(await sub(w, 'm0')).toBeTruthy()
  expect(await restDismiss(w, 'm0', { mode: 'legacy', grant: 'good-grant' })).toMatchObject({ status: 200, body: { ok: true } })
  expect(await sub(w, 'm0')).toBeUndefined()
  expect((await w.guards.read()).sweep?.ownerRemoved?.m0).toMatchObject({ groupId: 'g' })
})

test('r5 the CLI door: a leader and a legacy owner cannot dismiss an accepted member; the vault-proven owner can', async () => {
  const { runSubtaskDismiss } = await import('../sessions/cli-task')
  const web = await import('../sessions/task-web')
  const log = console.log; console.log = () => {}
  try {
    const w = await acceptedPlaceholderWorld()
    const run = async (principal: unknown) => runSubtaskDismiss(['t1', 'm0', '--json'], { principal: async () => (principal as { principal: never }).principal, dismiss: (sid, g) => web.dismissPlaceholder(sid, g, dismissDeps(w) as never) })
    expect(await run(LEADER)).toBe(1)
    expect(await run(OWNER)).toBe(1)
    expect(await sub(w, 'm0')).toBeTruthy()
    expect(await run(VAULT_OWNER)).toBe(0)
    expect(await sub(w, 'm0')).toBeUndefined()
  } finally { console.log = log }
})

test('r5 the index no longer falls back to the legacy-browser owner for the placeholder door (source check)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  const at = src.indexOf('body.dismissPlaceholder === true')
  expect(at).toBeGreaterThan(0)
  const block = src.slice(at, src.indexOf('body.remove === true', at))
  expect(block).toContain('removeSubtaskRequest')
  expect(block).not.toContain("via: 'legacy-browser'")
})

test('r5 docs and restore text name no `guarantee off` escape', () => {
  const root = join(import.meta.dir, '..', '..', '..', '..')
  const doc = readFileSync(join(root, 'docs', 'delivery-store-guard.md'), 'utf8')
  expect(doc).not.toContain('flow guarantee off')
  const restore = readFileSync(join(import.meta.dir, '..', 'backup', 'restore.ts'), 'utf8')
  expect(restore).not.toMatch(/Turn the guarantee off|Desligue a garantia/)
})

// ══ r7: re-QA r5 (F1 delete of a task/group holding an accepted member, F2 reopen, F3 parentGroupId '', F4 path ref) ═════════════════════
const refusedWith = async (run: () => Promise<unknown>, code: string) => {
  const err = await run().then(() => null, (e: unknown) => e as { code?: string; status?: number })
  expect(err?.code).toBe(code)
  expect(err?.status).toBe(422)
}

test('r7 F1 store: deleting a task that holds an accepted member is refused for every non-owner-vault principal; nothing is deleted', async () => {
  const w = await acceptedWorld()
  for (const who of [LEADER, SESSION, OWNER, undefined, { principal: { kind: 'flow', engine: 'entrega' } } as never, { principal: { kind: 'unattributed' } } as never]) {
    await refusedWith(() => w.tasks.removeTask('t1', undefined, { guard: who ?? unattributedContext() }), 'accepted_members')
  }
  await refusedWith(() => w.tasks.removeTask('t1', undefined, { guard: unattributedContext() }), 'accepted_members')
  expect((await w.tasks.read()).tasks.some(t => t.id === 't1')).toBe(true)
  expect(await sub(w, 'm0')).toBeTruthy()
  expect((await w.guards.read()).sweep?.ownerRemoved).toBeUndefined()
})

test('r7 F1 store: only the vault-proven owner deletes it, and that delete is recorded in the ledger for the accepted member', async () => {
  const w = await acceptedWorld()
  const warn = console.warn; const warned: string[] = []; console.warn = (m: string) => { warned.push(String(m)) }
  try { expect(await w.tasks.removeTask('t1', undefined, { guard: VAULT_OWNER })).toBe(true) } finally { console.warn = warn }
  expect((await w.tasks.read()).tasks.some(t => t.id === 't1')).toBe(false)
  const ledger = (await w.guards.read()).sweep?.ownerRemoved ?? {}
  expect(Object.keys(ledger).sort()).toEqual(['m0'])
  expect(warned.join('\n')).toContain('m0')
})

test('r7 F1 store: a task with no accepted member is still deleted by anyone (the rule is only about accepted work)', async () => {
  const w = await world([['g', { isGroup: true }], member('m0', 'todo')], 1)
  expect(await w.tasks.removeTask('t1', undefined, { guard: LEADER })).toBe(true)
})

test('r7 F1 store: deleting a GROUP that holds an accepted member is refused for sessions, header owner and no context; the vault owner may', async () => {
  const w = await acceptedWorld()
  for (const who of [LEADER, SESSION, OWNER, undefined]) await refusedWith(() => w.tasks.removeSubtask('g', { guard: who ?? unattributedContext() }), 'accepted_members')
  expect(await sub(w, 'g')).toBeTruthy()
  expect(await w.tasks.removeSubtask('g', { guard: VAULT_OWNER })).toBe(true)
  expect(await sub(w, 'g')).toBeUndefined()
  expect(Object.keys((await w.guards.read()).sweep?.ownerRemoved ?? {}).sort()).toEqual(['m0'])
})

async function restDelete(w: W, d: RestDeps, ctx: unknown = { principal: { kind: 'unattributed' } }) {
  const { deleteTaskRequest } = await import('./web')
  return deleteTaskRequest('t1', {}, ctx as never, {
    del: async (_ref, c) => w.tasks.removeTask('t1', undefined, { guard: c }),
    principalDeps: {
      verify: async () => null, mode: async () => d.mode,
      browser: { loopbackPeer: true, originOwn: d.browser?.originOwn ?? true, sameOriginFetch: d.browser?.sameOriginFetch ?? true, grantHeader: d.grant ?? null },
      consumeGrant: (token: string) => (token === 'good-grant' ? { ok: true as const, grantId: 'grant-1' } : { ok: false as const, code: 'grant-invalid' }),
    },
  })
}

test('r7 F1 REST: DELETE /api/tasks/<ref> — session or no proof 422 accepted_members, header owner 403, required without grant 403, vault grant 200 + ledger', async () => {
  const w = await acceptedWorld()
  expect(await restDelete(w, { mode: 'legacy', browser: { originOwn: false, sameOriginFetch: false } })).toMatchObject({ status: 422, body: { reason: 'accepted_members' } })
  expect(await restDelete(w, { mode: 'legacy' }, LEADER)).toMatchObject({ status: 422, body: { reason: 'accepted_members' } })
  expect(await restDelete(w, { mode: 'legacy' })).toMatchObject({ status: 403, body: { reason: 'owner_proof_required' } })
  expect(await restDelete(w, { mode: 'required' })).toMatchObject({ status: 403 })
  expect(await restDelete(w, { mode: 'legacy', grant: 'bad-grant' })).toMatchObject({ status: 403 })
  expect((await w.tasks.read()).tasks.some(t => t.id === 't1')).toBe(true)
  expect(await restDelete(w, { mode: 'legacy', grant: 'good-grant' })).toMatchObject({ status: 200, body: { ok: true } })
  expect((await w.tasks.read()).tasks.some(t => t.id === 't1')).toBe(false)
  expect(Object.keys((await w.guards.read()).sweep?.ownerRemoved ?? {}).sort()).toEqual(['m0'])
})

test('r7 F1 doors: the index DELETE route, the MCP tool and every task delete funnel into the one guarded store delete (source check)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  const at = src.indexOf("req.method === 'DELETE') {", src.indexOf("startsWith('/api/tasks/') && req.method === 'DELETE'") - 1)
  const block = src.slice(at, src.indexOf("req.method === 'POST'", at))
  expect(block).toContain('deleteTaskRequest')
  const web = readFileSync(join(import.meta.dir, '..', 'sessions', 'task-web.ts'), 'utf8')
  expect(web).toContain('}, held), { guard })')
  const mcp = readFileSync(join(import.meta.dir, '..', '..', '..', 'mcp', 'agentistics-mcp.ts'), 'utf8')
  expect(mcp).toContain('apiSend("DELETE", `/api/tasks/${encodeURIComponent(ref)}`)')
  // no other caller of the store delete exists outside the guarded door and the tests
  for (const f of ['index.ts', 'sessions/cli-task.ts', 'sessions/task-web.ts']) {
    const text = readFileSync(join(import.meta.dir, '..', f), 'utf8')
    const calls = text.match(/store\.removeTask\(/g) ?? []
    expect(calls.length).toBe(f === 'sessions/task-web.ts' ? 1 : 0)
  }
})

const reopenOf = async (w: W, id: string, patch: Record<string, unknown>, guard?: unknown) => {
  const found = await sub(w, id)
  return w.tasks.upsertSubtask({ ...found, ...patch } as never, guard as never)
}

test('r7 F2 store: reopening an accepted member (done -> anything) is refused for sessions, header owner and no context; the piece stays done', async () => {
  const w = await acceptedWorld()
  for (const status of ['todo', 'in_progress', 'blocked']) {
    for (const who of [LEADER, SESSION, OWNER, undefined]) {
      await refusedWith(() => reopenOf(w, 'm0', { status, done: false, ...(status === 'blocked' ? { blockedReason: 'x' } : {}) }, who), 'accepted_reopen')
    }
  }
  expect((await sub(w, 'm0')).status).toBe('done')
})

test('r7 F2 store: the vault-proven owner reopens; a non-status edit of an accepted member (title) is not a reopen', async () => {
  const w = await acceptedWorld()
  await reopenOf(w, 'm0', { title: 'renamed' }, LEADER)
  expect((await sub(w, 'm0')).title).toBe('renamed')
  await reopenOf(w, 'm0', { status: 'todo', done: false }, VAULT_OWNER)
  expect((await sub(w, 'm0')).status).toBe('todo')
})

test('r7 F2 REST/MCP/CLI board edit: the door answers 422 with the guard code (patchSubtask), never 200', async () => {
  const w = await acceptedWorld()
  const web = await import('../sessions/task-web')
  const patch = async (p: Record<string, unknown>, g: unknown) => {
    const found = await sub(w, 'm0')
    const err = await w.tasks.upsertSubtask({ ...found, ...p } as never, g as never).then(() => null, (e: unknown) => e)
    const info = web.guardInfoOf(err)
    return info ? { ok: false, guard: info } : { ok: true }
  }
  expect(await patch({ status: 'todo', done: false }, LEADER)).toMatchObject({ ok: false, guard: { code: 'accepted_reopen', status: 422 } })
  expect((await sub(w, 'm0')).status).toBe('done')
})

test('r7 F3 store: leaving the group (`parentGroupId` cleared or moved) is refused on its own for an accepted member, with no classification involved', async () => {
  const w = await acceptedWorld()
  for (const who of [LEADER, SESSION, OWNER, undefined]) {
    await refusedWith(() => reopenOf(w, 'm0', { parentGroupId: undefined }, who), 'accepted_reopen')
  }
  expect((await sub(w, 'm0')).parentGroupId).toBe('g')
  // r8 C: the vault-proven owner leaves the group without guard A's classification (that exemption is for the vault owner alone).
  await reopenOf(w, 'm0', { parentGroupId: undefined }, VAULT_OWNER)
  expect((await sub(w, 'm0')).parentGroupId).toBeUndefined()
})

test('r7 F4: a subtask is reachable only through its own task path (the route refuses a foreign ref)', async () => {
  const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  expect(src).toContain('mod.subtaskPathCheck(ref, body.id)')
  expect(src).toContain('subtask_not_in_task')
})

// ══ r8: re-QA r7 findings ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('r8 B: removing an INDIVIDUAL accepted member at the store: refused with no opts, a session guard, the header owner; the vault owner removes and it is recorded', async () => {
  const w = await acceptedWorld()
  await refusedWith(() => w.tasks.removeSubtask('m0', { guard: unattributedContext() }), 'accepted_members')
  for (const who of [LEADER, SESSION, OWNER]) await refusedWith(() => w.tasks.removeSubtask('m0', { guard: who }), 'accepted_members')
  expect(await sub(w, 'm0')).toBeTruthy()
  expect(await w.tasks.removeSubtask('m0', { guard: VAULT_OWNER })).toBe(true)
  expect(await sub(w, 'm0')).toBeUndefined()
  expect(Object.keys((await w.guards.read()).sweep?.ownerRemoved ?? {})).toContain('m0')
})

test('r8 B: the composer door removes the cards it just created (never accepted) without a guard', async () => {
  const w = await world([['g', { isGroup: true }], member('c1', 'in_progress')], 3)
  expect(await w.tasks.removeSubtask('c1', { guard: unattributedContext() })).toBe(true)
})

test('r8 C: the vault owner reopens an accepted piece and moves it out of its group; a session and the header owner stay refused; the exemption covers ONLY accepted pieces', async () => {
  const w = await acceptedWorld()
  await reopenOf(w, 'm0', { status: 'in_progress', done: false }, VAULT_OWNER)
  expect((await sub(w, 'm0')).status).toBe('in_progress')
  const w1 = await acceptedWorld()
  await reopenOf(w1, 'm0', { parentGroupId: undefined }, VAULT_OWNER)
  expect((await sub(w1, 'm0')).parentGroupId).toBeUndefined()
  const w2 = await acceptedWorld()
  for (const who of [LEADER, SESSION, OWNER]) await refusedWith(() => reopenOf(w2, 'm0', { parentGroupId: undefined }, who), 'accepted_reopen')
  // a NON-accepted piece raised to done by anybody — the vault owner included — is still classified
  const w3 = await world([['solo']], 3)
  await refusedWith(() => reopenOf(w3, 'solo', { status: 'done', done: true }, VAULT_OWNER), 'classification_required')
  await refusedWith(() => reopenOf(w3, 'solo', { status: 'done', done: true }, LEADER), 'classification_required')
})

test('r8 D: a malformed %-escape on any task path answers 400, and the MCP tick (id + done + session) reaches the tick door', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  expect(src).toContain('function safeDecodePath')
  expect(src).not.toMatch(/= decodeURIComponent\(url\.pathname\.slice\('\/api\/(tasks|task-files)/)
  expect((src.match(/safeDecodePath\(url\.pathname\.slice\('\/api\/(tasks|task-files)/g) ?? []).length).toBe(8)
  expect(src).toContain("Object.keys(body).filter(k => k !== 'session').length === 2")
})

test('r9 D: a malformed %-escape on ANY /api path is a 400 bad_path before routing (every decodeURIComponent route, incl. task evidence), and handleRequest runs that gate first', async () => {
  const { badRequestTarget } = await import('../host-allow')
  const bad = '%E0%A4%A'
  const paths = [
    `/api/tasks/${bad}/evidence`, `/api/tasks/${bad}`, `/api/tasks/statuses/${bad}`, `/api/task-files/${bad}`,
    `/api/codex-sessions/${bad}`, `/api/gemini-sessions/${bad}`, `/api/copilot-sessions/${bad}`, `/api/checkin/${bad}`,
    `/api/session-groups/${bad}`, `/api/sessions/${bad}/handoff-panel`, `/api/sessions/${bad}/handoff-why`,
    `/api/memory/${bad}`, `/api/tags/${bad}`, `/api/flow/op/${bad}`, `/api/delivery/queue/${bad}`, `/api/accounts/${bad}/relogin`,
  ]
  const seen: Array<[string, number | null, string | null]> = []
  for (const p of paths) {
    const res = badRequestTarget(`http://127.0.0.1:47291${p}`, '127.0.0.1:47291')
    seen.push([p, res?.status ?? null, res ? (await res.json() as { error: string }).error : null])
  }
  expect(seen).toEqual(paths.map(p => [p, 400, 'bad_path']))
  expect(badRequestTarget('http://127.0.0.1:47291/api/tasks/a%20b/evidence', '127.0.0.1:47291')).toBeNull()
  const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  expect(src).not.toMatch(/evidenceRequest\(req\.method, decodeURIComponent/)
  expect(src).toContain('safeDecodePath(evidenceRoute[1]!)')
  expect(src.indexOf('badRequestTarget(req.url')).toBeGreaterThan(0)
})

test('r8 C: guard A honours the classification exemption ONLY for the vault-proven owner (direct guardedWrite: session, header owner and no context are still classified)', async () => {
  const { guardedWrite } = await import('./guard-host')
  const w = await world([['solo']], 3)
  const run = (ctx: unknown) => guardedWrite({
    raised: [{ key: 'solo', taskId: 't1', subtaskId: 'solo', rank: 4 }], ctx: ctx as never, exemptClassification: new Set(['solo']),
    paths: w.paths, locks: [], alreadyHeld: ['tasks', 'deliveries', 'guards'], wiring: { deps: { sessions: async () => [], git: execGit }, now: () => w.clock.now } as never,
    recordOf: async () => null, stateOf: () => ({ boardStatus: 'done', boardStage: 'published', phase: null }), writeDocuments: async () => {},
  } as never)
  for (const who of [LEADER, SESSION, OWNER]) await refusedWith(() => run(who), 'classification_required')
  await run(VAULT_OWNER)
})
