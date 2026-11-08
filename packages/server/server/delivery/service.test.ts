import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryService, type DeliveryDeps } from './service'
import { createDeliveryStore } from './store'
import { blockedPiecesOf, type BlockedSubtaskFact, type GateFacts, type SessionFact } from './gates'
import { PHASE_STATUS, type DeliveryCi, type Phase } from './machine'
import { deliveryHostOps } from './host-ops'
import { emitEvent } from './host'

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
  /** Board subtasks held in `blocked` (BLOQUEIO.ORFAO). */
  blocked?: BlockedSubtaskFact[]
  /** Board pieces (subtasks or tasks) that are done. */
  finished?: string[]
  /** true = every board status write is refused. */
  boardWriteFails?: boolean
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
  /** `gh pr list --state merged …` (FLUXO.CICLO-COMPLETO merge detection); keyed by the `--head` / `--search` value, `*` = any. */
  prList?: Record<string, Array<Record<string, unknown>>>
  /** `gh api repos/…/commits/<sha>/pulls`, by sha. */
  commitPulls?: Record<string, Array<Record<string, unknown>>>
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
    blockedSubtasks: async () => w.blocked ?? [],
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
      if (a.startsWith('pr list')) {
        const key = args[args.indexOf('--head') + 1] && args.includes('--head') ? args[args.indexOf('--head') + 1]! : args.includes('--search') ? args[args.indexOf('--search') + 1]! : '*'
        return JSON.stringify(w.prList?.[key] ?? w.prList?.['*'] ?? [])
      }
      const pulls = /commits\/([^/]+)\/pulls$/.exec(a)
      if (pulls) return JSON.stringify(w.commitPulls?.[pulls[1]!] ?? [])
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
      setPhaseStatus: async (id, phase) => { calls.status.push({ id, phase }); if (w.projectPhaseStatus) statuses.set(id, PHASE_STATUS[phase].id); return w.boardWriteFails ? { ok: false, message: 'board write failed' } : { ok: true } },
      setCi: async (_id, ci) => { calls.ci.push(ci) },
      logStep: async (_t, _s, n) => { calls.steps.push(n) },
      comment: async (_t, _s, body) => { calls.comments.push(body) },
      subtaskFinished: async id => w.finished?.includes(id) ?? false,
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
  test('a delivery event does not deadlock the engine timer that is holding the serial event bus', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let emitted = false
    try {
      await emitEvent('subtarefa.preparada', { subtarefa: 'g1' }, { emit: async () => { emitted = true; await held } })
      expect(emitted).toBe(true)
    } finally { release() }
  }, 1000)
  test('extending an existing piece retains every explicit request link', async () => {
    const requests = ['p-1', 'p-2'].map(id => ({ id, taskId: 't1', sessionId: 'old', text: id, at: '2026-11-07T01:00:00Z', state: 'open', linkedSubtaskIds: [] as string[] }))
    const h = harness({}, { requests: async () => requests })
    await h.svc.stage('s1', {}, 'leader', { pedidoId: 'p-1' })
    await h.svc.stage('s1', {}, 'leader', { pedidoId: 'p-2' })
    expect((await h.svc.get('s1'))?.pedidoIds).toEqual(['p-1', 'p-2'])
    expect((await h.svc.tick()).actions.filter(a => a.startsWith('request-wake'))).toEqual([])
  })
  test('an unstaged request wakes a busy leader at 10 minutes, follows its replacement and retains cadence across restart', async () => {
    const request = { id: 'p-1', taskId: 't1', sessionId: 'retired', text: 'Fix the history column', at: '2026-11-07T02:00:00.000Z', state: 'open', linkedSubtaskIds: [] as string[] }
    const requests = async () => [request]
    const h = harness({}, { requests })
    h.advance(10 * 60_000 - 1)
    expect((await h.svc.tick()).actions).toEqual([])
    h.advance(1)
    expect((await h.svc.tick()).actions).toContain('request-wake leader:p-1')
    expect(h.calls.session[0]?.text).toContain('agentistics_task_stage')
    expect(h.calls.owner).toEqual([])
    h.w.sessions = [{ ...h.w.sessions[0]!, id: 'replacement' }]
    h.advance(1)
    expect((await h.svc.tick()).actions).toContain('request-wake replacement:p-1')
    const restarted = harness({ sessions: h.w.sessions }, { requests })
    restarted.advance(10 * 60_000 + 1)
    expect((await restarted.svc.tick()).actions).toEqual([])
    await restarted.svc.stage('s1', {}, 'replacement', { pedidoId: request.id })
    restarted.advance(31 * 60_000)
    expect((await restarted.svc.tick()).actions.filter(a => a.startsWith('request-wake'))).toEqual([])
  })

  test('failed request wakes retry; a linked member whose group is staged needs no reminder', async () => {
    const request = { id: 'p-1', taskId: 't1', sessionId: 'old', text: 'Fix the queue', at: '2026-11-07T01:00:00.000Z', state: 'linked', linkedSubtaskIds: ['s1'] }
    const h = harness({ wakeOk: false }, { requests: async () => [request] })
    const base = h.facts.subtask
    h.facts.subtask = async id => { const s = await base(id); return s ? { ...s, staged: undefined } : null }
    expect((await h.svc.tick()).actions).toContain('request-wake-failed leader:p-1')
    h.w.wakeOk = true
    expect((await h.svc.tick()).actions).toContain('request-wake leader:p-1')
    const original = (await base('s1'))!
    h.facts.subtask = async id => id === 's1' ? { ...original, groupMember: true, parentGroupId: 'g1' } : id === 'g1' ? { ...original, id } : null
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect(h.calls.owner).toEqual([])
    const ops = deliveryHostOps(async () => h.svc, () => h.facts)
    expect(await ops['predispatch-completo']({ subtaskIds: ['s1'] })).toEqual({ ok: true, complete: ['s1'], incomplete: [] })
  })

  test('a staged member joining a group is folded into that group once', async () => {
    const h = harness()
    await h.svc.stage('s1', {}, 'leader')
    const original = await h.facts.subtask('s1')
    let groupDraft = { prompt: 'Group work', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }
    h.facts.subtask = async id => id === 's1' ? { ...original!, groupMember: true, parentGroupId: 'g1' }
      : id === 'g1' ? { ...original!, id, title: 'Group', staged: groupDraft } : null
    const tick = await h.svc.tick()
    expect(tick.actions).toContain('fold s1:g1')
    expect((await h.svc.get('s1'))?.dequeued?.reason).toContain('g1')
    expect((await h.svc.get('g1'))?.phase).toBe('fila')
    expect((await h.svc.list()).filter(r => r.phase === 'fila' && !r.dequeued).map(r => r.subtaskId)).toEqual(['g1'])
    expect((await h.svc.tick()).actions).not.toContain('fold s1:g1')
  })

  test('staging proposes extending queued work in the same area, excluding withdrawn pieces', async () => {
    const h = harness()
    const base = h.facts.subtask
    h.facts.subtask = async id => {
      const sub = await base(id)
      return sub ? { ...sub, staged: { ...sub.staged, prompt: `Fix packages/web/src/pages/LivePage.tsx for ${id}` } } : null
    }
    await h.svc.stage('s1', {}, 'leader')
    const second = await h.svc.stage('s2', {}, 'leader')
    expect(second.ok && second.warnings.join(' ')).toContain('encaixe: s1')
    await h.svc.dequeue('s1', 'superseded', 'leader')
    const again = await h.svc.stage('s2', {}, 'leader')
    expect(again.ok && again.warnings.join(' ')).not.toContain('encaixe: s1')
  })

  test.each(['in_review', 'done', 'abandoned'])('tick removes stale queued work when the board says %s, once with an audit comment', async status => {
    const h = harness()
    await h.svc.stage('s1', {}, 'leader')
    h.w.status = status
    expect((await h.svc.transition('s1', 'executando', {}, 'leader')).ok).toBe(false)
    expect((await h.svc.stageRun('s1', 'leader')).ok).toBe(false)
    expect((await h.svc.tick()).actions).toContain('dequeue s1')
    expect((await h.svc.get('s1'))!.dequeued?.reason).toContain(status)
    expect(h.calls.comments).toHaveLength(1)
    expect(h.calls.status).toHaveLength(1) // staging only; cleanup never rewrites the board
    expect((await h.svc.tick()).actions).not.toContain('dequeue s1')
    expect(h.calls.comments).toHaveLength(1)
    expect(h.calls.owner).toHaveLength(0)
  })

  test('dequeue requires the task leader and a reason; preserves the record and refuses dispatch until restaged', async () => {
    const h = harness()
    await h.svc.stage('s1', {}, 'leader')
    expect((await h.svc.dequeue('s1', 'superseded', 'author')).ok).toBe(false)
    expect((await h.svc.dequeue('s1', '', 'leader')).ok).toBe(false)
    expect((await h.svc.dequeue('s1', 'superseded by another piece', 'leader')).ok).toBe(true)
    expect((await h.svc.get('s1'))!.dequeued).toMatchObject({ actor: 'leader', reason: 'superseded by another piece' })
    expect(h.calls.comments).toHaveLength(1)
    expect((await h.svc.stageRun('s1', 'leader')).ok).toBe(false)
    expect((await h.svc.transition('s1', 'executando', {}, 'leader')).ok).toBe(false)
    expect((await h.svc.dequeue('s1', 'superseded by another piece', 'leader')).ok).toBe(true)
    expect(h.calls.comments).toHaveLength(1)
    expect((await h.svc.stage('s1', {}, 'leader')).ok).toBe(true)
    expect((await h.svc.get('s1'))!.dequeued).toBeUndefined()
  })

  test('dequeue refuses work that has started', async () => {
    const h = harness()
    await h.svc.transition('s1', 'executando', {}, 'leader')
    expect((await h.svc.dequeue('s1', 'stop', 'leader')).ok).toBe(false)
  })

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

  test('a step report on a piece with NO delivery record writes only the board event — nothing is adopted into the flow', async () => {
    const { svc, calls } = harness()
    expect(await svc.get('s1')).toBeNull()
    expect(await svc.stepEvent('s1', 3, 'worker')).toEqual({ ok: true, status: 200, step: 3, recorded: 'event' })
    expect(calls.steps).toEqual([3])
    expect(await svc.get('s1')).toBeNull()
  })
  test('the record-less step report refuses a bad number and an unknown subtask', async () => {
    const { svc, calls } = harness()
    expect(await svc.stepEvent('s1', 0, 'worker')).toMatchObject({ ok: false, status: 400, code: 'bad_step' })
    expect(await svc.stepEvent('s1', 2.5, 'worker')).toMatchObject({ ok: false, code: 'bad_step' })
    expect(await svc.stepEvent('nope', 2, 'worker')).toMatchObject({ ok: false, status: 404, code: 'no_such_subtask' })
    expect(calls.steps).toEqual([])
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
    // A deferral takes the piece OUT of Bloqueado (r2): it is in the queue of the next batch, so there is nothing left to unblock.
    expect((await svc.get('s1'))!.phase).toBe('fila')
    expect((await svc.get('s1'))!.history.at(-1)!.detail).toContain('estava em qa')
    expect((await svc.unblock('s1', 'leader', 'GitHub back')).ok).toBe(false)
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

  test('autonomous ON: an out-of-authorisation block is never parked in Bloqueado — fila, next batch, board todo, one comment, one wake', async () => {
    const { svc, calls, advance } = harness()
    await walkToQa(svc)
    const woken = calls.session.length
    const comments = calls.comments.length
    const b = await svc.block('s1', 'fora_das_autorizacoes', 'spend money', 'leader')
    expect(b.ok && b.record).toMatchObject({ phase: 'fila', versionTarget: 'next', block: { reason: 'fora_das_autorizacoes', text: 'spend money', deferredAt: expect.any(String) } })
    expect((await svc.get('s1'))!.origin).toBeUndefined()
    expect(calls.status.at(-1)).toEqual({ id: 's1', phase: 'fila' })
    expect(calls.comments.slice(comments).filter(c => c.includes('adiada para o próximo lote'))).toHaveLength(1)
    expect(calls.session.slice(woken).filter(c => c.id === 'leader' && c.text.includes('adiada'))).toHaveLength(1)
    expect(calls.owner).toEqual([])
    // Nothing chases it afterwards.
    advance(3 * 3600_000)
    expect((await svc.tick()).actions).toEqual([])
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

describe('BLOQUEIO.ORFAO — a board-blocked piece with no delivery record is chased like any other', () => {
  const orphan = (over: Partial<BlockedSubtaskFact> = {}): BlockedSubtaskFact => ({ id: 's9', taskId: 't1', title: 'peça antiga', blockedBy: [], groupMember: false, since: '2026-11-07T01:50:00Z', ...over })

  test('QA: 60 legacy pieces do not send 60 wakes to one leader', async () => {
    const h = harness({ blocked: Array.from({ length: 60 }, (_, i) => orphan({ id: `s${100 + i}` })) })
    await h.svc.tick()
    expect(h.calls.session.length).toBeLessThanOrEqual(1)
  })

  test('QA: a finished sibling unblocks the adopted piece', async () => {
    let finished = false
    const h = harness({ blocked: [orphan({ id: 's2', blockedBy: ['s1'] })] })
    // Use the real service and disk store, with a board dependency that later completes.
    const base = h.svc
    await base.tick()
    const facts: GateFacts = {
      subtask: async id => ({ id, taskId: 't1', title: id, status: 'blocked', groupMember: false, blockedBy: ['s1'] }),
      sessions: async () => h.w.sessions, budgets: async () => [], memoryBytes: async () => null, topCap: async () => 2,
      git: async () => '', gh: async () => '{}',
    }
    const restarted = createDeliveryService({
      store: createDeliveryStore(join(dir, 'deliveries.json')), facts,
      board: { setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {}, comment: async () => {}, subtaskFinished: async () => finished, stage: async () => ({ ok: true }) },
      notify: { session: async () => true, owner: async () => {} }, autonomous: async () => true,
      emit: async () => {}, merge: async () => ({ ok: true, mergeSha: 'merge1', pr: 7 }), now: () => Date.parse('2026-11-07T02:01:00Z'),
    })
    finished = true
    await restarted.tick()
    expect((await restarted.get('s2'))!.phase).toBe('fila')
  })

  test('QA: a leader dying after adoption is replaced by the live leader', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    h.w.sessions = [{ id: 'replacement', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' }]
    h.w.wakeOk = false
    h.advance(31 * 60_000)
    await h.svc.tick()
    expect(h.calls.session.at(-1)!.id).toBe('replacement')
  })

  // The QA's original expectation here was that a group member IS adopted and stays parked in Bloqueado after its deferral. Both
  // halves are the defects the r2 brief fixes (6: a member is never a delivery of its own; 5: a deferral leaves Bloqueado).
  test('QA (r2 contract): a group member is never adopted; its block is chased through the group', async () => {
    const h = harness({ blocked: [orphan({ groupMember: true, since: '2026-10-25T12:00:00Z' })] })
    expect((await h.svc.tick()).actions).toEqual([])
    expect(await h.svc.get('s9')).toBeNull()
    expect(h.calls.session).toEqual([])
    expect(h.calls.comments).toEqual([])
  })

  test('QA: restart does not duplicate adoption comments or leader wakes', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    const restart = harness({ blocked: [orphan()] })
    expect((await restart.svc.tick()).actions).toEqual([])
    expect(restart.calls.comments).toEqual([])
    expect(restart.calls.session).toEqual([])
  })

  test.each(['done', 'abandoned'])('QA: an adopted piece later marked %s is never chased', async status => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = status
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual([])
  })

  test('adopted at bloqueado, the leader woken, then deferred after 2 h; a second tick is a no-op', async () => {
    const h = harness({ blocked: [orphan()] })
    const first = await h.svc.tick()
    expect(first.actions).toContain('adopt s9')
    const rec = (await h.svc.get('s9'))!
    expect(rec).toMatchObject({ phase: 'bloqueado', leaderSessionId: 'leader', block: { reason: 'pedido_de_bloqueio', unlocker: 'leader', since: '2026-11-07T01:50:00Z' } })
    // Woken on the adopting tick (no lastWakeAt yet), and told in a comment.
    expect(first.actions).toContain('wake s9')
    expect(h.calls.session.filter(c => c.id === 'leader' && c.text.includes('[entrega s9]'))).toHaveLength(1)
    const commentsAfterFirst = h.calls.comments.length
    // The same minute again: nothing adopted, nobody woken, no new comment.
    const second = await h.svc.tick()
    expect(second.actions).toEqual([])
    expect(h.calls.comments.length).toBe(commentsAfterFirst)
    expect(h.calls.session.filter(c => c.text.includes('[entrega s9]'))).toHaveLength(1)
    // Past 30 min the leader is woken again; past 2 h the piece is deferred (once).
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake s9'])
    h.advance(95 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['defer s9'])
    expect((await h.svc.get('s9'))!.block!.deferredAt).toBeTruthy()
    expect((await h.svc.tick()).actions).toEqual([])
    expect(h.calls.emits.filter(e => e.type === 'entrega.adiada')).toHaveLength(1)
    // The owner is never called, in autonomous mode or any other.
    expect(h.calls.owner).toEqual([])
  })

  test('a thirteen-day-old block is deferred on the very tick that adopts it', async () => {
    const h = harness({ blocked: [orphan({ since: '2026-10-25T12:00:00Z' })] })
    const t = await h.svc.tick()
    expect(t.actions).toEqual(['adopt s9', 'defer s9'])
    expect(h.calls.comments.some(c => c.includes('ADIADA'))).toBe(true)
  })

  test('a leaderless task gets one comment and one warning, never a loop', async () => {
    const h = harness({ blocked: [orphan()], sessions: [{ id: 'worker', harness: 'claude', role: 'worker', alive: true, cwd: '/r', worktree: false, taskId: 't1' }] })
    expect((await h.svc.tick()).actions).toEqual(['adopt s9', 'no-leader s9', 'wake-failed s9'])
    expect(h.calls.comments.filter(c => c.includes('não tem líder vivo'))).toHaveLength(1)
    expect(h.calls.owner).toEqual([expect.objectContaining({ kind: 'aviso' })])
    expect(h.calls.session).toEqual([])
    // Every later tick stays silent: no comment, no bell.
    const again = await h.svc.tick()
    expect(again.actions.every(a => a.startsWith('wake-failed'))).toBe(true)
    expect(h.calls.comments.filter(c => c.includes('não tem líder vivo'))).toHaveLength(1)
    expect(h.calls.owner).toHaveLength(1)
  })

  test('a leader that shows up later is picked up by the next tick', async () => {
    const h = harness({ blocked: [orphan()], sessions: [] })
    await h.svc.tick()
    expect((await h.svc.get('s9'))!.leaderSessionId).toBeUndefined()
    h.w.sessions = [{ id: 'leader2', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1', createdAt: '2026-11-07T02:00:00Z' }]
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake s9'])
    expect(h.calls.session.at(-1)!.id).toBe('leader2')
  })

  test('the leader filed on the piece wins over the task\'s newest leader', async () => {
    const h = harness({ blocked: [orphan()], sessions: [
      { id: 'newest', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1', createdAt: '2026-11-07T01:59:00Z' },
      { id: 'filed', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1', subtaskId: 's9', createdAt: '2026-11-07T01:00:00Z' },
      { id: 'dead', harness: 'claude', role: 'leader', alive: false, cwd: '/r', worktree: false, taskId: 't1', subtaskId: 's9', createdAt: '2026-11-07T01:58:00Z' },
    ] })
    await h.svc.tick()
    expect((await h.svc.get('s9'))!.leaderSessionId).toBe('filed')
  })

  test('a piece that already has a record is never re-adopted or touched', async () => {
    const h = harness({ blocked: [orphan({ id: 's1', since: '2026-10-25T12:00:00Z' })] })
    await h.svc.ensure('s1')
    const before = (await h.svc.get('s1'))!
    expect((await h.svc.tick()).actions).toEqual([])
    expect(await h.svc.get('s1')).toEqual(before)
  })

  test('an unfinished dependency is adopted as dependencia: the leader is not nagged, and it unblocks by itself', async () => {
    const h = harness({ blocked: [orphan({ id: 's2', blockedBy: ['s1'] })], status: 'todo' })
    const t = await h.svc.tick()
    expect(t.actions).toEqual(['adopt s2'])
    expect((await h.svc.get('s2'))!.block).toMatchObject({ reason: 'dependencia', unlocker: 'self' })
    expect(h.calls.session).toEqual([])
  })

  // ------------------------------------------------------------------------------------------------ r2 (QA findings)

  test('1 · a blocked TASK with no subtasks is a piece of its own, keyed by the task id, chased and deferred like the rest', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    expect((await h.svc.tick()).actions).toEqual(['adopt t7', 'wake t7'])
    expect(await h.svc.get('t7')).toMatchObject({ subtaskId: 't7', taskId: 't7', phase: 'bloqueado', adopted: 'board' })
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    expect(h.calls.status).toContainEqual({ id: 't7', phase: 'fila' })
  })

  test('1 · blockedPiecesOf lists a task only when it has no subtasks of its own, and never a closed piece', () => {
    const t = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, title: id, status, updatedAt: '2026-11-01T00:00:00Z', ...over })
    const s = (id: string, taskId: string, status: string, over: Record<string, unknown> = {}) => ({ id, taskId, title: id, status, updatedAt: '2026-11-02T00:00:00Z', ...over })
    const out = blockedPiecesOf({
      tasks: [t('t1', 'blocked', { blockedReason: 'esperando a chave' }), t('t2', 'blocked'), t('t3', 'done'), t('t4', 'blocked')],
      subtasks: [s('s1', 't2', 'in_progress'), s('s2', 't3', 'blocked')],
    })
    expect(out.map(p => p.id)).toEqual(['t1', 't4', 's2'])
    expect(out.find(p => p.id === 't1')).toMatchObject({ taskId: 't1', reason: 'esperando a chave', groupMember: false })
  })

  test('2 · sixty blocked pieces are ONE message to the leader per tick, adoption is capped and the rest comes on the next ticks', async () => {
    const h = harness({ blocked: Array.from({ length: 60 }, (_, i) => orphan({ id: `s${100 + i}`, title: `peça ${i}` })) })
    const first = await h.svc.tick()
    expect(first.actions.filter(a => a.startsWith('adopt '))).toHaveLength(20)
    expect(h.calls.session).toHaveLength(1)
    expect(h.calls.session[0]!.text).toContain('20 peças bloqueadas')
    expect(h.calls.session[0]!.text).toContain('e mais 15')
    expect(h.calls.owner).toEqual([])
    // The next tick adopts the next batch and sends one more message — the first batch is not woken again inside 30 min.
    const second = await h.svc.tick()
    expect(second.actions.filter(a => a.startsWith('adopt '))).toHaveLength(20)
    expect(h.calls.session).toHaveLength(2)
    expect((await h.svc.list()).length).toBe(40)
  })

  test('2 · no leader for a whole batch is ONE bell, not one per piece', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' }), orphan({ id: 's2' }), orphan({ id: 's3' })], sessions: [] })
    await h.svc.tick()
    expect(h.calls.owner).toHaveLength(1)
    expect(h.calls.owner[0]!.text).toContain('3 peças')
  })

  test('3 · an adopted piece the board moved to done/abandoned leaves the flow quietly: record dropped, nothing said, nothing woken', async () => {
    for (const status of ['done', 'abandoned']) {
      const h = harness({ blocked: [orphan({ id: 's1' })] })
      await h.svc.tick()
      const said = { comments: h.calls.comments.length, session: h.calls.session.length }
      h.w.blocked = []
      h.w.status = status
      h.advance(31 * 60_000)
      expect((await h.svc.tick()).actions).toEqual([])
      expect(await h.svc.get('s1')).toBeNull()
      expect({ comments: h.calls.comments.length, session: h.calls.session.length }).toEqual(said)
    }
  })

  test('3 · an adopted piece unblocked on the board is dropped (no leftover record) and the board status is left as the person set it', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = 'in_progress'
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['released s1'])
    expect(await h.svc.get('s1')).toBeNull()
    expect(h.calls.status).toEqual([])
    expect(h.calls.session).toHaveLength(1)
  })

  test('3 · a board that cannot be read never drops or releases an adopted piece', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.status = 'done'
    const down = createDeliveryService({
      store: createDeliveryStore(join(dir, 'deliveries.json')),
      facts: { blockedSubtasks: async () => { throw new Error('board down') }, pieceStatus: async () => 'done', subtask: async () => null, sessions: async () => h.w.sessions, budgets: async () => [], memoryBytes: async () => null, topCap: async () => 2, git: async () => '', gh: async () => '{}' },
      board: { setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {}, comment: async () => {}, subtaskFinished: async () => false, stage: async () => ({ ok: true }) },
      notify: { session: async () => true, owner: async () => {} }, autonomous: async () => true, emit: async () => {},
      now: () => Date.parse('2026-11-07T02:05:00Z'),
    })
    await down.tick()
    expect(await down.get('s1')).toMatchObject({ phase: 'bloqueado' })
  })

  test('4 · a leader that died after adoption is replaced before the wake, and a failed wake waits its 30 minutes instead of repeating every minute', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    h.w.sessions = [{ id: 'replacement', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' }]
    h.w.wakeOk = false
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake-failed s9'])
    expect(h.calls.session.at(-1)!.id).toBe('replacement')
    expect((await h.svc.get('s9'))!.leaderSessionId).toBe('replacement')
    const tried = h.calls.session.length
    for (let i = 0; i < 5; i++) { h.advance(60_000); expect((await h.svc.tick()).actions).toEqual([]) }
    expect(h.calls.session).toHaveLength(tried)
    h.w.wakeOk = true
    h.advance(30 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake s9'])
  })

  test('4 · with a dead leader and no replacement the wake is still tried (once per cadence)', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    h.w.sessions = []
    h.w.wakeOk = false
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake-failed s9'])
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([])
  })

  test('5 · a deferral takes the piece OUT of Bloqueado: back to fila, next batch, the block kept as history, the board follows, one wake', async () => {
    const h = harness({ blocked: [orphan({ title: 'peça antiga', reason: 'esperando o token' })] })
    await h.svc.tick()
    const woken = h.calls.session.length
    h.advance(121 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['defer s9'])
    expect(await h.svc.get('s9')).toMatchObject({ phase: 'fila', versionTarget: 'next', block: { text: 'esperando o token', deferredAt: expect.any(String) } })
    expect((await h.svc.get('s9'))!.origin).toBeUndefined()
    expect(h.calls.status).toContainEqual({ id: 's9', phase: 'fila' })
    expect(h.calls.comments.some(c => /adiada para o próximo lote \(bloqueio de 2 h: esperando o token\)/.test(c))).toBe(true)
    expect(h.calls.session).toHaveLength(woken + 1)
    // Out of Bloqueado, nobody chases it again, and the board still listing it blocked does not re-adopt it.
    h.advance(3 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect(h.calls.session).toHaveLength(woken + 1)
  })

  test('5 · the same rule holds for a FLOW piece blocked inside the flow', async () => {
    const h = harness()
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'owner')
    expect((await h.svc.transition('s1', 'executando', {}, 'leader')).ok).toBe(true)
    expect((await h.svc.block('s1', 'externo', 'o CI está fora do ar', 'leader')).ok).toBe(true)
    h.advance(121 * 60_000)
    const t = await h.svc.tick()
    expect(t.actions).toContain('defer s1')
    expect(await h.svc.get('s1')).toMatchObject({ phase: 'fila', versionTarget: 'next' })
    expect(h.calls.status.at(-1)).toEqual({ id: 's1', phase: 'fila' })
  })

  test('5 · a deferred adopted piece the board blocks AGAIN later is chased afresh', async () => {
    const h = harness({ blocked: [orphan({ since: '2026-11-07T01:00:00Z' })] })
    await h.svc.tick()
    h.advance(3 * 3600_000)
    await h.svc.tick()
    expect((await h.svc.get('s9'))!.phase).toBe('fila')
    h.w.blocked = [orphan({ since: new Date(Date.parse('2026-11-07T02:00:00Z') + 3.5 * 3600_000).toISOString() })]
    h.advance(3600_000)
    expect((await h.svc.tick()).actions).toContain('adopt s9')
    expect((await h.svc.get('s9'))!.phase).toBe('bloqueado')
  })

  test('6 · a group member is never adopted as its own delivery', async () => {
    const h = harness({ blocked: [orphan({ id: 's5', groupMember: true }), orphan({ id: 's6' })] })
    const t = await h.svc.tick()
    expect(t.actions.filter(a => a.startsWith('adopt'))).toEqual(['adopt s6'])
    expect(await h.svc.get('s5')).toBeNull()
  })

  test('6 · a blocked member counts for its GROUP piece (the Live card), and a closed group is not chased', () => {
    const s = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, taskId: 't1', title: id, status, updatedAt: '2026-11-02T00:00:00Z', ...over })
    const out = blockedPiecesOf({
      tasks: [],
      subtasks: [
        s('g1', 'in_progress', { isGroup: true }), s('m1', 'blocked', { parentGroupId: 'g1', updatedAt: '2026-11-03T00:00:00Z' }), s('m2', 'blocked', { parentGroupId: 'g1', updatedAt: '2026-11-01T00:00:00Z' }),
        s('g2', 'done', { isGroup: true }), s('m3', 'blocked', { parentGroupId: 'g2' }),
      ],
    })
    expect(out.map(p => p.id)).toEqual(['g1'])
    expect(out[0]).toMatchObject({ groupMember: false, since: '2026-11-01T00:00:00Z' })
  })

  // ------------------------------------------------------------------------------------------------ r3 (re-QA findings)

  test('r3 · 1 · an adopted piece that entered the real flow keeps its record when the board later reads done', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.get('s1'))!.adopted).toBe('board')
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc) // fila → executando → qa: head sha + gate evidence
    expect((await h.svc.block('s1', 'externo', 'o CI está fora do ar', 'leader')).ok).toBe(true)
    h.w.blocked = []
    h.w.status = 'done'
    await h.svc.tick()
    const rec = (await h.svc.get('s1'))!
    expect(rec).not.toBeNull()
    expect(rec.headSha).toBe('abc123')
    expect(rec.adopted).toBeUndefined()
    expect(rec.history.map(x => x.to)).toContain('qa')
    expect(rec.phase).toBe('bloqueado')
  })

  test('r3 · 1 · a record that still carries the adoption marker but has real history is never dropped, and loses the marker', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'preso', 'leader')).ok).toBe(true)
    // a record written by an older build: the flow history is real, the marker was never cleared
    await createDeliveryStore(join(dir, 'deliveries.json')).update(d => { d.deliveries.s1!.adopted = 'board' })
    h.w.blocked = []
    h.w.status = 'abandoned'
    await h.svc.tick()
    const rec = (await h.svc.get('s1'))!
    expect(rec).not.toBeNull()
    expect(rec.headSha).toBe('abc123')
    expect(rec.adopted).toBeUndefined()
  })

  test('r3 · 2 · a failed board write on a deferral is retried on the next tick — silently, once per tick — until it lands', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    await h.svc.tick()
    h.w.boardWriteFails = true
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    expect((await h.svc.get('t7'))!.phase).toBe('fila')
    const writes = h.calls.status.length, comments = h.calls.comments.length, wakes = h.calls.session.length
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([]) // refused again: still pending, nothing said
    expect(h.calls.status.length).toBe(writes + 1)
    expect(h.calls.comments.length).toBe(comments)
    expect(h.calls.session.length).toBe(wakes)
    h.w.boardWriteFails = false
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual(['requeue t7'])
    expect(h.calls.status.at(-1)).toEqual({ id: 't7', phase: 'fila' })
    const after = h.calls.status.length
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect(h.calls.status.length).toBe(after) // landed: no more writes
    expect(h.calls.comments.length).toBe(comments)
    expect(h.calls.session.length).toBe(wakes)
  })

  test('r4 · a board move the board keeps refusing is retried a capped number of ticks, then dropped with ONE notice (no loop)', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    await h.svc.tick()
    h.w.boardWriteFails = true
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    const wakes = h.calls.session.length, comments = h.calls.comments.length
    let gaveUp = 0
    for (let i = 0; i < 30; i++) {
      h.advance(60_000)
      gaveUp += (await h.svc.tick()).actions.filter(a => a === 'requeue-gave-up t7').length
    }
    expect(gaveUp).toBe(1)
    expect((await h.svc.get('t7'))!.block!.boardMovePending).toBeUndefined()
    expect(h.calls.session.length).toBe(wakes + 1) // exactly one notice to the leader
    expect(h.calls.comments.length).toBe(comments)
    const writes = h.calls.status.length
    h.advance(60_000)
    await h.svc.tick()
    expect(h.calls.status.length).toBe(writes) // no more writes after the cap
  })

  test('r4 · a pure adoption the board releases to In review is dropped, and a later board block is adopted afresh', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = 'in_review'
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual(['released s1'])
    expect(await h.svc.get('s1')).toBeNull()
  })

  test('r3 · 3 · a blocked task keeps its blockedBy: discovery carries it, and adoption waits for the dependency instead of waking the leader', async () => {
    const t = { id: 't7', title: 't7', status: 'blocked', updatedAt: '2026-11-07T01:50:00Z', blockedBy: ['t0'] }
    const [piece] = blockedPiecesOf({ tasks: [t], subtasks: [] })
    expect(piece).toMatchObject({ id: 't7', blockedBy: ['t0'] })
    const h = harness({ blocked: [piece!], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    expect((await h.svc.tick()).actions).toEqual(['adopt t7'])
    expect((await h.svc.get('t7'))!.block).toMatchObject({ reason: 'dependencia', unlocker: 'self' })
    expect(h.calls.session).toEqual([])
    // the dependency finishes: the completed-dependency reconciliation unblocks the task-level record by itself
    h.w.finished = ['t0']
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toContain('unblock t7')
    expect((await h.svc.get('t7'))!.phase).toBe('fila')
  })
})

describe('HOSTILE r3 re-QA (Opus) — BLOQUEIO.ORFAO', () => {
  const orphan = (over: Partial<BlockedSubtaskFact> = {}): BlockedSubtaskFact => ({ id: 's9', taskId: 't1', title: 'peça antiga', blockedBy: [], groupMember: false, since: '2026-11-07T01:50:00Z', ...over })

  test('HQ1 · a real flow block whose board piece the person CLOSED is never reopened on the board by the 2 h deferral', async () => {
    const h = harness()
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'CI fora do ar', 'leader')).ok).toBe(true)
    h.w.status = 'done' // the person closed it on the board
    const before = h.calls.status.length
    h.advance(2 * 3600_000 + 60_000)
    await h.svc.tick()
    expect(h.calls.status.slice(before).filter(s => s.id === 's1')).toEqual([])
  })

  test('HQ1b · same through adoption: adopt → unblock → real flow → block → board done → deferral must not reopen it', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'preso', 'leader')).ok).toBe(true)
    h.w.blocked = []
    h.w.status = 'done'
    await h.svc.tick()
    expect(await h.svc.get('s1')).not.toBeNull() // r3 fix holds: real history kept
    const before = h.calls.status.length
    h.advance(2 * 3600_000 + 60_000)
    await h.svc.tick()
    expect((await h.svc.get('s1'))!.headSha).toBe('abc123')
    expect(h.calls.status.slice(before).filter(s => s.id === 's1')).toEqual([])
  })

  test('HQ2 · a pure adoption released by the board, then blocked on the board AGAIN, is chased afresh', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = 'todo'
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual(['released s1'])
    h.advance(3600_000) // 03:01
    h.w.status = 'blocked'
    h.w.blocked = [orphan({ id: 's1', since: '2026-11-07T03:00:00Z' })]
    const t = await h.svc.tick()
    expect(t.actions).toContain('adopt s1')
    expect((await h.svc.get('s1'))!.phase).toBe('bloqueado')
  })

  test('HQ3 · boardMovePending: the board piece goes done meanwhile → the flag clears, no write, nothing said (expected to pass)', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    await h.svc.tick()
    h.w.boardWriteFails = true
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    expect((await h.svc.get('t7'))!.block!.boardMovePending).toBe(true)
    const writes = h.calls.status.length, comments = h.calls.comments.length, wakes = h.calls.session.length
    h.w.blocked = [] // closed on the board
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect((await h.svc.get('t7'))!.block!.boardMovePending).toBeUndefined()
    expect(h.calls.status.length).toBe(writes)
    expect(h.calls.comments.length).toBe(comments)
    expect(h.calls.session.length).toBe(wakes)
  })

  test('HQ4 · pure → real → defers again → board done: record kept, no adoption marker, never dropped (expected to pass)', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'preso', 'leader')).ok).toBe(true)
    h.w.blocked = []
    h.advance(2 * 3600_000 + 60_000)
    expect((await h.svc.tick()).actions).toContain('defer s1')
    const r = (await h.svc.get('s1'))!
    expect(r).toMatchObject({ phase: 'fila', versionTarget: 'next', headSha: 'abc123' })
    expect(r.adopted).toBeUndefined()
    h.w.status = 'done'
    h.advance(60_000)
    await h.svc.tick()
    expect(await h.svc.get('s1')).not.toBeNull()
  })

  // LOW-2 (r3 re-QA): a dependency-blocked adoption deferred after 2 h. Leader decision r4: leave as is (the deferral rule predates
  // this branch); the pre-dispatch gap is documented, not fixed here.
  test.skip('HQ5 · a piece adopted on an UNFINISHED dependency is not put back in the queue (board To do) while that dependency is open', async () => {
    const h = harness({ blocked: [orphan({ id: 's2', blockedBy: ['s1'], since: '2026-10-25T12:00:00Z' })] })
    await h.svc.tick()
    expect(h.calls.status.filter(s => s.id === 's2')).toEqual([])
    expect((await h.svc.get('s2'))!.phase).toBe('bloqueado')
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

describe('FLUXO.CICLO-COMPLETO — no stage after the review depends on someone remembering', () => {
  const MERGED_PR = { number: 7, state: 'MERGED', headRefOid: 'abc123', headRefName: 'feat/x', mergeCommit: { oid: 'merge1' }, mergedAt: '2026-11-07T03:00:00Z' }
  const toReview = async (h: ReturnType<typeof harness>) => {
    await walkToQa(h.svc)
    expect((await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'green' }, 'qa')).ok).toBe(true)
  }

  test('the leader merged the PR and never moved the piece: the tick moves revisao_lider → ci, then publishes from the tag that contains the merge', async () => {
    const h = harness({ prList: { 'feat/x': [MERGED_PR] } })
    await toReview(h)
    const t1 = await h.svc.tick()
    expect(t1.actions).toContain('merge-detected s1:#7')
    let rec = (await h.svc.get('s1'))!
    expect(rec.phase).toBe('ci')
    expect(rec).toMatchObject({ pr: 7, mergeSha: 'merge1', mergeDetected: { pr: 7, via: 'branch feat/x' } })
    expect(rec.gates.mergeado?.ok).toBe(true)
    expect(rec.gates.delecoes?.ok).toBe(true)
    expect(rec.review).toMatchObject({ decision: 'ok', by: 'flow:entrega' })
    // ci → publicado: the first tag containing the merge (the planned 2.200.8 is a plan, not proof).
    h.w.tags = [{ name: 'v2.201.1', commit: { sha: 'tag2011' } }]
    h.w.releaseRuns = [{ databaseId: 3, status: 'completed', conclusion: 'success', headSha: 'tag2011', updatedAt: '2026-11-07T04:00:00Z' }]
    h.advance(61_000)
    expect((await h.svc.tick()).actions).toContain('publish s1:true')
    rec = (await h.svc.get('s1'))!
    expect(rec.phase).toBe('publicado')
    expect(rec.tag).toBe('v2.201.1')
    expect(rec.history.map(x => x.to)).toEqual(['executando', 'qa', 'revisao_lider', 'ci', 'publicado'])
  })

  test('a merge from another sha is REFUSED with the reason, recorded as the tick note, and never loops', async () => {
    const h = harness({ prList: { 'feat/x': [{ ...MERGED_PR, headRefOid: 'other99' }] }, pr: { number: 7, state: 'MERGED', headRefOid: 'other99', mergeCommit: { oid: 'merge1' } } })
    await toReview(h)
    const t1 = await h.svc.tick()
    expect(t1.actions.some(a => a.startsWith('merge-refused s1'))).toBe(true)
    const rec = (await h.svc.get('s1'))!
    expect(rec.phase).toBe('revisao_lider')
    expect(rec.tickNote).toMatchObject({ phase: 'revisao_lider', failed: true })
    expect(rec.tickNote!.reason).toContain('not the sha QA approved')
    expect(rec.mergeDetected).toBeUndefined()
    // The next tick inside the back-off does not look again (no loop of gh calls / transitions).
    const before = h.calls.gh.length
    expect((await h.svc.tick()).actions.filter(a => a.startsWith('merge'))).toEqual([])
    expect(h.calls.gh.length).toBe(before)
  })

  test('no PR found: the piece stays with a readable reason; the PR found later moves it', async () => {
    const h = harness()
    await toReview(h)
    expect((await h.svc.tick()).actions).toContain('merge-none s1')
    expect((await h.svc.get('s1'))!.tickNote?.reason).toContain('no merged PR proven')
    h.w.prList = { 'feat/x': [MERGED_PR] }
    h.advance(61_000)
    expect((await h.svc.tick()).actions).toContain('merge-detected s1:#7')
  })

  test('a merged PR is found from the sha QA approved when the piece records no branch', async () => {
    const store = createDeliveryStore(join(dir, 'deliveries.json'))
    const h = harness({ commitPulls: { abc123: [{ number: 9, state: 'closed', merged_at: '2026-11-07T03:00:00Z', merge_commit_sha: 'merge1', head: { sha: 'abc123', ref: 'feat/y' } }] }, pr: { number: 9, state: 'MERGED', headRefOid: 'abc123', mergeCommit: { oid: 'merge1' } } }, { store })
    await toReview(h)
    await store.update(doc => { delete doc.deliveries.s1!.branch })
    const t = await h.svc.tick()
    expect(t.actions).toContain('merge-detected s1:#9')
  })

  test('the review reminder goes to the LIVE leader (the successor after a hand-off) at 30 min, then every 2 h, at most 3 — never the owner', async () => {
    const h = harness()
    await toReview(h)
    const reminders = () => h.calls.session.filter(s => s.text.includes('[entrega revisão]'))
    h.advance(29 * 60_000)
    await h.svc.tick()
    expect(reminders()).toHaveLength(0)
    // The recorded leader handed off: the successor (newest live leader of the task) is the one reminded.
    h.w.sessions = h.w.sessions.map(s => (s.id === 'leader' ? { ...s, alive: false } : s))
    h.w.sessions.push({ id: 'leader2', harness: 'claude', model: 'claude-opus-5-5', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1', createdAt: '2026-11-07T05:00:00Z' })
    h.advance(2 * 60_000)
    await h.svc.tick()
    expect(reminders().map(r => r.id)).toEqual(['leader2'])
    expect(reminders()[0]!.text).toContain('s1')
    expect(reminders()[0]!.text).toContain('no merged PR proven')
    for (let i = 0; i < 2; i++) { h.advance(60 * 60_000); await h.svc.tick() }
    expect(reminders()).toHaveLength(2) // the second one, 2 h after the first
    for (let i = 0; i < 10; i++) { h.advance(60 * 60_000); await h.svc.tick() }
    expect(reminders()).toHaveLength(3) // capped
    expect(h.calls.owner).toEqual([])
    expect((await h.svc.get('s1'))!.reviewNudge).toMatchObject({ phase: 'revisao_lider', sent: 3 })
  })

  test('a leader action restarts the reminder clock', async () => {
    const h = harness()
    await toReview(h)
    h.advance(25 * 60_000)
    await h.svc.configure('s1', { versionTarget: '2.203.0' }, 'leader')
    h.advance(10 * 60_000)
    await h.svc.tick()
    expect(h.calls.session.filter(s => s.text.includes('[entrega revisão]'))).toHaveLength(0)
    h.advance(21 * 60_000)
    await h.svc.tick()
    expect(h.calls.session.filter(s => s.text.includes('[entrega revisão]'))).toHaveLength(1)
  })

  test('reconcile --release: dry run reports what would move and what cannot be proven; --apply writes it and announces nothing per piece', async () => {
    const h = harness({ status: 'in_review', prList: { 's1 in:title,body': [MERGED_PR] }, tags: [{ name: 'v2.201.1', commit: { sha: 'tag2011' } }], releaseRuns: [{ databaseId: 3, status: 'completed', conclusion: 'success', headSha: 'tag2011', updatedAt: '2026-11-07T04:00:00Z' }] }, {
      reviewPieces: async () => [{ id: 's1', taskId: 't1', title: 's1', status: 'in_review' }, { id: 's2', taskId: 't1', title: 's2', status: 'in_review' }],
    })
    const dry = await h.svc.reconcile({}, 'owner')
    expect(dry.ok).toBe(true)
    if (!dry.ok) return
    expect(dry.apply).toBe(false)
    expect(dry.entries.find(e => e.subtaskId === 's1')).toMatchObject({ from: 'revisao_lider', to: 'publicado', pr: 7, tag: 'v2.201.1' })
    expect(dry.entries.find(e => e.subtaskId === 's2')?.reason).toContain('no merged PR proven')
    expect(await h.svc.get('s1')).toBeNull() // nothing written
    // A worker cannot apply it.
    const denied = await h.svc.reconcile({ apply: true }, 'author')
    expect(!denied.ok && denied.code).toBe('so_o_lider')
    const applied = await h.svc.reconcile({ apply: true }, 'leader')
    expect(applied.ok && applied.entries.find(e => e.subtaskId === 's1')).toMatchObject({ to: 'publicado', applied: true })
    const rec = (await h.svc.get('s1'))!
    expect(rec.phase).toBe('publicado')
    // Adopted from the board's In review, then the two reconciliation moves.
    expect(rec.history.map(x => `${x.to}:${x.actor}`)).toEqual(['revisao_lider:flow:entrega', 'ci:flow:reconcile', 'publicado:flow:reconcile'])
    expect(await h.svc.get('s2')).toBeNull()
    expect(h.calls.owner).toEqual([])
    expect(h.calls.session).toEqual([])
    // Idempotent: a second run finds nothing left to move for s1.
    const again = await h.svc.reconcile({ apply: true }, 'leader')
    expect(again.ok && again.entries.map(e => e.subtaskId)).toEqual(['s2'])
  })

  test('e2e: an owner WORK request walks pedido → fila → executando → qa → revisao_lider → ci → publicado, the post-review stages through the tick only', async () => {
    const { classifyOwnerMessage } = await import('../flows/owner-intent')
    const { emitOwnerMessage } = await import('../flows/owner-message')
    const ask = 'Implementa o botão de exportar CSV na tela de custos'
    expect(classifyOwnerMessage(ask)).toBe('request')
    const events: Array<{ id: string; payload: Record<string, unknown> }> = []
    const outcome = await emitOwnerMessage({ id: 'leader', action: 'prompt', text: ask }, {
      flowsOn: () => true, row: async () => ({ id: 'leader', conversationId: 'conv-l', taskId: 't1' }), roleOf: async () => 'leader',
      mode: async () => undefined, emit: async e => { events.push(e); return true }, now: () => Date.parse('2026-11-07T02:00:00Z'),
      holdQuestion: async () => { throw new Error('a work request is never held') },
    })
    expect(outcome).toBe('emitted')
    const pedido = { id: 'p-e2e000000001', taskId: 't1', sessionId: 'leader', text: ask, at: '2026-11-07T02:00:00.000Z', state: 'open', linkedSubtaskIds: [] as string[] }
    let spawned = 0
    const h = harness({ prList: { 'feat/x': [MERGED_PR] } }, {
      requests: async () => [pedido],
      spawn: async () => { spawned++; return { ok: true as const, sessionId: 'author' } },
    })
    // The leader stages the piece for the pedido (the existing intake path).
    expect((await h.svc.stage('s1', { prompt: 'do it', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }, 'leader', { leaderSessionId: 'leader', pedidoId: pedido.id })).ok).toBe(true)
    // fila → executando: the queue asks the leader; with autonomous mode the 10-min timeout carries on as "sim".
    await h.svc.tick()
    h.advance(11 * 60_000)
    await h.svc.tick()
    expect(spawned).toBe(1)
    expect((await h.svc.get('s1'))!.phase).toBe('executando')
    // The author and the QA report (agent acts, as in production).
    expect((await h.svc.transition('s1', 'qa', {}, 'author')).ok).toBe(true)
    expect((await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'green' }, 'qa')).ok).toBe(true)
    // From here on NOTHING but the tick: merged PR → ci, green tag → publicado.
    h.advance(61_000)
    expect((await h.svc.tick()).actions).toContain('merge-detected s1:#7')
    h.w.tags = [{ name: 'v2.203.0', commit: { sha: 'tag2030' } }]
    h.w.releaseRuns = [{ databaseId: 5, status: 'completed', conclusion: 'success', headSha: 'tag2030', updatedAt: '2026-11-07T05:00:00Z' }]
    h.advance(61_000)
    expect((await h.svc.tick()).actions).toContain('publish s1:true')
    const rec = (await h.svc.get('s1'))!
    expect(rec.phase).toBe('publicado')
    expect(rec.pedidoIds).toEqual([pedido.id])
    expect(rec.history.map(x => x.to)).toEqual(['executando', 'qa', 'revisao_lider', 'ci', 'publicado'])
    expect(h.calls.owner.every(o => o.kind === 'aviso')).toBe(true)
  })
})
