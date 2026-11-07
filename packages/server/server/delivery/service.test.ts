import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryService, type DeliveryDeps } from './service'
import { createDeliveryStore } from './store'
import type { GateFacts, SessionFact } from './gates'
import type { DeliveryCi, Phase } from './machine'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'delivery-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface World {
  autonomous: boolean
  sessions: SessionFact[]
  releaseRuns: Array<{ databaseId: number; status: string; conclusion: string; headSha: string }>
  tags: Array<{ name: string; commit: { sha: string } }>
  prFiles: Array<{ filename: string; status: string }>
  checkRuns: Array<{ name: string; conclusion: string | null }>
  head: string
  memory: number
}

function harness(over: Partial<World> = {}, extra: Partial<DeliveryDeps> = {}) {
  const w: World = {
    autonomous: true,
    sessions: [
      { id: 'leader', harness: 'claude', model: 'claude-opus-5-5', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' },
      { id: 'author', harness: 'claude', model: 'claude-opus-5-5', role: 'worker', alive: true, cwd: '/r/.wt/a', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'impl', createdAt: '2026-11-07T00:00:00Z' },
      { id: 'qa', harness: 'claude', model: 'claude-sonnet-5-5', role: 'worker', alive: true, cwd: '/r/.wt/q', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'QA fluxo', createdAt: '2026-11-07T01:00:00Z' },
    ],
    releaseRuns: [], tags: [], prFiles: [{ filename: 'a.ts', status: 'modified' }], checkRuns: [], head: 'abc123', memory: 8 * 1024 ** 3,
    ...over,
  }
  const facts: GateFacts = {
    subtask: async id => (id === 's1' || id === 's2' ? { id, taskId: 't1', title: id, status: 'todo', groupMember: false, blockedBy: id === 's2' ? ['s1'] : [], staged: { prompt: 'do it', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1', cwd: '/r' } } : null),
    sessions: async () => w.sessions,
    budgets: async () => [{ harness: 'claude', account: 'acc_1', fiveHourPct: 20, weekPct: 30, stale: false }],
    memoryBytes: async () => w.memory,
    topCap: async () => 2,
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return `${w.head}\n`
      if (args[0] === 'status') return ''
      if (args[0] === 'symbolic-ref') return 'feat/x\n'
      if (args[0] === 'ls-remote') return `${w.head}\trefs/heads/feat/x\n`
      return ''
    },
    gh: async (_cwd, args) => {
      const a = args.join(' ')
      if (a.includes('check-runs')) return JSON.stringify({ check_runs: w.checkRuns })
      if (a.includes('/files')) return JSON.stringify(w.prFiles)
      if (a.startsWith('run list')) return JSON.stringify(w.releaseRuns)
      if (a.includes('/tags')) return JSON.stringify(w.tags)
      if (a.includes('/compare/')) return JSON.stringify({ status: 'ahead' })
      if (a.startsWith('pr view')) return JSON.stringify({ number: 7 })
      return '{}'
    },
  }
  const calls = { owner: [] as Array<{ text: string; kind: string }>, session: [] as Array<{ id: string; text: string }>, status: [] as Array<{ id: string; phase: Phase }>, ci: [] as Array<DeliveryCi | null>, steps: [] as number[], emits: [] as Array<{ type: string; payload: Record<string, unknown> }>, comments: [] as string[] }
  let now = Date.parse('2026-11-07T02:00:00Z')
  const svc = createDeliveryService({
    store: createDeliveryStore(join(dir, 'deliveries.json')),
    facts,
    board: {
      setPhaseStatus: async (id, phase) => { calls.status.push({ id, phase }); return { ok: true } },
      setCi: async (_id, ci) => { calls.ci.push(ci) },
      logStep: async (_t, _s, n) => { calls.steps.push(n) },
      comment: async (_t, _s, body) => { calls.comments.push(body) },
      subtaskFinished: async () => false,
      stage: async () => ({ ok: true }),
    },
    notify: {
      session: async (id, text) => { calls.session.push({ id, text }); return true },
      owner: async (text, kind) => { calls.owner.push({ text, kind }) },
    },
    autonomous: async () => w.autonomous,
    emit: async (type, payload) => { calls.emits.push({ type, payload }) },
    merge: async () => ({ ok: true, mergeSha: 'merge1', pr: 7 }),
    now: () => now,
    ...extra,
  })
  return { svc, w, calls, advance: (ms: number) => { now += ms } }
}

async function walkToQa(svc: ReturnType<typeof harness>['svc']) {
  await svc.configure('s1', { leaderSessionId: 'leader', versionTarget: '2.200.8' }, 'leader')
  expect((await svc.transition('s1', 'executando', {}, 'leader')).ok).toBe(true)
  const qa = await svc.transition('s1', 'qa', {}, 'author')
  expect(qa.ok).toBe(true)
}

describe('delivery service', () => {
  test('happy path end to end, gates run by the transition itself, every phase visited', async () => {
    const { svc, w, calls } = harness()
    await walkToQa(svc)
    expect((await svc.get('s1'))!.headSha).toBe('abc123')
    expect((await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: '12 tests green' }, 'qa')).ok).toBe(true)
    const rec = (await svc.get('s1'))!
    expect(rec.qaSha).toBe('abc123')
    expect(rec.gates['qa-modelo']!.evidence).toMatchObject({ authorModel: 'claude-opus-5-5', qaModel: 'claude-sonnet-5-5' })
    expect((await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123', detail: 'ok' }, 'leader')).ok).toBe(true)
    const merged = await svc.merge('s1', 'leader')
    expect(merged.ok && merged.record.phase).toBe('ci')
    expect((await svc.tick()).actions).toEqual([])
    w.releaseRuns = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'merge1' }]
    w.tags = [{ name: 'v2.200.8', commit: { sha: 'tagsha' } }]
    const t = await svc.tick()
    expect(t.actions[0]).toBe('publish s1:true')
    const final = (await svc.get('s1'))!
    expect(final.phase).toBe('publicado')
    expect(final.history.map(h => h.to)).toEqual(['executando', 'qa', 'revisao_lider', 'pr_merge', 'ci', 'publicado'])
    expect(calls.status.map(s => s.phase)).toEqual(['executando', 'qa', 'revisao_lider', 'pr_merge', 'ci', 'publicado'])
    expect(calls.emits.filter(e => e.type === 'entrega.etapa').map(e => e.payload.fase)).toEqual(['executando', 'qa', 'revisao_lider', 'pr_merge', 'ci', 'publicado'])
    expect(calls.ci.at(-1)).toEqual({ mergedMain: true, releaseGreen: true, tagPublished: true, tag: 'v2.200.8', pr: 7 })
    expect(calls.steps).toContain(1)
    // The owner hears ONE informational notice (published), never a decision.
    expect(calls.owner).toEqual([expect.objectContaining({ kind: 'aviso' })])
  })

  test('QA with the same model as the author is refused', async () => {
    const { svc, w } = harness()
    await walkToQa(svc)
    w.sessions[2]!.model = 'claude-opus-5-5'
    const r = await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'x' }, 'qa')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(422); expect(r.sentence).toContain('same model') }
  })

  test('never Sonnet over Sonnet', async () => {
    const { svc, w } = harness()
    w.sessions[1]!.model = 'claude-sonnet-5-5'
    w.sessions[2]!.model = 'claude-sonnet-4-6'
    await walkToQa(svc)
    const r = await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'x' }, 'qa')
    expect(!r.ok && r.sentence).toContain('Sonnet')
  })

  test('the owner print case through the service: 422 fase_pulada', async () => {
    const { svc } = harness()
    await svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await svc.transition('s1', 'executando', {}, 'leader')
    const r = await svc.transition('s1', 'revisao_lider', {}, 'leader')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(422); expect(r.code).toBe('fase_pulada') }
  })

  test('QA failure wakes the author with the findings; ajuste must go back through QA', async () => {
    const { svc, calls } = harness()
    await walkToQa(svc)
    expect((await svc.transition('s1', 'ajuste', { verdict: 'REPROVADO', findings: 'button misaligned' }, 'qa')).ok).toBe(true)
    expect(calls.session.at(-1)).toMatchObject({ id: 'author' })
    expect(calls.session.at(-1)!.text).toContain('button misaligned')
    expect((await svc.transition('s1', 'revisao_lider', {}, 'author')).ok).toBe(false)
    expect((await svc.transition('s1', 'qa', {}, 'author')).ok).toBe(true)
  })

  test('a merge that fails goes back to the leader review with the reason', async () => {
    const { svc, calls } = harness({}, { merge: async () => ({ ok: false, message: 'merge conflict in a.ts' }) })
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    const r = await svc.merge('s1', 'leader')
    expect(r.ok && r.record.phase).toBe('revisao_lider')
    expect(calls.session.at(-1)!.text).toContain('merge conflict')
  })

  test('a PR deleting a file outright never merges', async () => {
    const { svc, w } = harness({ prFiles: [{ filename: 'keep.ts', status: 'removed' }] })
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    const r = await svc.merge('s1', 'leader')
    expect(r.ok && r.record.phase).toBe('revisao_lider')
    expect(r.ok && r.record.history.at(-1)!.detail).toContain('keep.ts')
    void w
  })

  test('release that fails goes back to the leader review', async () => {
    const { svc, w } = harness()
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    await svc.merge('s1', 'leader')
    w.releaseRuns = [{ databaseId: 2, status: 'completed', conclusion: 'failure', headSha: 'merge1' }]
    await svc.tick()
    expect((await svc.get('s1'))!.phase).toBe('revisao_lider')
  })

  test('the vaga gate refuses past the 4-worker machine ceiling and below 3 GB', async () => {
    const extra: SessionFact[] = [1, 2, 3, 4].map(i => ({ id: `w${i}`, harness: 'codex', role: 'worker', alive: true, cwd: '/x', worktree: true }))
    const { svc, w } = harness()
    w.sessions = [...w.sessions.filter(s => s.role === 'leader'), ...extra]
    const r = await svc.transition('s1', 'executando', {}, 'leader')
    expect(!r.ok && r.sentence).toContain('machine ceiling')
    w.sessions = w.sessions.filter(s => s.role === 'leader'); w.memory = 1024 ** 3
    const m = await svc.transition('s1', 'executando', {}, 'leader')
    expect(!m.ok && m.sentence).toContain('3 GB')
  })

  test('block returns to the origin phase; the leader is woken, the owner never in autonomous mode', async () => {
    const { svc, calls, advance } = harness()
    await walkToQa(svc)
    const b = await svc.block('s1', 'externo', 'GitHub Actions down', 'leader')
    expect(b.ok && b.record.phase).toBe('bloqueado')
    expect(calls.session.at(-1)!.id).toBe('leader')
    advance(31 * 60_000)
    expect((await svc.tick()).actions).toEqual(['wake s1'])
    advance(2 * 3600_000)
    expect((await svc.tick()).actions).toEqual(['defer s1'])
    expect((await svc.get('s1'))!.versionTarget).toBe('next')
    const u = await svc.unblock('s1', 'leader', 'GitHub back')
    expect(u.ok && u.record.phase).toBe('qa')
    expect(calls.owner).toEqual([])
  })

  test('autonomous ON: an owner decision request becomes the leader\'s safe path; nothing reaches the owner', async () => {
    const { svc, calls } = harness()
    await walkToQa(svc)
    const b = await svc.block('s1', 'decisao_do_dono', 'needs the Apple subscription', 'leader')
    expect(b.ok && b.record.block!.reason).toBe('fora_das_autorizacoes')
    expect(b.ok && b.record.block!.deferredAt).toBeTruthy()
    expect(calls.owner).toEqual([])
  })

  test('autonomous OFF: an owner decision reaches the owner as a decision', async () => {
    const { svc, calls } = harness({ autonomous: false })
    await walkToQa(svc)
    const b = await svc.block('s1', 'fora_das_autorizacoes', 'spend money', 'leader')
    expect(b.ok && b.record.block!.reason).toBe('decisao_do_dono')
    expect(calls.owner).toEqual([expect.objectContaining({ kind: 'decisao' })])
  })

  describe('human gates', () => {
    async function toReview(autonomous: boolean) {
      const h = harness({ autonomous })
      await h.svc.configure('s1', { humanGates: ['pr_merge'] }, 'leader')
      await walkToQa(h.svc)
      await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
      return h
    }
    test('autonomous ON skips and records "pulado: modo autônomo"', async () => {
      const { svc, calls } = await toReview(true)
      const r = await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
      expect(r.ok && r.record.skips).toEqual([expect.objectContaining({ phase: 'pr_merge', outcome: 'pulado: modo autônomo' })])
      expect(calls.comments.at(-1)).toContain('pulado: modo autônomo')
      expect(calls.owner.filter(o => o.kind === 'decisao')).toEqual([])
    })
    test('autonomous OFF asks the owner, waits (409), proceeds on approval; a session cannot approve', async () => {
      const { svc, calls } = await toReview(false)
      const waiting = await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
      expect(!waiting.ok && waiting.status).toBe(409)
      expect(calls.owner.at(-1)!.kind).toBe('decisao')
      expect((await svc.approve('s1', 'pr_merge', 'approve', undefined, false)).ok).toBe(false)
      expect((await svc.approve('s1', 'pr_merge', 'approve', 'go', true)).ok).toBe(true)
      expect((await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
    })
  })

  test('a dependency unblocks itself once its sibling is published', async () => {
    const { svc, w } = harness()
    expect((await svc.block('s2', 'dependencia', 'waits for s1', 'leader')).ok).toBe(true)
    expect((await svc.tick()).actions).toEqual([])
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    await svc.merge('s1', 'leader')
    w.releaseRuns = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'merge1' }]
    w.tags = [{ name: 'v2.200.8', commit: { sha: 'merge1' } }]
    await svc.tick()
    expect((await svc.tick()).actions).toEqual(['unblock s2'])
    expect((await svc.get('s2'))!.phase).toBe('fila')
  })

  test('stage writes the pre-dispatch and records the predispatch gate', async () => {
    const { svc, calls } = harness()
    const r = await svc.stage('s1', { prompt: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }, 'leader', { leaderSessionId: 'leader', pedidoId: 'p-1' })
    expect(r.ok && r.record.gates.predispatch!.ok).toBe(true)
    expect(calls.emits.find(e => e.type === 'subtarefa.preparada')!.payload).toMatchObject({ subtarefa: 's1', pedido: 'p-1' })
  })
})
