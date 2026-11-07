/**
 * delivery/host.ts — the machine's side of the delivery service: the board, the fleet's composer, the
 * owner's bell, the engine bus. Every import is lazy so `agentop flow gate …` in a CLI loads only what the
 * one gate it runs needs. The decisions live in `machine.ts` / `gates.ts` / `service.ts`; nothing here decides.
 */
import { createDeliveryService, type DeliveryBoard, type DeliveryDeps, type DeliveryNotify, type DeliveryService } from './service'
import { defaultGateFacts } from './gates'
import { createDeliveryStore } from './store'
import { PHASE_STATUS, type DeliveryRecord, type Phase } from './machine'

/** The Live stage each phase must read as, so a created status is found again by the same reading. */
const LIVE_STAGE: Record<Phase, string> = {
  fila: 'queue', executando: 'running', qa: 'qa', ajuste: 'adjust', revisao_lider: 'leader', pr_merge: 'merge', ci: 'ci', publicado: 'published', bloqueado: 'blocked',
}

/** True when `id` names a TASK that no subtask shares the id with (the vigia keys a task-level piece by its task id). */
async function isTaskPiece(id: string): Promise<boolean> {
  const { loadTaskWorld } = await import('../sessions/task-source')
  const { book } = await loadTaskWorld()
  return !book.subtasks.some(s => s.id === id) && book.tasks.some(t => t.id === id)
}

export function defaultDeliveryBoard(): DeliveryBoard {
  const web = () => import('../sessions/task-web')
  return {
    async setPhaseStatus(subtaskId, phase) {
      const m = await web()
      const { stageOfStatus } = await import('../sessions/task-live')
      const want = PHASE_STATUS[phase]
      const statuses = await m.listStatuses()
      let id = statuses.find(s => s.id === want.id)?.id ?? statuses.find(s => stageOfStatus(s.id, s.label) === LIVE_STAGE[phase])?.id
      if (!id) {
        const made = await m.createStatus({ label: want.label, color: want.color })
        if (!made.ok) return { ok: false, message: made.message }
        id = made.status.id
      }
      // A TASK-level piece (BLOQUEIO.ORFAO: a blocked task with no subtasks) is keyed by the task id and moves the task itself.
      if (await isTaskPiece(subtaskId)) {
        const moved = await m.markTask(subtaskId, id as never, 'flow:entrega')
        return moved.ok ? { ok: true } : { ok: false, message: moved.message }
      }
      const out = await m.patchSubtask(subtaskId, { status: id as never })
      return out.ok ? { ok: true } : { ok: false, message: out.message }
    },
    async setCi(subtaskId, ci) { await (await web()).setSubtaskCi(subtaskId, ci) },
    async logStep(taskId, subtaskId, step, actor) { await (await web()).logSubtaskStep(taskId, subtaskId, step, actor) },
    async comment(taskId, subtaskId, body) { await (await web()).addComment(taskId, { author: 'flow:entrega', body, ...(subtaskId === taskId ? {} : { subtaskId }) }) },
    async subtaskFinished(subtaskId) {
      const { loadTaskWorld } = await import('../sessions/task-source')
      const { book } = await loadTaskWorld()
      return (book.subtasks.find(s => s.id === subtaskId) ?? book.tasks.find(t => t.id === subtaskId))?.status === 'done'
    },
    async stage(subtaskId, draft) {
      const { normalizeStagedSession } = await import('@agentistics/core')
      const normalized = normalizeStagedSession(draft)
      if (!normalized) return { ok: false, message: 'bad_staged_session: a staged session needs a prompt (and an absolute cwd, when given)' }
      const out = await (await web()).patchSubtask(subtaskId, { stagedSession: normalized })
      return out.ok ? { ok: true } : { ok: false, message: out.message }
    },
  }
}

export function defaultDeliveryNotify(): DeliveryNotify {
  return {
    async session(sessionId, text) {
      const { runFleetAction } = await import('../sessions/fleet-web')
      const out = await runFleetAction('en', { action: 'prompt', id: sessionId, text: `[from flow entrega · nudge]\n${text}` })
      return out.ok
    },
    async owner(text, kind) {
      const notify = (await (await import('../away')).defaultAwayDeps()).notify
      notify?.(text, kind === 'decisao' ? 'flow:entrega:decisao' : 'flow:entrega')
    },
  }
}

/** Autonomous mode: the global away state, or the delivery leader's own per-session `away`. */
export async function deliveryAutonomous(leaderSessionId?: string): Promise<boolean> {
  const [{ readPreferences }, { awayActive, parseAwayState }] = await Promise.all([import('../preferences'), import('@agentistics/core')])
  if (awayActive(parseAwayState((await readPreferences() as { away?: unknown }).away), Date.now())) return true
  if (!leaderSessionId) return false
  const row = (await (await import('../sessions/registry')).readRegistry()).find(r => r.id === leaderSessionId)
  return (row as { away?: boolean } | undefined)?.away === true
}

async function emitEvent(type: string, payload: Record<string, unknown>) {
  try {
    const { engine } = await import('../engine/load')
    await engine()?.flows?.emit?.({ type, id: `${type}:${String(payload.subtarefa ?? '')}:${Date.now()}`, payload })
  } catch { /* the record is authoritative; the bus is a courtesy */ }
  try { (await import('../sse')).broadcastFlowsChanged() } catch { /* a CLI has no SSE */ }
}

async function spawnStaged(r: DeliveryRecord, staged: Record<string, unknown>): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const { runFleetSpawn } = await import('../sessions/fleet-web')
  const out = await runFleetSpawn('en', {
    harness: staged.harness, cwd: staged.cwd, prompt: staged.prompt, model: staged.model, effort: staged.effort,
    ...(staged.account ? { account: staged.account } : {}),
    taskId: r.taskId, subtaskId: r.subtaskId, gateTaskId: r.taskId, gateSubtaskId: r.subtaskId,
    ...(typeof staged.label === 'string' ? { label: staged.label } : {}),
    ...(r.leaderSessionId ? { parent: r.leaderSessionId } : {}),
  })
  if (!out.ok || !out.id) return { ok: false, message: out.message }
  const filed = await (await import('../sessions/task-web')).attachSession(r.taskId, out.id, { subtaskId: r.subtaskId })
  if (!filed.ok) return { ok: false, message: `started ${out.id} but could not file it: ${(filed as { reason?: string }).reason ?? '?'}` }
  return { ok: true, sessionId: out.id }
}

async function mergePr(r: DeliveryRecord): Promise<{ ok: true; mergeSha: string; pr: number } | { ok: false; message: string }> {
  const facts = defaultGateFacts()
  const sessions = await facts.sessions()
  const author = sessions.find(s => s.id === r.authorSessionId)
  const cwd = author?.rootPath ?? author?.cwd
  if (!cwd) return { ok: false, message: 'the repository of the delivery is not known' }
  const ref = r.pr ? String(r.pr) : r.branch
  if (!ref) return { ok: false, message: 'no PR or branch recorded' }
  try {
    const view = JSON.parse(await facts.gh(cwd, ['pr', 'view', ref, '--json', 'number,headRefOid,state'])) as { number: number; headRefOid: string; state: string }
    if (r.qaSha && view.headRefOid !== r.qaSha) return { ok: false, message: `the PR head ${view.headRefOid.slice(0, 9)} is not the sha QA approved (${r.qaSha.slice(0, 9)})` }
    if (view.state !== 'MERGED') await facts.gh(cwd, ['pr', 'merge', String(view.number), '--squash', '--match-head-commit', view.headRefOid])
    const done = JSON.parse(await facts.gh(cwd, ['pr', 'view', String(view.number), '--json', 'state,mergeCommit'])) as { state: string; mergeCommit?: { oid?: string } }
    if (done.state !== 'MERGED' || !done.mergeCommit?.oid) return { ok: false, message: `PR #${view.number} is ${done.state}, not merged` }
    return { ok: true, mergeSha: done.mergeCommit.oid, pr: view.number }
  } catch (e) {
    return { ok: false, message: (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 2).join(' ') }
  }
}

let cached: DeliveryService | null = null
/** The process's delivery service (one store path, one set of deps). */
export function deliveryService(overrides: Partial<DeliveryDeps> = {}): DeliveryService {
  if (cached && Object.keys(overrides).length === 0) return cached
  const svc = createDeliveryService({
    store: createDeliveryStore(), facts: defaultGateFacts(), board: defaultDeliveryBoard(), notify: defaultDeliveryNotify(),
    autonomous: deliveryAutonomous, emit: emitEvent, spawn: spawnStaged, merge: mergePr, now: () => Date.now(), ...overrides,
  })
  if (Object.keys(overrides).length === 0) cached = svc
  return svc
}
