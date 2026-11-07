import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryService, type DeliveryDeps } from './service'
import { createDeliveryStore } from './store'
import type { GateFacts, SessionFact } from './gates'
import { PHASE_STATUS, type DeliveryCi, type Phase } from './machine'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'delivery-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface World {
  autonomous: boolean
  sessions: SessionFact[]
  releaseRuns: Array<{ databaseId: number; status: string; conclusion: string; headSha: string; updatedAt?: string }>
  tags: Array<{ name: string; commit: { sha: string } }>
  prFiles: Array<{ filename: string; status: string }>
  checkRuns: Array<{ name: string; conclusion: string | null }>
  /** What gh says about the PR (`pr view --json number,state,headRefOid,mergeCommit`). */
  pr: { number: number; state: string; headRefOid: string; mergeCommit: { oid: string } | null }
  /** `compare/<merge>...main` status. */
  onMain: string
  /** The branch tip as `ls-remote` answers (defaults to `head`). */
  remoteHead?: string
  /** The board status the subtask is found in. */
  status?: string
  /** Model the host's board projection, including publicado → done. */
  projectPhaseStatus?: boolean
  /** false = the leader cannot be reached. */
  wakeOk?: boolean
  /** gh failure for the check-runs read. */
  checksError?: boolean
  head: string
  memory: number
  /** `gh run list` only answers when it is pointed at THIS repository (`-R owner/name`); another one has no release.yml runs. */
  runsRepo?: string
  /** Commit shas the tag does NOT contain (`compare/<sha>...<tag>` answers diverged): later releases' runs. */
  notContained?: string[]
  /** short sha → the full one git resolves it to (`rev-parse --verify <sha>^{commit}`). */
  fullShas?: Record<string, string>
}

function harness(over: Partial<World> = {}, extra: Partial<DeliveryDeps> = {}) {
  const statuses = new Map<string, string>()
  const w: World = {
    autonomous: true,
    sessions: [
      { id: 'leader', harness: 'claude', model: 'claude-opus-5-5', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' },
      { id: 'author', harness: 'claude', model: 'claude-opus-5-5', role: 'worker', alive: true, cwd: '/r/.wt/a', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'impl', createdAt: '2026-11-07T00:00:00Z' },
      { id: 'qa', harness: 'claude', model: 'claude-sonnet-5-5', role: 'worker', alive: true, cwd: '/r/.wt/q', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'QA fluxo', createdAt: '2026-11-07T01:00:00Z' },
    ],
    releaseRuns: [], tags: [], prFiles: [{ filename: 'a.ts', status: 'modified' }], checkRuns: [{ name: 'ci', conclusion: 'success' }],
    pr: { number: 7, state: 'MERGED', headRefOid: 'abc123', mergeCommit: { oid: 'merge1' } }, onMain: 'ahead', head: 'abc123', memory: 8 * 1024 ** 3,
    ...over,
  }
  const facts: GateFacts = {
    subtask: async id => (id === 's1' || id === 's2' || id === 's3' ? { id, taskId: id === 's3' ? 't2' : 't1', title: id, status: statuses.get(id) ?? w.status ?? 'todo', groupMember: false, blockedBy: id === 's2' ? ['s1'] : [], staged: { prompt: 'do it', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1', cwd: '/r' } } : null),
    sessions: async () => w.sessions,
    budgets: async () => [{ harness: 'claude', account: 'acc_1', fiveHourPct: 20, weekPct: 30, stale: false }],
    memoryBytes: async () => w.memory,
    topCap: async () => 2,
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') { const full = w.fullShas?.[args[2]!.replace('^{commit}', '')]; if (full) return `${full}\n`; throw new Error('fatal: Needed a single revision') }
      if (args[0] === 'rev-parse') return `${w.head}\n`
      if (args[0] === 'status') return ''
      if (args[0] === 'symbolic-ref') return 'feat/x\n'
      if (args[0] === 'ls-remote') return `${w.remoteHead ?? w.head}\trefs/heads/feat/x\n`
      return ''
    },
    repoCwd: async () => '/r',
    gh: async (_cwd, args) => {
      const a = args.join(' ')
      calls.gh.push(a)
      calls.ghCwd.push(_cwd)
      if (a.includes('check-runs') && w.checksError) throw new Error('gh: HTTP 502')
      if (a.includes('check-runs')) return JSON.stringify({ check_runs: w.checkRuns })
      if (a.includes('/files')) return JSON.stringify(w.prFiles)
      if (a.startsWith('run list')) return JSON.stringify(w.runsRepo && !a.includes(`-R ${w.runsRepo}`) ? [] : w.releaseRuns)
      // gh api repos/<o>/<r>/git/ref/tags/<name>: the tag by its exact name (404 → gh exits non-zero).
      if (a.includes('/git/ref/tags/')) {
        if (w.runsRepo && !a.includes(`repos/${w.runsRepo}/`)) throw new Error('gh: HTTP 404')
        const t = w.tags.find(x => a.endsWith(`/git/ref/tags/${x.name}`))
        if (!t) throw new Error('gh: HTTP 404')
        return JSON.stringify({ ref: `refs/tags/${t.name}`, object: { sha: t.commit.sha, type: 'commit' } })
      }
      if (a.includes('/tags')) return JSON.stringify(w.tags)
      if (a.includes('/compare/') && a.includes('...main')) return JSON.stringify({ status: w.onMain })
      if (a.includes('/compare/')) return JSON.stringify({ status: w.notContained?.some(s => a.includes(`/compare/${s}...`)) ? 'diverged' : 'ahead' })
      if (a.startsWith('pr view')) return JSON.stringify(w.pr)
      return '{}'
    },
  }
  const calls = { gh: [] as string[], ghCwd: [] as string[], owner: [] as Array<{ text: string; kind: string }>, session: [] as Array<{ id: string; text: string }>, status: [] as Array<{ id: string; phase: Phase }>, ci: [] as Array<DeliveryCi | null>, steps: [] as number[], emits: [] as Array<{ type: string; payload: Record<string, unknown> }>, comments: [] as string[] }
  let now = Date.parse('2026-11-07T02:00:00Z')
  const svc = createDeliveryService({
    store: createDeliveryStore(join(dir, 'deliveries.json')),
    facts,
    board: {
      setPhaseStatus: async (id, phase) => { calls.status.push({ id, phase }); if (w.projectPhaseStatus) statuses.set(id, PHASE_STATUS[phase].id); return { ok: true } },
      setCi: async (_id, ci) => { calls.ci.push(ci) },
      logStep: async (_t, _s, n) => { calls.steps.push(n) },
      comment: async (_t, _s, body) => { calls.comments.push(body) },
      subtaskFinished: async () => false,
      stage: async () => ({ ok: true }),
    },
    notify: {
      session: async (id, text) => { calls.session.push({ id, text }); return w.wakeOk !== false },
      owner: async (text, kind) => { calls.owner.push({ text, kind }) },
    },
    autonomous: async () => w.autonomous,
    emit: async (type, payload) => { calls.emits.push({ type, payload }) },
    merge: async () => ({ ok: true, mergeSha: 'merge1', pr: 7 }),
    now: () => now,
    ...extra,
  })
  return { svc, w, calls, facts, advance: (ms: number) => { now += ms } }
}

async function walkToQa(svc: ReturnType<typeof harness>['svc']) {
  await svc.configure('s1', { leaderSessionId: 'leader', versionTarget: '2.200.8' }, 'leader')
  expect((await svc.transition('s1', 'executando', {}, 'leader')).ok).toBe(true)
  const qa = await svc.transition('s1', 'qa', {}, 'author')
  expect(qa.ok).toBe(true)
}

describe('delivery service', () => {
  test('happy path end to end, gates run by the transition itself, every phase visited', async () => {
    const { svc, w, calls, advance } = harness()
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
    advance(61_000) // the ci poll backs off between reads
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

test('two concurrent ticks wake the leader once (the tick is serialised)', async () => {
  const { svc, calls, advance } = harness()
  await walkToQa(svc)
  await svc.block('s1', 'limite', 'conta em 90%', 'leader')
  const wakesBefore = calls.session.length
  advance(31 * 60_000)
  const [a, b] = await Promise.all([svc.tick(), svc.tick()])
  expect([...a.actions, ...b.actions]).toEqual(['wake s1'])
  expect(calls.session.length - wakesBefore).toBe(1)
})


// ------------------------------------------------------------------------------------- QA fix round (07/11)

async function toPrMerge(h: ReturnType<typeof harness>) {
  await walkToQa(h.svc)
  expect((await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')).ok).toBe(true)
  await h.svc.configure('s1', { pr: 7 }, 'leader')
  expect((await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
}

describe('H1 — the merge is verified on the host', () => {
  test('a caller-supplied merge sha with no merged PR does not reach ci', async () => {
    const h = harness({ pr: { number: 7, state: 'OPEN', headRefOid: 'abc123', mergeCommit: null } })
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', { mergeSha: 'deadbeef-never-merged' }, 'worker')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.sentence).toContain('mergeado'); expect(r.sentence).toContain('not merged') }
    expect((await h.svc.get('s1'))!.phase).toBe('pr_merge')
  })
  test('a merged PR whose merge commit is not on origin/main is refused', async () => {
    const h = harness({ onMain: 'behind' })
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', {}, 'leader')
    expect(!r.ok && r.sentence).toContain('not on origin/main')
  })
  test('a PR merged from a head other than the sha QA approved is refused', async () => {
    const h = harness({ pr: { number: 7, state: 'MERGED', headRefOid: 'other999', mergeCommit: { oid: 'merge1' } } })
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', {}, 'leader')
    expect(!r.ok && r.sentence).toContain('not the sha QA approved')
  })
  test('the merge sha is the PR\'s, whatever the caller states', async () => {
    const h = harness()
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', { mergeSha: 'caller-made-up' }, 'worker')
    expect(r.ok && r.record.mergeSha).toBe('merge1')
  })
})

describe('H2 — the QA and the author come from the registry, not from a caller', () => {
  const world = () => ({
    sessions: [
      { id: 'leader', harness: 'claude', model: 'claude-opus-5-5', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' },
      { id: 'author', harness: 'claude', model: 'claude-sonnet-5-5', role: 'worker', alive: true, cwd: '/r/.wt/a', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'impl' },
      { id: 'qa', harness: 'claude', model: 'claude-sonnet-4-6', role: 'worker', alive: true, cwd: '/r/.wt/q', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'QA x' },
      { id: 'rand', harness: 'claude', model: 'claude-haiku-5-5', role: 'worker', alive: true, cwd: '/x', worktree: true, rootPath: '/x', taskId: 't2', subtaskId: 'other', label: 'whatever' },
    ] as SessionFact[],
  })
  test('configure ignores qaSessionId / authorSessionId (Sonnet over Sonnet still refused)', async () => {
    const h = harness(world())
    await walkToQa(h.svc)
    await h.svc.configure('s1', { qaSessionId: 'rand', authorSessionId: 'rand' }, 'leader')
    const rec = (await h.svc.get('s1'))!
    expect(rec.qaSessionId).toBeUndefined()
    expect(rec.authorSessionId).toBe('author')
    const r = await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'x' }, 'qa')
    expect(!r.ok && r.sentence).toContain('Sonnet')
  })
  test('a session of another subtask never stands for the QA, even when recorded', async () => {
    const { qaOf, authorOf } = await import('./gates')
    const { newDelivery } = await import('./machine')
    const r = { ...newDelivery({ subtaskId: 's1', taskId: 't1', at: 'x' }), qaSessionId: 'rand', authorSessionId: 'rand' }
    expect(qaOf(r, world().sessions)).toBeNull()
    expect(authorOf(r, world().sessions)).toBeNull()
  })
  test('the leader is neither author nor QA', async () => {
    const { qaOf } = await import('./gates')
    const { newDelivery } = await import('./machine')
    const s = world().sessions.map(x => (x.id === 'leader' ? { ...x, subtaskId: 's1', label: 'QA lead' } : x))
    expect(qaOf(newDelivery({ subtaskId: 's1', taskId: 't1', at: 'x' }), s)!.id).toBe('qa')
  })
  test('a worker session cannot configure; the leader of the task and the owner can', async () => {
    const h = harness()
    const worker = await h.svc.configure('s1', { versionTarget: '9.9.9' }, 'author')
    expect(!worker.ok && worker.status).toBe(403)
    expect((await h.svc.configure('s1', { versionTarget: '2.200.8' }, 'leader')).ok).toBe(true)
    expect((await h.svc.configure('s1', { versionTarget: '2.200.9' }, 'owner')).ok).toBe(true)
  })
})

describe('H3 — salvo reads the real check runs', () => {
  test('pending check runs refuse', async () => {
    const h = harness({ checkRuns: [{ name: 'ci', conclusion: 'success' }, { name: 'e2e', conclusion: null }] })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await h.svc.transition('s1', 'executando', {}, 'leader')
    const r = await h.svc.transition('s1', 'qa', {}, 'author')
    expect(!r.ok && r.sentence).toContain('pending')
  })
  test('no check run at all refuses', async () => {
    const h = harness({ checkRuns: [] })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await h.svc.transition('s1', 'executando', {}, 'leader')
    const r = await h.svc.transition('s1', 'qa', {}, 'author')
    expect(!r.ok && r.sentence).toContain('no check run')
  })
  test('an unreadable check-runs source refuses (fail closed)', async () => {
    const h = harness({ checksError: true })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await h.svc.transition('s1', 'executando', {}, 'leader')
    const r = await h.svc.transition('s1', 'qa', {}, 'author')
    expect(!r.ok && r.sentence).toContain('could not be read')
  })
  test('green runs pass and the evidence no longer claims a hook was checked', async () => {
    const h = harness()
    await walkToQa(h.svc)
    const ev = (await h.svc.get('s1'))!.gates.salvo!.evidence!
    expect(ev.checks).toBe('passed')
    expect(JSON.stringify(ev)).not.toContain('pre-commit')
  })
})

describe('M1 — HEAD must not have moved since QA', () => {
  test('a push after QA blocks revisao_lider → pr_merge', async () => {
    const h = harness()
    await walkToQa(h.svc)
    await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    h.w.remoteHead = 'pushed-after-qa'
    const r = await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    expect(!r.ok && r.sentence).toContain('cabeca')
    h.w.remoteHead = undefined
    expect((await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
  })
})

describe('M2 — who may unblock', () => {
  test('a worker cannot lift a leader block; the leader can', async () => {
    const h = harness()
    await walkToQa(h.svc)
    await h.svc.block('s1', 'externo', 'gh down', 'leader')
    const w = await h.svc.unblock('s1', 'author', 'trust me')
    expect(!w.ok && w.status).toBe(403)
    expect((await h.svc.unblock('s1', 'leader', 'back')).ok).toBe(true)
  })
  test('an owner-decision block is lifted only by the owner (autonomous OFF)', async () => {
    const h = harness({ autonomous: false })
    await walkToQa(h.svc)
    await h.svc.block('s1', 'decisao_do_dono', 'pick one', 'leader')
    const l = await h.svc.unblock('s1', 'leader')
    expect(!l.ok && l.code).toBe('so_o_dono')
    const w = await h.svc.unblock('s1', 'author')
    expect(!w.ok && w.status).toBe(403)
    expect((await h.svc.unblock('s1', 'owner', 'chose B')).ok).toBe(true)
  })
})

describe('M5 — the human gate asks the owner ONCE and is answerable', () => {
  async function toReview() {
    const h = harness({ autonomous: false })
    await h.svc.configure('s1', { humanGates: ['pr_merge'] }, 'leader')
    await walkToQa(h.svc)
    await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    return h
  }
  test('three refused retries ring ONE bell', async () => {
    const h = await toReview()
    for (let i = 0; i < 3; i++) await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    expect(h.calls.owner.filter(o => o.kind === 'decisao')).toHaveLength(1)
    expect(h.calls.owner.at(-1)!.text).toContain('agentop flow approve')
  })
  test('an answer to a question nobody asked is refused; after the ask it is accepted', async () => {
    const h = await toReview()
    const early = await h.svc.approve('s1', 'pr_merge', 'approve', undefined, true)
    expect(!early.ok && early.code).toBe('nao_perguntado')
    await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    expect((await h.svc.approve('s1', 'pr_merge', 'approve', 'go', true)).ok).toBe(true)
    expect((await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
  })
})

describe('L1/L5/L6/L7', () => {
  test('L1: an unreadable autonomous mode is said, not silently assumed', async () => {
    const h = harness({}, { autonomous: async () => { throw new Error('prefs unreadable') } })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    const r = await h.svc.transition('s1', 'executando', {}, 'leader')
    expect(r.ok && r.warnings.join(' ')).toContain('autonomous mode could not be read')
  })
  test('L6: a subtask already in progress on the board is adopted at executando, not re-queued', async () => {
    const h = harness({ status: 'in_progress' })
    const r = await h.svc.ensure('s1')
    expect('phase' in r && r.phase).toBe('executando')
  })
  test('L7: a wake that did not reach the leader is not stamped as a wake', async () => {
    const h = harness({ wakeOk: false })
    await walkToQa(h.svc)
    await h.svc.block('s1', 'externo', 'gh down', 'leader')
    const b = (await h.svc.get('s1'))!.block!
    expect(b.lastWakeAt).toBeUndefined()
    expect(b.wakes).toBe(0)
  })
  test('L5: the ci poll backs off and publishes on ONE release read', async () => {
    const h = harness()
    await toPrMerge(h)
    await h.svc.transition('s1', 'ci', {}, 'leader')
    h.calls.gh.length = 0
    await h.svc.tick()
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1)
    await h.svc.tick()
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1)
    h.advance(61_000)
    h.w.releaseRuns = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'merge1' }]
    h.w.tags = [{ name: 'v2.200.8', commit: { sha: 'tagsha' } }]
    h.calls.gh.length = 0
    expect((await h.svc.tick()).actions[0]).toBe('publish s1:true')
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1)
  })
})

describe('M6 — the queue shows its expected slot', () => {
  test('stage reads the vaga gate at once (no more "not checked yet")', async () => {
    const h = harness()
    const r = await h.svc.stage('s1', { prompt: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }, 'leader', { leaderSessionId: 'leader' })
    expect(r.ok && r.record.gates.vaga).toMatchObject({ ok: true })
  })
  test('the minute tick re-reads the slot of a queued piece every few minutes, and not every minute', async () => {
    const h = harness()
    await h.svc.stage('s1', { prompt: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }, 'leader', { leaderSessionId: 'leader' })
    h.w.memory = 1024 ** 3 // the machine got tight
    await h.svc.tick()
    expect((await h.svc.get('s1'))!.gates.vaga!.ok).toBe(true) // inside the refresh window: untouched
    h.advance(6 * 60_000)
    await h.svc.tick()
    const vaga = (await h.svc.get('s1'))!.gates.vaga!
    expect(vaga.ok).toBe(false)
    expect(vaga.reason).toContain('3 GB')
  })
})

describe('PUBLICADO.MANIFESTO — the release says what it published', () => {
  const RELEASE = { version: '2.201.0', mergeSha: 'a201a201a201a201a201a201a201a201a201a201' }
  const GREEN = { databaseId: 9, status: 'completed', conclusion: 'success', headSha: 'a201a201a201a201a201a201a201a201a201a201', updatedAt: '2026-11-07T00:10:00Z' }
  const TAG = [{ name: 'v2.201.0', commit: { sha: 'tag201' } }]

  test('a legacy in_review piece → release → ci, then publicado on tag evidence (tick), stamped with the release time', async () => {
    const h = harness({ status: 'in_review' })
    expect(await h.svc.get('s1')).toBeNull()
    const r = await h.svc.release({ ...RELEASE, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // No green run and no tag yet: both pieces wait in ci, adopted from the board and declared in the release.
    expect(r.pieces).toEqual([{ subtaskId: 's1', phase: 'ci', changed: true }, { subtaskId: 's2', phase: 'ci', changed: true }])
    expect(r.warnings.join(' ')).toContain('not published yet')
    const rec = (await h.svc.get('s1'))!
    expect(rec).toMatchObject({ phase: 'ci', versionTarget: '2.201.0', mergeSha: 'a201a201a201a201a201a201a201a201a201a201', tag: 'v2.201.0', taskId: 't1' })
    expect(rec.history.map(x => x.to)).toEqual(['revisao_lider', 'ci'])
    expect(h.calls.status.filter(s => s.phase === 'ci').map(s => s.id)).toEqual(['s1', 's2'])
    // The release goes green and the tag appears: the minute tick publishes BOTH.
    h.advance(61_000)
    h.w.releaseRuns = [GREEN]
    h.w.tags = TAG
    expect((await h.svc.tick()).actions).toEqual(['publish s1:true', 'publish s2:true'])
    for (const id of ['s1', 's2']) {
      const done = (await h.svc.get(id))!
      expect(done.phase).toBe('publicado')
      expect(done.publishedAt).toBe('2026-11-07T00:10:00.000Z')
    }
  })

  test('the tag is already published and green → publicado at once, with the RELEASE time (not now)', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG })
    const r = await h.svc.release({ ...RELEASE, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(r.ok && r.pieces.map(p => p.phase)).toEqual(['publicado', 'publicado'])
    expect(r.ok && r.publishedAt).toBe('2026-11-07T00:10:00.000Z')
    const rec = (await h.svc.get('s2'))!
    // Declared at 02:00, released at 00:10: the 24 h window starts at the release.
    expect(rec.publishedAt).toBe('2026-11-07T00:10:00.000Z')
    expect(rec.ci).toEqual({ mergedMain: true, releaseGreen: true, tagPublished: true, tag: 'v2.201.0', pr: null })
    expect(rec.history.map(x => x.to)).toEqual(['revisao_lider', 'ci', 'publicado'])
    // ONE gh read of the release for the whole batch.
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1)
  })

  test('idempotent: a second run changes nothing (revision, history, board writes)', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG })
    await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    const before = JSON.stringify(await h.svc.get('s1'))
    const writes = h.calls.status.length + h.calls.comments.length
    const again = await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    expect(again.ok && again.pieces).toEqual([{ subtaskId: 's1', phase: 'publicado', changed: false }])
    expect(JSON.stringify(await h.svc.get('s1'))).toBe(before)
    expect(h.calls.status.length + h.calls.comments.length).toBe(writes)
  })

  test('a piece waiting in ci for the same release is left alone by a second run', async () => {
    const h = harness({ status: 'in_review' })
    await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    const rev = (await h.svc.get('s1'))!.revision
    const again = await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    expect(again.ok && again.pieces[0]).toEqual({ subtaskId: 's1', phase: 'ci', changed: false })
    expect((await h.svc.get('s1'))!.revision).toBe(rev)
  })

  test('refusals: done piece, unknown piece, another task, bad input, not the leader — and a refused batch writes NOTHING', async () => {
    const done = harness({ status: 'done' })
    const d = await done.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    expect(!d.ok && d.code).toBe('peca_encerrada')
    expect(await done.svc.get('s1')).toBeNull()
    const abandoned = harness({ status: 'abandoned' })
    expect((await abandoned.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader') as { code?: string }).code).toBe('peca_encerrada')

    const h = harness({ status: 'in_review' })
    const unknown = await h.svc.release({ ...RELEASE, subtaskIds: ['s1', 'nope'] }, 'leader')
    expect(!unknown.ok && unknown.status).toBe(404)
    const other = await h.svc.release({ ...RELEASE, subtaskIds: ['s1', 's3'] }, 'leader')
    expect(!other.ok && other.code).toBe('outra_tarefa')
    // s1 was valid in both refused batches and still has no record: validation comes before any write.
    expect(await h.svc.get('s1')).toBeNull()
    expect(h.calls.status).toEqual([])

    expect((await h.svc.release({ version: 'x', mergeSha: 'a201a201a201a201a201a201a201a201a201a201', subtaskIds: ['s1'] }, 'leader') as { code?: string }).code).toBe('bad_version')
    expect((await h.svc.release({ version: '2.201.0', mergeSha: 'nothex!', subtaskIds: ['s1'] }, 'leader') as { code?: string }).code).toBe('bad_merge_sha')
    expect((await h.svc.release({ ...RELEASE, subtaskIds: [] }, 'leader') as { code?: string }).code).toBe('no_subtasks')
    const stranger = await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'author')
    expect(!stranger.ok && stranger.status).toBe(403)
    expect(await h.svc.get('s1')).toBeNull()
  })

  test('a published piece cannot be declared in ANOTHER release; a blocked one must be unblocked first', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG })
    await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    const other = await h.svc.release({ version: '2.202.0', mergeSha: 'b202b202b202b202b202b202b202b202b202b202', subtaskIds: ['s1'] }, 'leader')
    expect(!other.ok && other.code).toBe('ja_publicada')
    await h.svc.block('s2', 'externo', 'waiting on a vendor', 'leader')
    const blocked = await h.svc.release({ ...RELEASE, subtaskIds: ['s2'] }, 'leader')
    expect(!blocked.ok && blocked.code).toBe('bloqueada')
  })

  test("the tag's own run FAILED: not published, the piece stays in ci with the reason and the tick NEVER sends it back (one wake only)", async () => {
    const h = harness({ status: 'in_review', releaseRuns: [{ ...GREEN, conclusion: 'failure' }], tags: TAG })
    const r = await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    expect(r.ok && r.pieces[0]!.phase).toBe('ci')
    expect(r.ok && r.warnings.join(' ')).toContain('release.yml failed for v2.201.0')
    expect((await h.svc.get('s1'))!.publishedAt).toBeUndefined()
    for (let i = 0; i < 4; i++) { h.advance(11 * 60_000); await h.svc.tick() }
    const rec = (await h.svc.get('s1'))!
    expect(rec.phase).toBe('ci')
    expect(rec.releaseFailNotice?.reason).toContain('failed')
    expect(rec.gates.release?.ok).toBe(false)
    // The verb told the leader (the caller) already: the tick adds no wake for a failure that was already reported.
    expect(h.calls.session.filter(s => s.text.includes('release.yml'))).toHaveLength(0)
    // Fixed later: the next green run publishes it.
    h.w.releaseRuns = [{ ...GREEN, databaseId: 10, updatedAt: '2026-11-07T01:30:00Z' }]
    h.advance(11 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['publish s1:true'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// PUBLICADO.MANIFESTO r2 — the QA findings. Real data (gh, read-only, 2026-11-07): release.yml for v2.201.0 FAILED on
// the feat squash db7bf2f (run 42362240091) and went GREEN on the follow-up 7cede91 (run 42364227357, ended
// 10:43:20Z); the tag v2.201.0 sits on the bump commit 1bc12c5, ahead of both.
// ---------------------------------------------------------------------------------------------------------------
describe('PUBLICADO.MANIFESTO r2 — the tag is the evidence', () => {
  const SQUASH = 'db7bf2f38386bbc43e6ae9b7285896248e381ea8'
  const FIX = '7cede914231f98f6ae477fbdae082a89fc4ac5c7'
  const NEXT = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
  const REAL_RUNS = [
    { databaseId: 42364227357, status: 'completed', conclusion: 'success', headSha: FIX, updatedAt: '2026-11-07T10:43:20Z' },
    { databaseId: 42362240091, status: 'completed', conclusion: 'failure', headSha: SQUASH, updatedAt: '2026-11-07T10:14:51Z' },
  ]
  const REAL_TAG = [{ name: 'v2.201.0', commit: { sha: '1bc12c52efe373089747197429f6e67013ff819e' } }]
  const REPO = 'agentistics/agentistics'

  test('the v2.201.0 shape: declared with the squash whose run is RED → publicado on the tag run, publishedAt = the end of the green run', async () => {
    const h = harness({ status: 'in_review', releaseRuns: REAL_RUNS, tags: REAL_TAG })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: SQUASH, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(r.ok && r.pieces.map(p => p.phase)).toEqual(['publicado', 'publicado'])
    expect(r.ok && r.publishedAt).toBe('2026-11-07T10:43:20.000Z')
    for (const id of ['s1', 's2']) {
      const rec = (await h.svc.get(id))!
      expect(rec.publishedAt).toBe('2026-11-07T10:43:20.000Z')
      expect(rec.mergeSha).toBe(SQUASH) // information only, stored as declared
    }
  })

  test('declared with the green sha works the same; the merge sha is not the criterion', async () => {
    const h = harness({ status: 'in_review', releaseRuns: REAL_RUNS, tags: REAL_TAG })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(r.ok && r.pieces[0]!.phase).toBe('publicado')
  })

  test('even a sha unrelated to the run (a later commit) declares fine: only the tag decides', async () => {
    const h = harness({ status: 'in_review', releaseRuns: REAL_RUNS, tags: REAL_TAG })
    const o = await h.svc.release({ version: '2.201.0', mergeSha: NEXT, subtaskIds: ['s1'] }, 'leader')
    expect(o.ok && o.pieces[0]!.phase).toBe('publicado')
  })

  test('no tag yet: the piece waits in ci — a red run of ANOTHER commit never demotes a declared piece, tick after tick', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [REAL_RUNS[1]!], tags: [] })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: SQUASH, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(r.ok && r.pieces.map(p => p.phase)).toEqual(['ci', 'ci'])
    expect(r.ok && r.warnings.join(' ')).toContain('tag v2.201.0 does not exist yet')
    for (let i = 0; i < 4; i++) { h.advance(11 * 60_000); expect((await h.svc.tick()).actions).toEqual([]) }
    expect((await h.svc.get('s1'))!.phase).toBe('ci')
    expect(h.calls.session.filter(s => s.text.includes('falhou'))).toHaveLength(0)
    // The tag appears with its green run: the tick publishes both, stamped with the run's end.
    h.w.releaseRuns = REAL_RUNS
    h.w.tags = REAL_TAG
    h.advance(11 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['publish s1:true', 'publish s2:true'])
    expect((await h.svc.get('s2'))!.publishedAt).toBe('2026-11-07T10:43:20.000Z')
  })

  test("the tag's run is the NEWEST run it contains: a later release's run (tag does not contain it) is ignored, a red newer one is not", async () => {
    // A later release's red run is not part of this tag: it must not decide v2.201.0.
    const later = { databaseId: 99, status: 'completed', conclusion: 'failure', headSha: NEXT, updatedAt: '2026-11-08T09:00:00Z' }
    const h = harness({ status: 'in_review', releaseRuns: [later, ...REAL_RUNS], tags: REAL_TAG, notContained: [NEXT] })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: SQUASH, subtaskIds: ['s1'] }, 'leader')
    expect(r.ok && r.pieces[0]!.phase).toBe('publicado')
  })

  test('a RED run newer than the green one that the tag DOES contain is the tag\'s own run: not published', async () => {
    const later = { databaseId: 99, status: 'completed', conclusion: 'failure', headSha: NEXT, updatedAt: '2026-11-08T09:00:00Z' }
    const red = harness({ status: 'in_review', releaseRuns: [later, ...REAL_RUNS], tags: REAL_TAG })
    const r2 = await red.svc.release({ version: '2.201.0', mergeSha: SQUASH, subtaskIds: ['s1'] }, 'leader')
    expect(r2.ok && r2.pieces[0]!.phase).toBe('ci')
  })

  test('the tag run still in progress → waits quietly (no failure, no wake)', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [{ ...REAL_RUNS[0]!, status: 'in_progress', conclusion: '' }], tags: REAL_TAG })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(r.ok && r.pieces[0]!.phase).toBe('ci')
    expect(r.ok && r.warnings.join(' ')).toContain('not finished')
    h.advance(11 * 60_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect((await h.svc.get('s1'))!.releaseFailNotice).toBeUndefined()
  })

  test("a red tag run found by the TICK wakes the leader exactly once and keeps the piece in ci", async () => {
    const h = harness({ status: 'in_review', releaseRuns: [], tags: REAL_TAG })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(r.ok && r.pieces[0]!.phase).toBe('ci') // tag exists, no run yet
    h.w.releaseRuns = [{ ...REAL_RUNS[0]!, conclusion: 'failure' }]
    h.advance(11 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['release-failed-notified s1:true'])
    expect(h.calls.session.filter(s => s.id === 'leader' && s.text.includes('release.yml'))).toHaveLength(1)
    for (let i = 0; i < 3; i++) { h.advance(11 * 60_000); expect((await h.svc.tick()).actions).toEqual(['release-failed-stays s1']) }
    expect(h.calls.session.filter(s => s.id === 'leader' && s.text.includes('release.yml'))).toHaveLength(1)
    expect((await h.svc.get('s1'))!.phase).toBe('ci')
  })

  test('the tick reads the tag by its exact name — not a page of the newest tags', async () => {
    const h = harness({ status: 'in_review', releaseRuns: REAL_RUNS, tags: REAL_TAG })
    await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(h.calls.gh.some(c => c.includes('/git/ref/tags/v2.201.0'))).toBe(true)
    expect(h.calls.gh.some(c => c.includes('tags?per_page'))).toBe(false)
  })
})

describe('PUBLICADO.MANIFESTO r2 — one repository per release', () => {
  const FIX = '7cede914231f98f6ae477fbdae082a89fc4ac5c7'
  const RUN = [{ databaseId: 42364227357, status: 'completed', conclusion: 'success', headSha: FIX, updatedAt: '2026-11-07T10:43:20Z' }]
  const TAG = [{ name: 'v2.201.0', commit: { sha: '1bc12c52efe373089747197429f6e67013ff819e' } }]

  test("a piece whose newest author session worked in ANOTHER repo still publishes, and all the pieces of the call get the same verdict", async () => {
    const h = harness({ status: 'in_review', releaseRuns: RUN, tags: TAG, runsRepo: 'agentistics/agentistics' })
    // s2's newest filed session worked in the engine checkout (188 such rows on this machine).
    h.w.sessions.push({ id: 'author2', harness: 'claude', model: 'claude-opus-5-5', role: 'worker', alive: false, cwd: '/engine/.wt/b', worktree: true, rootPath: '/engine', taskId: 't1', subtaskId: 's2', label: 'impl2', createdAt: '2026-11-07T00:30:00Z' })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(r.ok && r.pieces.map(p => p.phase)).toEqual(['publicado', 'publicado'])
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1) // computed ONCE
    expect(h.calls.ghCwd.every(c => c !== '/engine')).toBe(true)
    expect(h.calls.gh.filter(c => c.startsWith('run list')).every(c => c.includes('-R agentistics/agentistics'))).toBe(true)
  })

  test('the repository is recorded on every piece (default and --repo), validated, and the tick (later) reads it there too', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [], tags: [], runsRepo: 'acme/widgets' })
    const bad = await h.svc.release({ version: '2.201.0', mergeSha: FIX, repo: 'not a repo', subtaskIds: ['s1'] }, 'leader')
    expect(!bad.ok && bad.code).toBe('bad_repo')
    const r = await h.svc.release({ version: '2.201.0', mergeSha: FIX, repo: 'acme/widgets', subtaskIds: ['s1', 's2'] }, 'leader')
    expect(r.ok).toBe(true)
    for (const id of ['s1', 's2']) expect((await h.svc.get(id))!.releaseRepo).toBe('acme/widgets')
    h.w.releaseRuns = RUN; h.w.tags = TAG
    h.w.sessions.push({ id: 'author2', harness: 'claude', model: 'x', role: 'worker', alive: false, cwd: '/engine/.wt/b', worktree: true, rootPath: '/engine', taskId: 't1', subtaskId: 's2', label: 'impl2', createdAt: '2026-11-07T00:30:00Z' })
    h.advance(11 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['publish s1:true', 'publish s2:true'])
  })

  test('with no --repo the default agentistics/agentistics is recorded', async () => {
    const h = harness({ status: 'in_review' })
    await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect((await h.svc.get('s1'))!.releaseRepo).toBe('agentistics/agentistics')
  })

  test('re-declaring in another repository is a change; the same repository is idempotent', async () => {
    const h = harness({ status: 'in_review' })
    await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    const same = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(same.ok && same.pieces[0]!.changed).toBe(false)
    const moved = await h.svc.release({ version: '2.201.0', mergeSha: FIX, repo: 'acme/widgets', subtaskIds: ['s1'] }, 'leader')
    expect(moved.ok && moved.pieces[0]!.changed).toBe(true)
  })
})

describe('PUBLICADO.MANIFESTO r2 — the sha, the batch write, the blocked piece', () => {
  const FIX = '7cede914231f98f6ae477fbdae082a89fc4ac5c7'

  test('a SHORT sha is resolved to the full 40 characters by git and stored in full', async () => {
    const h = harness({ status: 'in_review', fullShas: { '7cede91': FIX } })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: '7CEDE91', subtaskIds: ['s1'] }, 'leader')
    expect(r.ok && r.mergeSha).toBe(FIX)
    expect((await h.svc.get('s1'))!.mergeSha).toBe(FIX)
  })

  test('a sha that does not resolve to 40 characters is refused with a sentence and writes nothing', async () => {
    const h = harness({ status: 'in_review' })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: 'deadbee', subtaskIds: ['s1'] }, 'leader')
    expect(!r.ok && r.code).toBe('sha_nao_resolve')
    expect(!r.ok && r.sentence).toContain('40-character')
    expect(await h.svc.get('s1')).toBeNull()
    expect(h.calls.status).toEqual([])
  })

  test('the batch is ONE store write: an I/O error mid-run changes NOTHING and returns a clean error (no throw), a re-run completes', async () => {
    const real = createDeliveryStore(join(dir, 'deliveries.json'))
    let writes = 0
    let failAt = 1
    const flaky = { path: real.path, read: () => real.read(), get: (id: string) => real.get(id), update: <T>(fn: (doc: Parameters<typeof real.update>[0] extends (d: infer D) => unknown ? D : never) => T | Promise<T>) => { writes += 1; if (writes === failAt) return Promise.reject(new Error('EIO: disk full')); return real.update(fn as never) as Promise<T> } }
    const h = harness({ status: 'in_review' }, { store: flaky as never })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(!r.ok && r.code).toBe('store_erro')
    expect(!r.ok && r.sentence).toContain('EIO')
    expect(await h.svc.get('s1')).toBeNull()
    expect(await h.svc.get('s2')).toBeNull()
    expect(h.calls.status.length + h.calls.comments.length + h.calls.ci.length).toBe(0)
    failAt = -1
    const again = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(again.ok && again.pieces.map(p => [p.subtaskId, p.phase, p.changed])).toEqual([['s1', 'ci', true], ['s2', 'ci', true]])
  })

  test('the whole batch lands in a single write (one store.update for the declaration)', async () => {
    const real = createDeliveryStore(join(dir, 'deliveries.json'))
    let writes = 0
    const counting = { path: real.path, read: () => real.read(), get: (id: string) => real.get(id), update: <T>(fn: (doc: Parameters<typeof real.update>[0] extends (d: infer D) => unknown ? D : never) => T | Promise<T>) => { writes += 1; return real.update(fn as never) as Promise<T> } }
    const h = harness({ status: 'in_review' }, { store: counting as never })
    await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1', 's2'] }, 'leader')
    expect(writes).toBe(1)
  })

  test("a legacy piece BLOCKED on the board (no record yet) is refused as bloqueada — and a done one with a record too", async () => {
    const h = harness({ status: 'blocked' })
    const r = await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(!r.ok && r.code).toBe('bloqueada')
    expect(await h.svc.get('s1')).toBeNull()
    const doneWithRecord = harness({ status: 'in_review' })
    await doneWithRecord.svc.ensure('s1')
    doneWithRecord.w.status = 'done'
    const d = await doneWithRecord.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(!d.ok && d.code).toBe('peca_encerrada')
  })

  test('a piece that never left the queue, and one waiting for ANOTHER version, are declared WITH a warning', async () => {
    const todo = harness({ status: 'todo' })
    const t = await todo.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    expect(t.ok && t.warnings.join(' ')).toContain('never left the queue')
    const h = harness({ status: 'in_review' })
    await h.svc.release({ version: '2.201.0', mergeSha: FIX, subtaskIds: ['s1'] }, 'leader')
    const r = await h.svc.release({ version: '2.202.0', mergeSha: 'b202b202b202b202b202b202b202b202b202b202', subtaskIds: ['s1'] }, 'leader')
    expect(r.ok && r.warnings.join(' ')).toMatch(/waiting in ci for 2\.201\.0/)
  })
})

describe('PUBLICADO.MANIFESTO independent r2 QA regressions', () => {
  const SHA = '7cede914231f98f6ae477fbdae082a89fc4ac5c7'
  const RELEASE = { version: '2.201.0', mergeSha: SHA, subtaskIds: ['s1', 's2'] }
  const GREEN = { databaseId: 42364227357, status: 'completed', conclusion: 'success', headSha: SHA, updatedAt: '2026-11-07T10:43:20Z' }
  const TAG = [{ name: 'v2.201.0', commit: { sha: '1bc12c52efe373089747197429f6e67013ff819e' } }]

  for (const status of ['abandoned', 'blocked']) {
    test(`QA: already-published ${status} piece still refuses the entire declaration`, async () => {
      const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG })
      await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
      const subtask = h.facts.subtask
      h.facts.subtask = async id => {
        const sub = await subtask(id)
        return sub && id === 's1' ? { ...sub, status } : sub
      }
      const reply = await h.svc.release(RELEASE, 'leader')
      expect(reply.ok).toBe(false)
      expect(!reply.ok && reply.code).toBe(status === 'blocked' ? 'bloqueada' : 'peca_encerrada')
      expect(await h.svc.get('s2')).toBeNull()
    })
  }

  test('QA: immediate publication commits the whole batch in one write', async () => {
    const real = createDeliveryStore(join(dir, 'deliveries.json'))
    let writes = 0
    const flaky: typeof real = {
      ...real,
      update: async fn => {
        writes += 1
        if (writes === 3) throw new Error('EIO: injected third store write')
        return real.update(fn)
      },
    }
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG }, { store: flaky })
    const reply = await h.svc.release(RELEASE, 'leader')
    expect(reply.ok).toBe(true)
    expect(writes).toBe(1)
    expect(await Promise.all(RELEASE.subtaskIds.map(async id => (await real.get(id))?.phase))).toEqual(['publicado', 'publicado'])
  })

  test('QA: I/O failure during immediate publication must not leave a half-published release', async () => {
    const real = createDeliveryStore(join(dir, 'deliveries.json'))
    const flaky: typeof real = { ...real, update: async () => { throw new Error('EIO: injected atomic commit failure') } }
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG }, { store: flaky })
    const reply = await h.svc.release(RELEASE, 'leader')
    expect(!reply.ok && reply.code).toBe('store_erro')
    const phases = await Promise.all(RELEASE.subtaskIds.map(async id => (await real.get(id))?.phase ?? null))
    expect(phases).toEqual([null, null])
    expect(h.calls.status).toEqual([])
    expect(h.calls.comments).toEqual([])
    expect(h.calls.owner).toEqual([])
    expect(h.calls.session).toEqual([])
    expect(h.calls.emits).toEqual([])
  })

  test('QA: an exact existing tag must still find its green run behind 16 later releases', async () => {
    const later = Array.from({ length: 16 }, (_, i) => ({
      databaseId: 500 + i, status: 'completed', conclusion: 'success',
      headSha: (i + 1).toString(16).padStart(40, '0'),
      updatedAt: new Date(Date.parse('2026-11-08T10:00:00Z') + i * 60_000).toISOString(),
    }))
    const h = harness({ status: 'in_review', tags: TAG, releaseRuns: [...later, GREEN], notContained: later.map(r => r.headSha) })
    const reply = await h.svc.release(RELEASE, 'leader')
    expect(reply.ok && reply.pieces.map(p => p.phase)).toEqual(['publicado', 'publicado'])
    expect(reply.ok && reply.publishedAt).toBe('2026-11-07T10:43:20.000Z')
  })

  test('QA: changing repository after publication cannot silently reuse the old repository evidence', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG })
    await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    const reply = await h.svc.release({ ...RELEASE, repo: 'acme/widgets', subtaskIds: ['s1'] }, 'leader')
    expect(reply.ok).toBe(false)
    expect((await h.svc.get('s1'))!.releaseRepo).toBe('agentistics/agentistics')
  })

  test('QA: exact tag lookup paginates past 100 later runs', async () => {
    const later = Array.from({ length: 100 }, (_, i) => ({
      databaseId: 500 + i, status: 'completed', conclusion: 'success',
      headSha: (i + 1).toString(16).padStart(40, '0'), updatedAt: '2026-11-08T10:00:00Z',
    }))
    const h = harness({ status: 'in_review', tags: TAG, releaseRuns: later.slice(0, 50), notContained: later.map(r => r.headSha) })
    const gh = h.facts.gh
    const pages: string[] = []
    h.facts.gh = async (cwd, args) => {
      const path = args[1] ?? ''
      if (path.includes('/actions/workflows/')) {
        pages.push(path)
        const runs = path.endsWith('page=2') ? later.slice(50) : [GREEN]
        return JSON.stringify({ workflow_runs: runs.map(r => ({ id: r.databaseId, head_sha: r.headSha, status: r.status, conclusion: r.conclusion, updated_at: r.updatedAt })) })
      }
      return gh(cwd, args)
    }
    const reply = await h.svc.release(RELEASE, 'leader')
    expect(reply.ok && reply.pieces.map(p => p.phase)).toEqual(['publicado', 'publicado'])
    expect(reply.ok && reply.publishedAt).toBe('2026-11-07T10:43:20.000Z')
    expect(pages).toEqual([2, 3].map(page => `repos/agentistics/agentistics/actions/workflows/release.yml/runs?per_page=50&page=${page}`))
  })

  test('QA: a failed commit preserves existing ci records and all effects', async () => {
    const real = createDeliveryStore(join(dir, 'deliveries.json'))
    let fail = false
    const flaky: typeof real = { ...real, update: fn => fail ? Promise.reject(new Error('EIO: commit refused')) : real.update(fn) }
    const h = harness({ status: 'in_review' }, { store: flaky })
    await h.svc.release(RELEASE, 'leader')
    const before = await real.read()
    const effects = structuredClone(h.calls)
    h.w.releaseRuns = [GREEN]; h.w.tags = TAG
    fail = true
    const reply = await h.svc.release(RELEASE, 'leader')
    expect(!reply.ok && reply.code).toBe('store_erro')
    expect(await real.read()).toEqual(before)
    for (const key of ['status', 'comments', 'owner', 'session', 'emits', 'ci'] as const) expect(h.calls[key]).toEqual(effects[key])
  })
})

describe('PUBLICADO.MANIFESTO r2 — the HTTP door passes --repo; auth unchanged', () => {
  const body = { version: '2.201.0', mergeSha: '7cede914231f98f6ae477fbdae082a89fc4ac5c7', repo: 'acme/widgets', subtaskIds: ['s1'] }
  test('POST /api/deliveries/release records the repo; a forged proof is 403; a verified non-leader is 403 with nothing written', async () => {
    const { deliveryRequest } = await import('./web')
    const h = harness({ status: 'in_review' })
    const verify = async (id: unknown, token: unknown) => (token === 'good' ? String(id) : null)
    const forged = await deliveryRequest('POST', '/api/deliveries/release', { ...body, session: { id: 'leader', token: 'bad' } }, { service: h.svc, verify })
    expect(forged.status).toBe(403)
    const worker = await deliveryRequest('POST', '/api/deliveries/release', { ...body, session: { id: 'author', token: 'good' } }, { service: h.svc, verify })
    expect(worker.status).toBe(403)
    expect(await h.svc.get('s1')).toBeNull()
    const ok = await deliveryRequest('POST', '/api/deliveries/release', { ...body, session: { id: 'leader', token: 'good' } }, { service: h.svc, verify })
    expect(ok.status).toBe(200)
    expect((await h.svc.get('s1'))!.releaseRepo).toBe('acme/widgets')
  })
})

describe('PUBLICADO.MANIFESTO independent r3 QA regressions', () => {
  const SHA = '7cede914231f98f6ae477fbdae082a89fc4ac5c7'
  const RELEASE = { version: '2.201.0', mergeSha: SHA, subtaskIds: ['s1', 's2'] }
  const GREEN = { databaseId: 42364227357, status: 'completed', conclusion: 'success', headSha: SHA, updatedAt: '2026-11-07T10:43:20Z' }
  const TAG = [{ name: 'v2.201.0', commit: { sha: '1bc12c52efe373089747197429f6e67013ff819e' } }]

  test('QA r3: re-running the same release after the flow itself set the board to done is idempotent', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG, projectPhaseStatus: true })
    const first = await h.svc.release(RELEASE, 'leader')
    expect(first.ok && first.pieces.map(p => p.phase)).toEqual(['publicado', 'publicado'])
    expect((await h.facts.subtask('s1'))!.status).toBe('done')
    expect((await h.facts.subtask('s2'))!.status).toBe('done')
    const effects = structuredClone(h.calls)
    const again = await h.svc.release(RELEASE, 'leader')
    expect(again.ok).toBe(true)
    expect(again.ok && again.pieces.map(p => p.changed)).toEqual([false, false])
    expect(h.calls).toEqual(effects)
  })

  test('QA r3: a human gate on publicado must not discard the declaration (non-autonomous owner present)', async () => {
    const h = harness({ status: 'in_review', releaseRuns: [GREEN], tags: TAG, autonomous: false })
    await h.svc.ensure('s1')
    await h.svc.configure('s1', { humanGates: ['publicado'] }, 'leader')
    const reply = await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    expect(reply.ok).toBe(true)
    expect((await h.svc.get('s1'))!.phase).toBe('ci')
    expect(reply.ok && reply.warnings.join(' ')).toContain('aguardando_dono')
    expect(h.calls.owner.filter(x => x.kind === 'decisao')).toHaveLength(1)
    await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    h.advance(11 * 60_000)
    await h.svc.tick()
    expect(h.calls.owner.filter(x => x.kind === 'decisao')).toHaveLength(1)
    await h.svc.approve('s1', 'publicado', 'approve', undefined, true)
    h.advance(11 * 60_000)
    await h.svc.tick()
    expect((await h.svc.get('s1'))!.phase).toBe('publicado')
  })
})

describe('PUBLICADO.MANIFESTO r4 — bounded polling and transition effects', () => {
  const SHA = '7cede914231f98f6ae477fbdae082a89fc4ac5c7'
  const RELEASE = { version: '2.201.0', mergeSha: SHA, subtaskIds: ['s1', 's2'] }
  const GREEN = { databaseId: 42, status: 'completed', conclusion: 'success', headSha: SHA, updatedAt: '2026-11-07T10:43:20Z' }
  const TAG = [{ name: 'v2.201.0', commit: { sha: '1bc12c52efe373089747197429f6e67013ff819e' } }]

  function history(h: ReturnType<typeof harness>, runs: World['releaseRuns']) {
    const gh = h.facts.gh
    const pages: number[] = []
    h.facts.gh = async (cwd, args) => {
      if ((args[1] ?? '').includes('/actions/workflows/')) {
        const page = Number(new URLSearchParams(args[1]!.split('?')[1]).get('page'))
        pages.push(page)
        return JSON.stringify({ workflow_runs: runs.slice((page - 1) * 50, page * 50).map(r => ({ id: r.databaseId, head_sha: r.headSha, status: r.status, conclusion: r.conclusion, updated_at: r.updatedAt })) })
      }
      return gh(cwd, args)
    }
    return pages
  }

  test('a bounded comparison budget resumes an old tag next tick and siblings share the poll', async () => {
    const later = Array.from({ length: 200 }, (_, i) => ({ ...GREEN, databaseId: 500 + i, headSha: (i + 1).toString(16).padStart(40, '0') }))
    const h = harness({ status: 'in_review', tags: TAG, releaseRuns: later.slice(0, 50), notContained: later.map(x => x.headSha) })
    history(h, [...later, GREEN])
    const declared = await h.svc.release(RELEASE, 'leader')
    expect(declared.ok && declared.pieces.map(x => x.phase)).toEqual(['ci', 'ci'])
    expect(declared.ok && declared.warnings.join(' ')).toContain('search paused')
    expect(h.calls.gh.filter(x => x.includes('/compare/'))).toHaveLength(150)
    h.calls.gh.length = 0
    h.advance(11 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['publish s1:true', 'publish s2:true'])
    expect(h.calls.gh.filter(x => x.startsWith('run list'))).toHaveLength(1)
    expect(h.calls.gh.filter(x => x.includes('/compare/'))).toHaveLength(51)
    expect((await h.svc.get('s2'))!.publishedAt).toBe('2026-11-07T10:43:20.000Z')
  })

  test('pagination itself is bounded, resumes past ten pages and notices new decisive red runs', async () => {
    const later = Array.from({ length: 550 }, (_, i) => ({ ...GREEN, databaseId: 500 + i, headSha: 'f'.repeat(40) }))
    const h = harness({ status: 'in_review', tags: TAG, releaseRuns: later.slice(0, 50), notContained: ['f'.repeat(40)] })
    const pages = history(h, [...later, GREEN])
    const declared = await h.svc.release(RELEASE, 'leader')
    expect(declared.ok && declared.pieces.map(x => x.phase)).toEqual(['ci', 'ci'])
    expect(pages).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
    h.advance(11 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['publish s1:true', 'publish s2:true'])
    expect(pages.slice(9)).toEqual([11, 12])

    // A changed first page invalidates the cursor. The new red run wins over the old green one.
    const fresh = harness({ status: 'in_review', tags: TAG, releaseRuns: later.slice(0, 50), notContained: ['f'.repeat(40)] }, { store: createDeliveryStore(join(dir, 'fresh.json')) })
    history(fresh, [...later, GREEN])
    await fresh.svc.release(RELEASE, 'leader')
    fresh.w.releaseRuns = [{ ...GREEN, databaseId: 9999, conclusion: 'failure' }]
    fresh.advance(11 * 60_000)
    await fresh.svc.tick()
    expect((await fresh.svc.get('s1'))!.phase).toBe('ci')
    expect((await fresh.svc.get('s1'))!.releaseFailNotice).toBeDefined()
  })

  test('one gated piece waits in ci while its sibling publishes; effects occur once per actual transition', async () => {
    const h = harness({ status: 'todo', tags: TAG, releaseRuns: [GREEN], autonomous: false })
    await h.svc.ensure('s1')
    await h.svc.configure('s1', { humanGates: ['publicado'] }, 'leader')
    h.calls.comments.length = 0
    const reply = await h.svc.release(RELEASE, 'leader')
    expect(reply.ok && reply.pieces.map(x => x.phase)).toEqual(['ci', 'publicado'])
    expect(h.calls.comments.map(x => x.match(/\] (.*?) \(rev/)?.[1])).toEqual(['fila → ci', 'fila → ci', 'ci → publicado'])
    expect(h.calls.status.map(x => x.phase)).toEqual(['ci', 'ci', 'publicado'])
    expect(h.calls.emits).toHaveLength(3)
    expect(h.calls.owner.map(x => x.kind)).toEqual(['decisao', 'aviso'])
    const effects = structuredClone(h.calls)
    await h.svc.release(RELEASE, 'leader')
    for (const key of ['comments', 'status', 'emits', 'owner', 'ci'] as const) expect(h.calls[key]).toEqual(effects[key])
  })

  test('done only allows an exact published identity and can add a new sibling to that release', async () => {
    const h = harness({ status: 'in_review', tags: TAG, releaseRuns: [GREEN], projectPhaseStatus: true })
    await h.svc.release({ ...RELEASE, subtaskIds: ['s1'] }, 'leader')
    const extended = await h.svc.release(RELEASE, 'leader')
    expect(extended.ok && extended.pieces.map(x => x.changed)).toEqual([false, true])
    for (const mismatch of [{ version: '2.202.0' }, { mergeSha: 'f'.repeat(40) }, { repo: 'acme/widgets' }]) {
      const reply = await h.svc.release({ ...RELEASE, ...mismatch }, 'leader')
      expect(!reply.ok && reply.code).toBe('peca_encerrada')
    }
  })

  test('concurrent retries at the same ci revision ring a human publication gate once', async () => {
    const h = harness({ status: 'in_review', autonomous: false })
    await h.svc.ensure('s1')
    await h.svc.configure('s1', { humanGates: ['publicado'] }, 'leader')
    const release = { ...RELEASE, subtaskIds: ['s1'] }
    await h.svc.release(release, 'leader')
    h.w.releaseRuns = [GREEN]; h.w.tags = TAG
    let arrivals = 0
    let ready!: () => void
    const bothReading = new Promise<void>(resolve => { ready = resolve })
    const gh = h.facts.gh
    h.facts.gh = async (cwd, args) => {
      if (args[0] === 'run') {
        if (++arrivals === 2) ready()
        await bothReading
      }
      return gh(cwd, args)
    }
    const replies = await Promise.all([h.svc.release(release, 'leader'), h.svc.release(release, 'leader')])
    expect(replies.every(x => x.ok)).toBe(true)
    expect((await h.svc.get('s1'))!.phase).toBe('ci')
    expect(h.calls.owner.filter(x => x.kind === 'decisao')).toHaveLength(1)
  })

  test('a failed gated declaration writes no asked stamp and rings no bell', async () => {
    const real = createDeliveryStore(join(dir, 'deliveries.json'))
    let fail = false
    const store: typeof real = { ...real, update: fn => fail ? Promise.reject(new Error('EIO')) : real.update(fn) }
    const h = harness({ status: 'in_review', autonomous: false, tags: TAG, releaseRuns: [GREEN] }, { store })
    await h.svc.ensure('s1')
    await h.svc.configure('s1', { humanGates: ['publicado'] }, 'leader')
    const before = await real.read()
    const effects = structuredClone(h.calls)
    fail = true
    const reply = await h.svc.release(RELEASE, 'leader')
    expect(!reply.ok && reply.code).toBe('store_erro')
    expect(await real.read()).toEqual(before)
    for (const key of ['comments', 'status', 'emits', 'owner', 'ci'] as const) expect(h.calls[key]).toEqual(effects[key])
  })
})
