/**
 * delivery/host.ts — the machine's side of the delivery service: the board, the fleet's composer, the
 * owner's bell, the engine bus. Every import is lazy so `agentop flow gate …` in a CLI loads only what the
 * one gate it runs needs. The decisions live in `machine.ts` / `gates.ts` / `service.ts`; nothing here decides.
 */
import { createDeliveryService, type DeliveryBoard, type DeliveryDeps, type DeliveryNotify, type DeliveryService } from './service'
import { defaultGateFacts } from './gates'
import { createDeliveryStore } from './store'
import { PHASE_STATUS, type DeliveryRecord, type Phase } from './machine'
import { boardReviewTargets } from './review-board'

/** Uses the same pedidos view as the leader briefing and the existing MCP flow reader. */
export async function readOwnerRequests(): Promise<import('./service').OwnerRequestFact[] | null> {
  const { prepareOwnerRequestFlows } = await import('../flows/owner-message')
  if (!(await prepareOwnerRequestFlows())) return []
  const { engine } = await import('../engine/load')
  const view = await engine()?.flows?.read?.('pedidos', {}) as { pedidos?: import('./service').OwnerRequestFact[] } | null | undefined
  return Array.isArray(view?.pedidos) ? view.pedidos : null
}

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
    async session(sessionId, text, header) {
      const { runFleetAction } = await import('../sessions/fleet-web')
      // A system QUESTION (`fila · confirmar`) carries its own header line inside `text`; every other nudge wears the standard one.
      const body = header === undefined ? `[from flow entrega · nudge]\n${text}` : text
      const out = await runFleetAction('en', { action: 'prompt', id: sessionId, text: body })
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

export async function emitEvent(type: string, payload: Record<string, unknown>, bus?: { emit?(event: { type: string; id: string; payload: Record<string, unknown> }): Promise<unknown> }) {
  try {
    const flows = bus ?? (await import('../engine/load')).engine()?.flows
    // The engine's delivery timer already holds its serial bus while calling this service.
    // Queue courtesy events without waiting on that same bus; the delivery record is durable first.
    void flows?.emit?.({ type, id: `${type}:${String(payload.subtarefa ?? '')}:${Date.now()}`, payload }).catch(() => {})
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

/** The name a person gave an account (nickname, else the harness's own label); never the raw id. */
async function accountNameOf(harness: string, account: string): Promise<string | null> {
  const { readAccounts } = await import('../harness-accounts')
  const row = (await readAccounts()).accounts.find(a => a.id === account && a.harness === harness)
  return row ? (row.nickname?.trim() || row.label?.trim() || null) : null
}

/** PURE. A git remote as the `owner/name` gh takes; null when it is not one (a local path, another forge's odd form). */
export function repoSlug(remoteKey: string | null | undefined): string | null {
  const m = /^github\.com\/([^/]+\/[^/]+)$/.exec(remoteKey ?? '')
  return m ? m[1]! : null
}

/** The repository each directory belongs to, once per process: a card's sessions name a handful of worktrees. */
const repoOfCwd = new Map<string, string | null>()
async function slugOfCwd(cwd: string): Promise<string | null> {
  const known = repoOfCwd.get(cwd)
  if (known !== undefined) return known
  const [{ existsSync }, { dirname }, { normalizeGitRemote }, { getGitRemote }] = await Promise.all([import('node:fs'), import('node:path'), import('@agentistics/core'), import('../git')])
  // A removed worktree still names its repository through the folder that held it (`<repo>/.worktrees/<name>`); a path that no longer leads anywhere says nothing.
  let dir = cwd
  for (let up = 0; up < 6 && dir !== dirname(dir) && !existsSync(dir); up++) dir = dirname(dir)
  const slug = existsSync(dir) ? repoSlug(normalizeGitRemote((await getGitRemote(dir).catch(() => '')) ?? '')) : null
  repoOfCwd.set(cwd, slug)
  return slug
}

/**
 * Board subtasks shown In review / PR · merge / CI (the backfill adopts the ones with no delivery record). Group members excluded.
 * Each carries the facts of ITS OWN work: when it last handed back and which repositories its worker sessions ran in (H4: a card is
 * never compared with somebody else's PRs). A card with no such session has `repos: []`: nothing can be proven for it.
 */
async function boardReviewPieces(): Promise<import('./service').ReviewPiece[]> {
  const [{ loadTaskWorld }, { readRegistry }] = await Promise.all([import('../sessions/task-source'), import('../sessions/registry')])
  const { book } = await loadTaskWorld()
  const subs = boardReviewTargets(book)
  const ids = new Set(subs.map(s => s.id))
  const { hintsFromHandbacks } = await import('./batch-proof')
  const lastHandback = new Map<string, string>()
  const handbacks = new Map<string, Array<{ body: string; createdAt: string }>>()
  for (const c of book.comments) {
    const id = c.subtaskId ?? c.taskId
    if (!ids.has(id) || c.kind !== 'handback') continue
    if (c.createdAt > (lastHandback.get(id) ?? '')) lastHandback.set(id, c.createdAt)
    ;(handbacks.get(id) ?? handbacks.set(id, []).get(id)!).push(c)
  }
  const cwds = new Map<string, Set<string>>()
  const recorded = new Map<string, Set<string>>()
  for (const r of await readRegistry().catch(() => [])) {
    const sub = (r as { subtaskId?: string; taskId?: string }).subtaskId ?? (r as { taskId?: string }).taskId
    if (!sub || !ids.has(sub) || (r as { role?: string }).role === 'leader') continue
    // The repository recorded at spawn (the one moment the directory is provably there) outranks asking git now.
    if (r.repo?.repo?.includes('/')) (recorded.get(sub) ?? recorded.set(sub, new Set()).get(sub)!).add(r.repo.repo)
    else if (r.cwd) (cwds.get(sub) ?? cwds.set(sub, new Set()).get(sub)!).add(r.cwd)
  }
  const out: import('./service').ReviewPiece[] = []
  for (const s of subs) {
    const repos = new Set<string>(recorded.get(s.id) ?? [])
    for (const cwd of cwds.get(s.id) ?? []) { const slug = await slugOfCwd(cwd); if (slug) repos.add(slug) }
    const handbackAt = lastHandback.get(s.id)
    // What its delivery declared: its HANDBACKS only. Notes and every other comment are talk about the work, never a statement of what shipped (H1).
    const hints = hintsFromHandbacks((handbacks.get(s.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(c => ({ body: c.body, ...(Date.parse(c.createdAt) ? { atMs: Date.parse(c.createdAt) } : {}) })))
    out.push({ id: s.id, taskId: s.taskId, title: s.title, status: s.status, hasOpenChildren: s.hasOpenChildren, ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}), ...(s.createdAt ? { createdAt: s.createdAt } : {}), ...(handbackAt ? { handbackAt } : {}), repos: [...repos], hints })
  }
  return out
}

/** `<dataDir>/delivery-proof-cache.json`: what gh already answered, so a restart resumes the reconcile instead of starting over. A cache: never a source of truth. */
function proofCacheFile(): { load(): Promise<unknown>; save(doc: unknown): Promise<void>; stamp(): Promise<string | null> } {
  const path = async () => (await import('node:path')).join(process.env.AGENTISTICS_DIR ?? (await import('node:path')).join(process.env.HOME ?? '', '.agentistics'), 'delivery-proof-cache.json')
  return {
    async load() { return JSON.parse(await (await import('node:fs/promises')).readFile(await path(), 'utf8')) },
    async stamp() {
      const st = await (await import('node:fs/promises')).stat(await path()).catch(() => null)
      return st ? `${st.mtimeMs}:${st.size}` : null
    },
    async save(doc) {
      const fs = await import('node:fs/promises')
      const p = await path()
      const tmp = `${p}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o600 })
      await fs.rename(tmp, p)
    },
  }
}

/** Only the running server reconciles by itself: it asks for it at boot, so `agentop flow tick` (a CLI one-shot) never does (L3). */
let autoReconcileEnabled = false
export function enableAutoReconcile(): void { autoReconcileEnabled = process.env.AGENTISTICS_AUTO_RECONCILE !== '0' }

/** Whether the board would let this piece be marked done (a session is filed under it): the same rule `markTask`/`patchSubtask` apply. */
async function pieceHasSession(id: string): Promise<boolean> {
  const { loadTaskWorld } = await import('../sessions/task-source')
  const { rowsOfTask, subtaskHasSession } = await import('../sessions/task-report')
  const w = await loadTaskWorld()
  const task = w.book.tasks.find(t => t.id === id)
  if (task) return rowsOfTask(task, w.rollupRows).length > 0
  const sub = w.book.subtasks.find(s => s.id === id)
  if (!sub) return false
  if (sub.parentGroupId) return true // a group member is exempt from the gate
  return subtaskHasSession({ id: sub.taskId }, id, w.rollupRows)
}

/** `pieceHasSession` for many ids with ONE world load: the preview asked once per piece and reloaded the board every time (11 s). */
async function piecesWithSession(ids: readonly string[]): Promise<Set<string>> {
  const { loadTaskWorld } = await import('../sessions/task-source')
  const { rowsOfTask, subtaskHasSession } = await import('../sessions/task-report')
  const w = await loadTaskWorld()
  const out = new Set<string>()
  for (const id of ids) {
    const task = w.book.tasks.find(t => t.id === id)
    if (task) { if (rowsOfTask(task, w.rollupRows).length > 0) out.add(id); continue }
    const sub = w.book.subtasks.find(s => s.id === id)
    if (!sub) continue
    if (sub.parentGroupId || subtaskHasSession({ id: sub.taskId }, id, w.rollupRows)) out.add(id)
  }
  return out
}

/** `antigas`: closes a record-less old piece — done (completed without release proof) or abandoned (archived). Never deletes. */
async function closeLegacyPiece(subtaskId: string, to: 'done' | 'abandoned'): Promise<{ ok: true } | { ok: false; message: string }> {
  const m = await import('../sessions/task-web')
  if (to === 'abandoned' && !(await m.listStatuses()).some(s => s.id === 'abandoned')) {
    const made = await m.createStatus({ label: 'Abandoned', color: '#6b7280' })
    if (!made.ok) return { ok: false, message: made.message }
    if (made.status.id !== 'abandoned') return { ok: false, message: `the board has no "abandoned" status and the one just created is ${made.status.id}` }
  }
  // Re-read at the write boundary: children may have opened after the dialog was built.
  const { book } = await (await import('../sessions/task-source')).loadTaskWorld()
  const { subtaskDone } = await import('../sessions/task-model')
  const task = book.tasks.find(t => t.id === subtaskId)
  if (book.subtasks.some(s => (task ? s.taskId === task.id : s.parentGroupId === subtaskId) && !subtaskDone(s.status))) return { ok: false, message: 'this piece has open subtasks; decide them first' }
  const out = task
    ? await m.markTask(subtaskId, to, 'flow:antigas')
    : await m.patchSubtask(subtaskId, { status: to as never })
  return out.ok ? { ok: true } : { ok: false, message: out.message ?? 'board refused the change' }
}

let cached: DeliveryService | null = null
/** The process's delivery service (one store path, one set of deps). */
export function deliveryService(overrides: Partial<DeliveryDeps> = {}): DeliveryService {
  if (cached && Object.keys(overrides).length === 0) return cached
  const store = overrides.store ?? createDeliveryStore()
  const svc = createDeliveryService({
    store, facts: defaultGateFacts(), board: defaultDeliveryBoard(), notify: defaultDeliveryNotify(),
    autonomous: deliveryAutonomous, emit: emitEvent, spawn: spawnStaged, merge: mergePr, requests: readOwnerRequests, accountName: accountNameOf, now: () => Date.now(),
    reviewPieces: boardReviewPieces, closeLegacy: closeLegacyPiece, hasSession: pieceHasSession, hasSessions: piecesWithSession,
    oldPieces: async () => (await import('../sessions/task-web')).liveAntigaPieces(),
    autoReconcile: () => autoReconcileEnabled,
    proofStore: proofCacheFile(),
    log: line => console.log(line),
    ...overrides,
  })
  // Cache persistence follows the existing background cadence. A Live GET never writes
  // forecasts to the book, and persisting the anchor requires no extra per-piece probes.
  if (Object.keys(overrides).length === 0) {
    const tick = svc.tick
    svc.tick = async (...args: Parameters<typeof tick>) => {
      const result = await tick(...args)
      await (await import('../sessions/task-web')).persistLiveForecastAnchors().catch(() => {})
      return result
    }
  }
  if (Object.keys(overrides).length === 0) cached = svc
  return svc
}
