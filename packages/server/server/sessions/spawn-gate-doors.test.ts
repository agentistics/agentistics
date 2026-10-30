import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { batch, start } from './cli-session'
import { parseSessionArgs } from './cli-parse'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { createDelegateMembers } from '../engine/engine-delegate'
import { decideSessionRole, spawnGate, type SpawnFacts, type SpawnGateAnswer } from './spawn-gate'
import { listTasks } from './task-web'
import type { SessionBackend } from './types'

/** QA F4 — the gate through the REAL doors (start, batch, the engine delegate), plus the F5/F6 gate edges. */
const saved = process.env.AGENTOP_MANAGED_ID
beforeAll(() => __setHarnessAgentsReaderForTest(async () => []))
afterAll(() => __setHarnessAgentsReaderForTest(null))
afterEach(() => { if (saved === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = saved })

const backend = () => {
  const spawned: string[] = []
  const b = {
    id: 'tmux', unavailable: async () => undefined, list: async () => [],
    spawn: async (req: { id: string }) => { spawned.push(req.id) }, capture: async () => [], kill: async () => true,
  } as unknown as SessionBackend
  return { b, spawned }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, err = console.error, errs: string[] = []
  console.log = () => {}; console.error = (...a: unknown[]) => { errs.push(a.join(' ')) }
  try { return await fn() } finally { console.log = log; console.error = err }
}
const refusing = (seen: SpawnFacts[]) => async (f: SpawnFacts): Promise<SpawnGateAnswer> => { seen.push(f); return { ok: false, code: 'gate_refused', reason: 'refused by the test gate' } }

describe('start() — the real CLI door', () => {
  test('the owner (no session identity) is judged as the owner at door cli-start; a refusal spawns nothing', async () => {
    delete process.env.AGENTOP_MANAGED_ID
    const seen: SpawnFacts[] = []
    const { b, spawned } = backend()
    const cmd = parseSessionArgs(['claude', '--bg', '--force', '--cwd', process.cwd(), '-p', 'x'])
    if (cmd.kind !== 'start') throw new Error('not a start')
    expect(await quiet(() => start(cmd, b, { settleMs: 20, spawnGate: refusing(seen) }))).toBe(1)
    expect(seen).toEqual([expect.objectContaining({ door: 'cli-start', requestedBy: { kind: 'owner' } })])
    expect(spawned).toEqual([])
  })
  test('a CLAIMED but unproven session identity is refused before the gate — never taken as the owner', async () => {
    process.env.AGENTOP_MANAGED_ID = 'forged-lead'
    const seen: SpawnFacts[] = []
    const { b, spawned } = backend()
    const cmd = parseSessionArgs(['claude', '--bg', '--force', '--role', 'leader', '--cwd', process.cwd(), '-p', 'x'])
    if (cmd.kind !== 'start') throw new Error('not a start')
    expect(await quiet(() => start(cmd, b, { settleMs: 20, spawnGate: refusing(seen) }))).toBe(1)
    expect(seen).toEqual([])
    expect(spawned).toEqual([])
  })
})

describe('batch() — the gate runs before the memory gate and the task book (QA F2/F7)', () => {
  test('a refused batch creates no task, no attempt and spawns nothing', async () => {
    delete process.env.AGENTOP_MANAGED_ID
    const title = `QA-F2 batch ${Date.now()}`
    const before = JSON.stringify(await listTasks())
    const seen: SpawnFacts[] = []
    const { b, spawned } = backend()
    const cmd = parseSessionArgs(['batch', '--task', title, '--session', 'claude: a', '--attempt', 'A1', '--session', 'codex: b'])
    if (cmd.kind !== 'batch') throw new Error('not a batch')
    expect(await quiet(() => batch(cmd, b, { spawnGate: refusing(seen) }))).toBe(1)
    expect(seen.map(f => f.door)).toEqual(['cli-batch', 'cli-batch'])
    expect(spawned).toEqual([])
    const after = JSON.stringify(await listTasks())
    expect(after).toBe(before)
    expect(after).not.toContain(title)
  })
})

describe('the engine delegate — an agent, never the owner (QA F1)', () => {
  test('delegateSpawn asks the fleet with door engine and the task it will be filed on', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const m = createDelegateMembers({
      startable: async () => ['codex'], allowed: async () => ['codex'],
      spawn: async body => { bodies.push(body as never); return { ok: true, message: 'ok', id: 'm-1' } },
      file: async () => ({ ok: true }), kill: async () => {}, chat: async () => ({ turns: [], live: false }),
    })
    const r = await m.delegateSpawn({ harness: 'codex', cwd: '/w', prompt: 'brief', model: 'm', label: 'L', taskId: 't-1', subtaskId: 's-1' } as never)
    expect(r).toMatchObject({ ok: true })
    expect(bodies[0]).toMatchObject({ door: 'engine', gateTaskId: 't-1', gateSubtaskId: 's-1', callerVerified: true })
    expect(decideSessionRole({ door: 'engine', requestedBy: { kind: 'engine' }, harness: 'codex', taskId: 't-1', subtaskId: 's-1' }))
      .toEqual({ ok: true, role: 'worker', function: 'impl', origin: { flow: 'engine' } })
  })
})

describe('spawnGate fail-closed edges (QA F5) and the resumed role (QA F6)', () => {
  const f: SpawnFacts = { door: 'cli-start', requestedBy: { kind: 'session', id: 'lead' }, harness: 'claude', parentId: 'lead' }
  const engine = (run: () => Promise<unknown>, list: () => string[] = () => ['portao-de-spawn']) => ({ flows: async () => ({ list, run }) })
  test('a success with no decision, ok:false, or a disagreeing role refuses; a throwing list() refuses (never throws)', async () => {
    expect(await spawnGate(f, engine(async () => ({ status: 'success', output: {} })))).toMatchObject({ ok: false, code: 'gate_failed' })
    expect(await spawnGate(f, engine(async () => ({ status: 'success', output: { ok: false } })))).toMatchObject({ ok: false, code: 'gate_failed' })
    expect(await spawnGate(f, engine(async () => ({ status: 'success', output: { ok: true, role: 'leader' } })))).toMatchObject({ ok: false, code: 'gate_failed' })
    expect(await spawnGate(f, engine(async () => ({ status: 'success', output: { ok: true, role: 'worker' } })))).toMatchObject({ ok: true, role: 'worker' })
    expect(await spawnGate(f, engine(async () => ({}), () => { throw new Error('list boom') }))).toMatchObject({ ok: false, code: 'gate_failed' })
  })
  test('QA ORQ.H2 F3: an H2 refusal carries the missing pedido ids to the door message', async () => {
    const hand: SpawnFacts = { door: 'handoff', requestedBy: { kind: 'session', id: 'lead' }, harness: 'claude', taskId: 't-1' }
    const r = await spawnGate(hand, engine(async () => ({ runId: 'r9', status: 'refused', refusal: { reason: 'the manual hand-off omits requests', missing: ['p-bbbb2222', 'p-cccc3333'] } })))
    expect(r).toMatchObject({ ok: false, code: 'gate_refused', missing: ['p-bbbb2222', 'p-cccc3333'], runId: 'r9' })
    expect(r.ok ? '' : r.reason).toContain('p-bbbb2222, p-cccc3333')
    const said = await spawnGate(hand, engine(async () => ({ status: 'refused', refusal: { reason: 'omits (p-x)', missing: ['p-x'] } })))
    expect(said.ok ? '' : said.reason).toBe('omits (p-x)')
  })
  test('a resumed conversation stored with one role, asked with another, is refused before any spawn', () => {
    expect(decideSessionRole({ ...f, door: 'fleet-spawn', inheritedRole: 'worker', role: 'leader' })).toMatchObject({ ok: false, code: 'role_conflict' })
    expect(decideSessionRole({ ...f, door: 'fleet-spawn', inheritedRole: 'worker' })).toMatchObject({ ok: true, role: 'worker' })
  })
  test('the owner filing a worker under a leader (an unproven parent link from the UI) gets a worker', () => {
    expect(decideSessionRole({ door: 'fleet-spawn', requestedBy: { kind: 'owner' }, harness: 'claude', parentId: 'lead' })).toMatchObject({ ok: true, role: 'worker', origin: 'owner' })
  })
})
