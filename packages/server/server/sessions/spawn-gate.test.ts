import { describe, expect, test } from 'bun:test'
import { decideSessionRole, sessaoComPapelHostOp, spawnGate, verifyBornRole, type SpawnFacts } from './spawn-gate'
import { currentLeaderId } from './team-links'

const lead = { kind: 'session' as const, id: 'lead' }
const facts = (f: Partial<SpawnFacts>): SpawnFacts => ({ door: 'cli-start', requestedBy: lead, harness: 'claude', ...f })

describe('op 1 sessao-com-papel (pure)', () => {
  test('acceptance 1: a leader opening a worker by session start, batch and fleet-spawn → worker, origin {leader}', () => {
    for (const door of ['cli-start', 'cli-batch', 'fleet-spawn'] as const) {
      expect(decideSessionRole(facts({ door, parentId: 'lead' }))).toEqual({ ok: true, role: 'worker', function: 'impl', origin: { leader: 'lead' } })
    }
  })
  test('acceptance 3: a session asking with no decidable role is refused; --role worker is accepted', () => {
    expect(decideSessionRole(facts({ door: 'cli-batch' }))).toMatchObject({ ok: false, code: 'role_required' })
    expect(decideSessionRole(facts({ door: 'cli-batch', role: 'worker' }))).toMatchObject({ ok: true, role: 'worker' })
    expect(decideSessionRole(facts({ door: 'flow', requestedBy: { kind: 'flow', name: 'trabalho-sem-commit' } }))).toMatchObject({ ok: true, role: 'worker', origin: { flow: 'trabalho-sem-commit' } })
  })
  test('acceptance 4: incoherent roles are refused — leader on a subtask, worker as a hand-off', () => {
    expect(decideSessionRole(facts({ role: 'leader', subtaskId: 's-1' }))).toMatchObject({ ok: false, code: 'leader_on_subtask' })
    expect(decideSessionRole(facts({ door: 'handoff', role: 'worker' }))).toMatchObject({ ok: false, code: 'worker_handoff' })
    expect(decideSessionRole(facts({ door: 'handoff' }))).toMatchObject({ ok: true, role: 'leader' })
    expect(decideSessionRole(facts({ door: 'handoff', inheritedRole: 'worker' }))).toMatchObject({ ok: true, role: 'worker' })
    expect(decideSessionRole(facts({ leaderPrefix: true }))).toMatchObject({ ok: true, role: 'leader' })
  })
  test('acceptance 5: the owner may open with no role (left unassigned, never invented)', () => {
    expect(decideSessionRole(facts({ requestedBy: { kind: 'owner' }, door: 'fleet-spawn' }))).toEqual({ ok: true, origin: 'owner' })
  })
  test('a reopen keeps the role it had, and never refuses a legacy row for having none', () => {
    expect(decideSessionRole(facts({ door: 'reopen', inheritedRole: 'leader', subtaskId: 's-1' }))).toMatchObject({ ok: true, role: 'leader' })
    expect(decideSessionRole(facts({ door: 'reopen' }))).toEqual({ ok: true, origin: { leader: 'lead' } })
  })
  test('a QA title makes a worker of function qa', () => {
    expect(decideSessionRole(facts({ parentId: 'lead', title: 'RE-QA 3 DSL (Codex)' }))).toMatchObject({ role: 'worker', function: 'qa' })
  })
  test('the host op answers refusals in the engine shape', async () => {
    expect(await sessaoComPapelHostOp()(facts({ door: 'cli-batch' }))).toMatchObject({ refused: true, missing: ['role_required'] })
  })
})

describe('spawnGate — engine run or op 1 here, fail closed', () => {
  const flows = (run: (n: string, i?: Record<string, unknown>) => Promise<unknown>, list = ['portao-de-spawn']) => ({ flows: async () => ({ list: () => list, run }) })
  test('flows off / no engine / an engine without the gate: op 1 here', async () => {
    expect(await spawnGate(facts({ parentId: 'lead' }), { flows: async () => null })).toMatchObject({ ok: true, role: 'worker' })
    expect(await spawnGate(facts({ door: 'cli-batch' }), flows(async () => { throw new Error('unused') }, ['worker-checar']))).toMatchObject({ ok: false, code: 'role_required' })
  })
  test('engine success carries the run id; op 1 refusal keeps its code; an H2/H4 refusal is gate_refused', async () => {
    expect(await spawnGate(facts({ parentId: 'lead' }), flows(async () => ({ runId: 'r1', status: 'success', output: { ok: true, role: 'worker', origin: { leader: 'lead' } } })))).toEqual({ ok: true, role: 'worker', function: 'impl', origin: { leader: 'lead' }, runId: 'r1' }) // the host's own decision, confirmed by the run
    expect(await spawnGate(facts({ door: 'cli-batch' }), flows(async () => ({ runId: 'r2', status: 'refused', refusal: { reason: 'role required' } })))).toMatchObject({ ok: false, code: 'role_required', runId: 'r2' })
    expect(await spawnGate(facts({ door: 'handoff' }), flows(async () => ({ runId: 'r3', status: 'refused', refusal: { reason: 'uncommitted work' } })))).toEqual({ ok: false, code: 'gate_refused', reason: 'uncommitted work', runId: 'r3' })
  })
  test('anything else REFUSES: a failed or interrupted run, a throwing run, an unreachable engine', async () => {
    for (const status of ['failed', 'interrupted', undefined]) {
      expect(await spawnGate(facts({ parentId: 'lead' }), flows(async () => ({ status })))).toMatchObject({ ok: false, code: 'gate_failed' })
    }
    expect(await spawnGate(facts({ parentId: 'lead' }), flows(async () => { throw new Error('boom') }))).toMatchObject({ ok: false, code: 'gate_failed' })
    expect(await spawnGate(facts({ parentId: 'lead' }), { flows: async () => { throw new Error('no engine') } })).toMatchObject({ ok: false, code: 'gate_failed' })
  })
})

test('post-spawn: the row is born with its role, re-asserted once, else reported for undo', async () => {
  let stored: string | undefined
  const d = (writes: boolean) => ({ stored: async () => stored as never, ensure: async () => { if (writes) stored = 'worker' } })
  stored = 'worker'; expect(await verifyBornRole(['c', 'id'], 'worker', d(false))).toBe(true)
  stored = undefined; expect(await verifyBornRole(['c', 'id'], 'worker', d(true))).toBe(true) // lost to a concurrent writer, written again
  stored = undefined; expect(await verifyBornRole(['c', 'id'], 'worker', d(false))).toBe(false) // cannot be recorded → undo
})

test('acceptance 6: a leader reopened with a NEW managed id still leads its team (supersedes)', () => {
  const rows = [
    { id: 'old', endedAt: '2026-10-30T01:00:00Z' },
    { id: 'new', supersedes: 'old' },
    { id: 'w', parentSessionId: 'old' },
  ]
  expect(currentLeaderId(rows, 'old')).toBe('new')
  // …and a hand-off after the reopen is still followed.
  expect(currentLeaderId([...rows.slice(0, 1), { id: 'new', supersedes: 'old', handoffTo: 'succ' }, { id: 'succ' }], 'old')).toBe('succ')
})
