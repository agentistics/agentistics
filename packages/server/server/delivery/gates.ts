/**
 * delivery/gates.ts — P2: the six deterministic gates. Each one reads EVIDENCE the host can check for
 * itself (the board, the session registry, plan_limits, git ls-remote, gh) and returns a verdict plus
 * the facts it established. A caller-supplied boolean is never proof — the gate asks the source.
 *
 *   predispatch  harness, model, effort, account, brief/prompt on the subtask's staged session
 *   vaga         plan_limits (5 h < 85 %, week < 95 %) + 4-worker machine ceiling + top tier per provider + ≥ 3 GB free
 *   salvo        the author's HEAD is on origin (ls-remote), the tree is clean, and EVERY check run on it concluded green
 *                (failed, still pending or absent all refuse)
 *   qa-modelo    the QA session's model ≠ the author's (from the registry, both sessions filed on THIS subtask); never Sonnet over Sonnet
 *   cabeca       the pushed branch still sits at the sha QA tested (ls-remote, read now)
 *   delecoes     the PR deletes no file outright (unless the leader allowed those paths, with a reason)
 *   mergeado     gh says the PR is MERGED, its merge commit is on origin/main and the PR head is the sha QA approved;
 *                the merge sha is read FROM THE PR, never from the caller
 *   release      the batch's version tag exists AND the release.yml run that produced it (the newest run whose commit the tag
 *                contains) = success; the declared merge sha is information, read in the repository the release recorded
 *
 * The decision functions are pure over `GateFacts`; only `defaultGateFacts` touches the machine.
 * Darwin-safe: memory is the machine's AVAILABLE memory (`/proc/meminfo` on Linux, `vm_stat` on macOS), git/gh are plain argv.
 */
import type { DeliveryCi, DeliveryRecord, GateName } from './machine'
import { reconcileSessions } from '../sessions/session-ref'
import type { BackendSession, ManagedSession } from '../sessions/types'

/** The backend, also used by the fleet, proves liveness; a lost registry row reserves no slot. */
export function runningSessionIds(registry: ManagedSession[], backend: BackendSession[]): Set<string> {
  return new Set(reconcileSessions(registry, backend)
    .filter(s => !s.managed?.endedAt && s.backend?.alive === true)
    .map(s => s.id))
}

export interface StagedFact { prompt?: string; harness?: string; model?: string; effort?: string; account?: string; cwd?: string }
export interface SubtaskFact { id: string; taskId: string; title: string; status: string; groupMember: boolean; parentGroupId?: string; staged?: StagedFact; blockedBy: string[]; /** The TASK's Agentask priority (urgent|high|medium|low) — a subtask has none of its own. */ priority?: string }
/** What the Fila tab shows beside a queued piece, read from the board in one place (same source as the card). */
export interface QueueExtras {
  taskTitle: string
  members: Array<{ id: string; title: string; status: string }>
  notes: { total: number; last: Array<{ author: string; at: string; body: string }> }
}
export interface SessionFact {
  id: string; harness: string; model?: string; effort?: string; account?: string; taskId?: string; subtaskId?: string
  role?: string; label?: string; alive: boolean; cwd: string; worktree: boolean; rootPath?: string; createdAt?: string
}
export interface BudgetFact { harness: string; account: string; fiveHourPct: number; weekPct: number; stale: boolean }

/**
 * A PIECE the board holds blocked, as the Live shows it — what the vigia needs to adopt one that has no delivery record.
 * `id` is the subtask id, a GROUP's id (a blocked member counts for its group, never as a delivery of its own), or a TASK id
 * for a task with no subtasks (the Live's task-level card). `groupMember` is true only if a host leaks a member through:
 * the vigia refuses to adopt it.
 */
export interface BlockedSubtaskFact { id: string; taskId: string; title: string; blockedBy: string[]; groupMember: boolean; since: string; reason?: string }

/** The board slice `blockedPiecesOf` reads (structural, so a test needs no book). */
export interface BlockedBook {
  tasks: ReadonlyArray<{ id: string; title: string; status: string; updatedAt: string; blockedReason?: string; blockedBy?: string[] }>
  subtasks: ReadonlyArray<{ id: string; taskId: string; title: string; status: string; updatedAt: string; isGroup?: boolean; parentGroupId?: string; blockedBy?: string[] }>
}

const CLOSED = (status: string) => status === 'done' || status === 'abandoned'

/**
 * PURE. The blocked pieces the Live shows, one per card: a blocked subtask; a GROUP whose own status is blocked or that holds a
 * blocked member (the member's block counts for the group — a member has no card and no delivery of its own); and a blocked
 * TASK that has no subtasks (its own card). Closed pieces never appear. Oldest block first.
 */
export function blockedPiecesOf(book: BlockedBook): BlockedSubtaskFact[] {
  const out = new Map<string, BlockedSubtaskFact>()
  const subtasksOf = (taskId: string) => book.subtasks.filter(s => s.taskId === taskId)
  for (const s of book.subtasks) {
    if (s.parentGroupId || s.status !== 'blocked') continue
    out.set(s.id, { id: s.id, taskId: s.taskId, title: s.title, blockedBy: s.blockedBy ?? [], groupMember: false, since: s.updatedAt })
  }
  for (const m of book.subtasks) {
    if (!m.parentGroupId || m.status !== 'blocked') continue
    const g = book.subtasks.find(x => x.id === m.parentGroupId)
    if (!g || CLOSED(g.status)) continue
    const have = out.get(g.id)
    if (have) { if (Date.parse(m.updatedAt) < Date.parse(have.since)) have.since = m.updatedAt; continue }
    out.set(g.id, { id: g.id, taskId: g.taskId, title: g.title, blockedBy: g.blockedBy ?? [], groupMember: false, since: m.updatedAt, reason: `um membro do grupo está bloqueado: ${m.title}` })
  }
  for (const t of book.tasks) {
    if (t.status !== 'blocked' || subtasksOf(t.id).some(s => !s.parentGroupId)) continue
    out.set(t.id, { id: t.id, taskId: t.id, title: t.title, blockedBy: t.blockedBy ?? [], groupMember: false, since: t.updatedAt, ...(t.blockedReason?.trim() ? { reason: t.blockedReason.trim() } : {}) })
  }
  return [...out.values()].sort((a, b) => (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0) || a.id.localeCompare(b.id))
}

export interface GateFacts {
  subtask(id: string): Promise<SubtaskFact | null>
  /** Every piece the board holds in `blocked` (see `BlockedSubtaskFact`). Optional: a host that cannot list them simply adopts none. */
  blockedSubtasks?(): Promise<BlockedSubtaskFact[]>
  /** The board status of a piece that is a subtask, a group OR a task; null = it no longer exists. Falls back to `subtask(id)`. */
  pieceStatus?(id: string): Promise<string | null>
  sessions(): Promise<SessionFact[]>
  budgets(): Promise<BudgetFact[]>
  memoryBytes(): Promise<number | null>
  /** Top-tier ceiling for a harness (autonomous mode's `topCaps`, else the shared default). */
  topCap(harness: string): Promise<number>
  git(cwd: string, args: string[]): Promise<string>
  gh(cwd: string, args: string[]): Promise<string>
  /** Board-side extras for the Fila tab (group members, the subtask's notes). Optional: absent = the tab shows none. */
  queueExtras?(subtaskId: string): Promise<QueueExtras | null>
  /** The repository checkout this process runs in, for a piece with no author session on record (`flow release`). Null = none. */
  repoCwd?(): Promise<string | null>
}

export interface GateVerdict {
  ok: boolean
  evidence?: Record<string, unknown>
  reason?: string
  missing?: string[]
  /** Facts the gate established that the record keeps (sha, sessions, models, PR, CI signal). */
  patch?: Partial<DeliveryRecord>
}

export const MACHINE_WORKER_CEILING = 4
export const MIN_FREE_BYTES = 3 * 1024 ** 3
export const FIVE_HOUR_CEILING = 85
export const WEEK_CEILING = 95

const no = (reason: string, missing: string[] = [], evidence?: Record<string, unknown>): GateVerdict => ({ ok: false, reason, missing, ...(evidence ? { evidence } : {}) })
const QA_LABEL = /(^|[^a-z])qa([^a-z]|$)/i

/** PURE: a provider's TOP model tier (the one the owner caps per provider). Unknown → not top. */
export function isTopTier(harness: string, model: string | undefined): boolean {
  const m = (model ?? '').toLowerCase()
  if (!m) return false
  if (harness === 'claude') return /opus|fable/.test(m)
  if (harness === 'gemini' || harness === 'antigravity') return /\bpro\b|-pro/.test(m)
  if (harness === 'codex' || harness === 'copilot') return /-pro\b|\bpro\b|-max\b/.test(m)
  return /opus|fable|-pro\b/.test(m)
}

/** PURE: the model family, for "never Sonnet over Sonnet". */
export function modelFamily(model: string | undefined): string {
  const m = (model ?? '').toLowerCase()
  for (const f of ['sonnet', 'opus', 'haiku', 'fable']) if (m.includes(f)) return f
  return m
}

/**
 * PURE: a session may stand for the author or the QA of THIS delivery only when the registry files it on this very
 * subtask and it is not the leader. The ids recorded on the delivery come from the host (`qaOpen`, `stageRun`, `salvo`)
 * and are re-checked against the registry here, so a recorded id that points at some other subtask's session counts for nothing.
 */
const filedHere = (r: DeliveryRecord, s: SessionFact) => s.subtaskId === r.subtaskId && s.role !== 'leader'

/** PURE: the delivery's author — the recorded one (when filed here), else the newest worker filed on the subtask that is not a QA. */
export function authorOf(r: DeliveryRecord, sessions: readonly SessionFact[]): SessionFact | null {
  if (r.authorSessionId) {
    const rec = sessions.find(s => s.id === r.authorSessionId)
    if (rec && filedHere(r, rec)) return rec
    return null
  }
  const filed = sessions.filter(s => filedHere(r, s) && !QA_LABEL.test(s.label ?? '') && s.id !== r.qaSessionId)
  return filed.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0] ?? null
}

/** PURE: the QA session — the recorded one (when filed here), else the newest session filed on the subtask whose name says QA. */
export function qaOf(r: DeliveryRecord, sessions: readonly SessionFact[]): SessionFact | null {
  if (r.qaSessionId) {
    const rec = sessions.find(s => s.id === r.qaSessionId)
    if (rec && filedHere(r, rec)) return rec
    return null
  }
  const filed = sessions.filter(s => filedHere(r, s) && QA_LABEL.test(s.label ?? ''))
  return filed.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0] ?? null
}

/** PURE. The pre-dispatch is complete: every field a session needs to start, on the subtask itself. */
export function judgePredispatch(sub: SubtaskFact | null): GateVerdict {
  if (!sub) return no('the subtask does not exist on the board', ['subtarefa'])
  if (sub.groupMember) return no('a group member never receives a session — stage it on the group', ['subtarefa (não membro de grupo)'])
  const s = sub.staged ?? {}
  const missing = (['prompt', 'harness', 'model', 'effort', 'account'] as const).filter(k => !s[k]?.trim()).map(k => (k === 'prompt' ? 'brief/prompt' : k))
  if (missing.length) return no(`pre-dispatch incomplete: ${missing.join(', ')}`, missing)
  return { ok: true, evidence: { harness: s.harness, model: s.model, effort: s.effort, account: s.account, promptChars: s.prompt!.length, subtaskId: sub.id } }
}

/** PURE. Is there room to start the staged session now? */
export function judgeVaga(sub: SubtaskFact | null, o: { sessions: readonly SessionFact[]; budgets: readonly BudgetFact[]; memoryBytes: number | null; topCap: number }): GateVerdict {
  const s = sub?.staged
  if (!s?.harness || !s.account) return no('the vaga gate reads the staged harness and account — run predispatch first', ['pré-dispatch'])
  const missing: string[] = []
  const evidence: Record<string, unknown> = { harness: s.harness, account: s.account, model: s.model }
  const row = o.budgets.find(b => !b.stale && b.harness === s.harness && b.account === s.account)
  if (!row) missing.push(`fresh plan_limits reading for ${s.harness}:${s.account}`)
  else {
    evidence.fiveHourPct = row.fiveHourPct; evidence.weekPct = row.weekPct
    if (row.fiveHourPct >= FIVE_HOUR_CEILING) missing.push(`5 h window at ${row.fiveHourPct}% (≥ ${FIVE_HOUR_CEILING}%)`)
    if (row.weekPct >= WEEK_CEILING) missing.push(`week at ${row.weekPct}% (≥ ${WEEK_CEILING}%)`)
  }
  const workers = o.sessions.filter(x => x.alive && x.role !== 'leader')
  evidence.workers = workers.length
  if (workers.length >= MACHINE_WORKER_CEILING) missing.push(`${workers.length} workers running (machine ceiling ${MACHINE_WORKER_CEILING})`)
  if (isTopTier(s.harness, s.model)) {
    const top = workers.filter(x => x.harness === s.harness && isTopTier(x.harness, x.model)).length
    evidence.topTier = { running: top, cap: o.topCap }
    if (top >= o.topCap) missing.push(`${top} ${s.harness} top-tier workers running (cap ${o.topCap})`)
  }
  evidence.memoryBytes = o.memoryBytes
  if (o.memoryBytes === null) missing.push('free memory unknown')
  else if (o.memoryBytes < MIN_FREE_BYTES) missing.push(`free memory ${(o.memoryBytes / 1024 ** 3).toFixed(1)} GB (< 3 GB)`)
  return missing.length ? no(`no slot: ${missing.join('; ')}`, missing, evidence) : { ok: true, evidence }
}

/** PURE. QA by another model, from the registry; never Sonnet over Sonnet. */
export function judgeQaModel(author: SessionFact | null, qa: SessionFact | null): GateVerdict {
  if (!author?.model) return no('the author session and its model are not known from the registry', ['autor com modelo conhecido'])
  if (!qa?.model) return no('no QA session with a known model is filed on this subtask', ['sessão de QA com modelo conhecido'])
  if (qa.id === author.id) return no('the author cannot QA its own work', ['outra sessão'])
  const evidence = { authorSessionId: author.id, authorModel: author.model, qaSessionId: qa.id, qaModel: qa.model }
  if (qa.model === author.model) return no(`QA runs the same model as the author (${qa.model})`, ['outro modelo'], evidence)
  if (modelFamily(qa.model) === 'sonnet' && modelFamily(author.model) === 'sonnet') return no('never Sonnet over Sonnet', ['outro modelo'], evidence)
  return { ok: true, evidence, patch: { authorSessionId: author.id, authorModel: author.model, qaSessionId: qa.id, qaModel: qa.model } }
}

/** PURE. A PR with a file deleted outright is refused unless the leader allowed those paths. */
export function judgeDeletions(files: ReadonlyArray<{ filename: string; status: string }>, allowed: readonly string[], pr: number): GateVerdict {
  const removed = files.filter(f => f.status === 'removed').map(f => f.filename)
  const unexpected = removed.filter(f => !allowed.includes(f))
  const evidence = { pr, files: files.length, removed, allowed }
  return unexpected.length ? no(`PR #${pr} deletes ${unexpected.length} file(s) outright: ${unexpected.slice(0, 8).join(', ')}`, unexpected.map(f => `deleção autorizada: ${f}`), evidence) : { ok: true, evidence, patch: { pr } }
}

export interface ReleaseRun { databaseId?: number; status?: string; conclusion?: string; headSha?: string; updatedAt?: string }

/**
 * PURE. The CI signal from the release run and the tag. Only both green is `ok`.
 *
 * THE TAG IS THE RELEASE'S OWN EVIDENCE. Once `v<version>` exists, the judged run is the newest `release.yml` run whose
 * commit the tag CONTAINS (`o.contained`, the first such run walking newest-first — computed by the gate): the run that
 * produced the tag. The merge sha a leader declared is information only — a big squash commit whose own run failed and
 * was fixed by a later commit (v2.201.0: db7bf2f red, 7cede91 green, tag after it) must not decide the release.
 * Before the tag exists nothing is published: `declared` pieces wait; a legacy piece (merged by the flow itself) is
 * still sent back when ITS merge commit's own run failed.
 */
export function judgeRelease(o: { mergeSha?: string; runs: ReadonlyArray<ReleaseRun>; contained?: ReadonlyArray<ReleaseRun>; tag: string | null; tagSha?: string | null; wanted?: string | null; declared?: boolean; pr: number | null }): GateVerdict {
  if (!o.mergeSha && !o.tag) return no('no merge sha recorded', ['sha do merge'])
  const mine = o.mergeSha ? o.runs.filter(r => r.headSha === o.mergeSha) : []
  const mineGreen = mine.some(r => r.status === 'completed' && r.conclusion === 'success')
  if (!o.tag) {
    const ci: DeliveryCi = { mergedMain: true, releaseGreen: mineGreen, tagPublished: false, tag: null, pr: o.pr }
    const evidence = { mergeSha: o.mergeSha, runs: mine.map(r => ({ id: r.databaseId, status: r.status, conclusion: r.conclusion })), tag: null }
    const failed = mine.find(r => r.status === 'completed' && r.conclusion !== 'success')
    if (!o.declared && !mineGreen) {
      return { ...no(failed && mine.every(r => r.status === 'completed') ? `release.yml failed for ${o.mergeSha!.slice(0, 9)} (${failed.conclusion})` : `release.yml has not finished green for ${o.mergeSha!.slice(0, 9)}`, ['release.yml verde'], evidence), patch: { ci } }
    }
    // A declared piece never reads a failed run of some other commit as final: it waits for the tag.
    return { ...no(`the release tag${o.wanted ? ` ${o.wanted}` : ''} does not exist yet`, ['tag publicada'], evidence), patch: { ci } }
  }
  const decisive = [...(o.contained ?? [])].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))[0]
  const green = decisive && decisive.status === 'completed' && decisive.conclusion === 'success'
  const ci: DeliveryCi = { mergedMain: true, releaseGreen: !!green, tagPublished: true, tag: o.tag, pr: o.pr }
  const evidence = { mergeSha: o.mergeSha, tag: o.tag, tagSha: o.tagSha, runs: decisive ? [{ id: decisive.databaseId, head: decisive.headSha?.slice(0, 9), status: decisive.status, conclusion: decisive.conclusion }] : [] }
  if (!decisive) return { ...no(`no release.yml run found for ${o.tag} (${(o.tagSha ?? '?').slice(0, 9)})`, ['release.yml verde'], evidence), patch: { ci } }
  if (!green) {
    const final = decisive.status === 'completed'
    return { ...no(final ? `release.yml failed for ${o.tag} (${decisive.conclusion}, run ${decisive.databaseId ?? '?'})` : `release.yml has not finished green for ${o.tag}`, ['release.yml verde'], evidence), patch: { ci } }
  }
  // The release's own publish time: when the green run completed (the run creates the tag). Absent when gh did not say.
  const publishedAt = decisive.updatedAt && Number.isFinite(Date.parse(decisive.updatedAt)) ? new Date(decisive.updatedAt).toISOString() : undefined
  return { ok: true, evidence: { ...evidence, ...(publishedAt ? { publishedAt } : {}) }, patch: { ci, tag: o.tag, ...(publishedAt ? { publishedAt } : {}) } }
}

/** PURE: was the release FAILURE final (so the flow goes back to the leader), or is it still running? */
export function releaseFailed(v: GateVerdict): boolean {
  return !v.ok && /failed/.test(v.reason ?? '') && !releaseUnknown(v)
}

/** PURE. The release gate could not ANSWER (gh unreachable, a search paused half way): that is "don't know", never "failed" and never "not yet". */
export function releaseUnknown(v: GateVerdict): boolean {
  return !v.ok && /could not be read|search paused/.test(v.reason ?? '')
}

/** PURE. Judge the salvo check runs: every one concluded green (success/skipped/neutral). Failed, pending and absent all refuse. */
export function judgeChecks(runs: ReadonlyArray<{ name?: string; status?: string; conclusion?: string | null }>, head: string): GateVerdict | null {
  if (!runs.length) return no(`no check run exists yet on ${head.slice(0, 9)} — CI has not started; wait for it`, ['checagens verdes'], { head })
  const failed = runs.filter(c => c.conclusion && !['success', 'skipped', 'neutral'].includes(c.conclusion))
  if (failed.length) return no(`check runs failed on ${head.slice(0, 9)}: ${failed.map(c => c.name).join(', ')}`, ['checagens verdes'], { head })
  const pending = runs.filter(c => !c.conclusion)
  if (pending.length) return no(`check runs still pending on ${head.slice(0, 9)}: ${pending.map(c => c.name).join(', ')}`, ['checagens concluídas'], { head })
  return null
}

/** PURE. The PR as gh states it: MERGED, with a merge commit, from the head QA approved. */
export function judgeMerged(o: { view: { number?: number; state?: string; headRefOid?: string; mergeCommit?: { oid?: string } | null }; qaSha?: string; onMain: boolean | null }): GateVerdict {
  const v = o.view
  if (v.state !== 'MERGED') return no(`PR #${v.number ?? '?'} is ${v.state ?? 'unknown'}, not merged`, ['PR mergeado'], { pr: v.number, state: v.state })
  const oid = v.mergeCommit?.oid
  if (!oid) return no(`PR #${v.number} is merged but gh reports no merge commit`, ['sha do merge'], { pr: v.number })
  if (o.qaSha && v.headRefOid && v.headRefOid !== o.qaSha) return no(`PR #${v.number} merged head ${v.headRefOid.slice(0, 9)}, not the sha QA approved (${o.qaSha.slice(0, 9)})`, ['mesmo sha do QA'], { pr: v.number, head: v.headRefOid, qaSha: o.qaSha })
  if (o.onMain !== true) return no(`merge commit ${oid.slice(0, 9)} is not on origin/main${o.onMain === null ? ' (could not be verified)' : ''}`, ['merge em origin/main'], { pr: v.number, mergeSha: oid })
  return { ok: true, evidence: { pr: v.number, mergeSha: oid, head: v.headRefOid, onMain: true }, patch: { pr: v.number, mergeSha: oid } }
}

/**
 * PURE. The tag of THIS batch among the repository's tags (newest first). With a wanted tag it must be that one and
 * contain the merge. Without one, it is the OLDEST tag that contains the merge (the first release that shipped it):
 * walking newest to oldest, the run of tags that are `ahead` of / `identical` to the merge sha ends at the first tag that is not.
 */
export function pickReleaseTag(tags: ReadonlyArray<{ name: string; sha: string }>, wanted: string | null, mergeSha: string, relation: (sha: string) => string | undefined): string | null {
  let found: string | null = null
  for (const t of tags) {
    if (wanted && t.name !== wanted) continue
    const rel = t.sha === mergeSha ? 'identical' : relation(t.sha)
    if (rel === 'ahead' || rel === 'identical') { found = t.name; if (wanted) return found; continue }
    if (!wanted) break
  }
  return found
}

const json = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T } catch { return fallback } }

/** The repository a release belongs to when nothing on the piece names one. */
export const DEFAULT_RELEASE_REPO = 'agentistics/agentistics'

/** One PR as gh describes it (`pr view|list --json …` or the REST `commits/<sha>/pulls` row, normalised). */
export interface PrCandidate { number: number; state: string; headRefOid?: string; headRefName?: string; mergeSha?: string; mergedAt?: string; baseRefName?: string }

/**
 * PURE. FLUXO.CICLO-COMPLETO — which merged PR is THIS piece's. Only MERGED PRs with a merge commit count. When the piece
 * knows the sha QA approved (or the pushed head), a PR from that head wins; otherwise exactly ONE merged PR must remain —
 * two different candidates are ambiguous and prove nothing (a wrong PR would publish a piece that never shipped).
 */
export function pickMergedPr(cands: readonly PrCandidate[], shas: readonly string[]): { ok: true; pr: PrCandidate } | { ok: false; reason: string } {
  // A PR into `dev` is not a delivery: its merge commit never reaches a tag (M3).
  const merged = [...new Map(cands.filter(c => c.state === 'MERGED' && c.mergeSha && c.baseRefName !== 'dev').map(c => [c.number, c] as const)).values()]
  if (merged.length === 0) return { ok: false, reason: cands.length ? `no MERGED PR among ${cands.map(c => `#${c.number} (${c.state})`).join(', ')}` : 'no PR found for this piece' }
  const wanted = shas.filter(Boolean)
  const byHead = wanted.length ? merged.filter(c => c.headRefOid && wanted.includes(c.headRefOid)) : []
  if (byHead.length === 1) return { ok: true, pr: byHead[0]! }
  if (merged.length === 1) return { ok: true, pr: merged[0]! }
  return { ok: false, reason: `ambiguous: ${merged.length} merged PRs match (${merged.map(c => `#${c.number}`).join(', ')}) and none is from the approved sha` }
}

/** Where gh is asked about a piece: the author's checkout, else the repository the piece (or the default) names. */
async function repoOf(r: DeliveryRecord, f: GateFacts, author: SessionFact | null): Promise<{ cwd: string; slug: string | null } | null> {
  if (r.releaseRepo) return { cwd: (await f.repoCwd?.().catch(() => null)) ?? author?.rootPath ?? author?.cwd ?? '.', slug: r.releaseRepo }
  const cwd = author?.rootPath ?? author?.cwd
  if (cwd) return { cwd, slug: null }
  const fallback = await f.repoCwd?.().catch(() => null)
  return fallback ? { cwd: fallback, slug: DEFAULT_RELEASE_REPO } : null
}
const repoArgs = (slug: string | null) => (slug ? ['-R', slug] : [])
const repoPath = (slug: string | null) => slug ?? '{owner}/{repo}'
const PR_FIELDS = 'number,state,headRefOid,headRefName,baseRefName,mergeCommit,mergedAt'
type PrJson = { number?: number; state?: string; headRefOid?: string; headRefName?: string; baseRefName?: string; mergeCommit?: { oid?: string } | null; mergedAt?: string }
const fromPrJson = (p: PrJson): PrCandidate | null => (typeof p.number === 'number' ? { number: p.number, state: p.state ?? '', ...(p.baseRefName ? { baseRefName: p.baseRefName } : {}), ...(p.headRefOid ? { headRefOid: p.headRefOid } : {}), ...(p.headRefName ? { headRefName: p.headRefName } : {}), ...(p.mergeCommit?.oid ? { mergeSha: p.mergeCommit.oid } : {}), ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}) } : null)

export type MergedPrFinding = { ok: true; pr: number; mergeSha: string; headSha?: string; branch?: string; via: string } | { ok: false; reason: string }

/**
 * FLUXO.CICLO-COMPLETO — find the merged PR of a piece, from what the piece itself records: its PR number, its branch, the
 * PR that contains the sha QA approved (or the pushed head), the branch its author's worktree still sits on, and — only for
 * the one-shot backfill (`search`) — a merged PR whose title/body names the subtask id. Each route is a FACT gh states; a
 * piece with none of them is "not provable", said in a sentence, never guessed. Never throws.
 */
export async function findMergedPr(r: DeliveryRecord, f: GateFacts, opts: { search?: boolean } = {}): Promise<MergedPrFinding> {
  try {
    const sessions = await f.sessions().catch(() => [] as SessionFact[])
    const author = authorOf(r, sessions)
    const repo = await repoOf(r, f, author)
    if (!repo) return { ok: false, reason: 'the repository of the piece is not known (no author checkout, no repository recorded)' }
    const shas = [r.qaSha, r.headSha].filter((s): s is string => !!s)
    const tried: string[] = []
    const settle = (cands: PrCandidate[], via: string): MergedPrFinding | null => {
      const pick = pickMergedPr(cands, shas)
      if (!pick.ok) { tried.push(`${via}: ${pick.reason}`); return null }
      return { ok: true, pr: pick.pr.number, mergeSha: pick.pr.mergeSha!, ...(pick.pr.headRefOid ? { headSha: pick.pr.headRefOid } : {}), ...(pick.pr.headRefName ? { branch: pick.pr.headRefName } : {}), via }
    }
    const list = async (args: string[]) => {
      const raw = json<PrJson[]>(await f.gh(repo.cwd, ['pr', 'list', ...repoArgs(repo.slug), '--state', 'merged', ...args, '--json', PR_FIELDS, '--limit', '10']).catch(() => '[]'), [])
      return (Array.isArray(raw) ? raw : []).map(fromPrJson).filter((c): c is PrCandidate => !!c)
    }
    if (r.pr) {
      const one = fromPrJson(json<PrJson>(await f.gh(repo.cwd, ['pr', 'view', String(r.pr), ...repoArgs(repo.slug), '--json', PR_FIELDS]).catch(() => '{}'), {}))
      const got = one ? settle([one], `PR #${r.pr}`) : (tried.push(`PR #${r.pr}: gh did not describe it`), null)
      if (got) return got
    }
    if (r.branch) { const got = settle(await list(['--head', r.branch]), `branch ${r.branch}`); if (got) return got }
    for (const sha of shas) {
      const rows = json<Array<{ number?: number; state?: string; merged_at?: string | null; merge_commit_sha?: string | null; head?: { sha?: string; ref?: string } }>>(await f.gh(repo.cwd, ['api', `repos/${repoPath(repo.slug)}/commits/${sha}/pulls`]).catch(() => '[]'), [])
      const cands = (Array.isArray(rows) ? rows : []).flatMap(p => (typeof p.number === 'number' ? [{ number: p.number, state: p.merged_at ? 'MERGED' : (p.state ?? '').toUpperCase(), ...(p.head?.sha ? { headRefOid: p.head.sha } : {}), ...(p.head?.ref ? { headRefName: p.head.ref } : {}), ...(p.merged_at && p.merge_commit_sha ? { mergeSha: p.merge_commit_sha } : {}), ...(p.merged_at ? { mergedAt: p.merged_at } : {}) }] : []))
      const got = settle(cands, `sha ${sha.slice(0, 9)}`)
      if (got) return got
    }
    // The branch each author worktree filed on this piece still sits on (a legacy piece never recorded its branch).
    const branches = new Set<string>()
    for (const s of sessions) {
      if (s.subtaskId !== r.subtaskId || s.role === 'leader' || !s.worktree) continue
      const b = (await f.git(s.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
      if (b && b !== 'main' && b !== 'dev' && b !== r.branch) branches.add(b)
    }
    for (const b of branches) { const got = settle(await list(['--head', b]), `worktree branch ${b}`); if (got) return got }
    if (opts.search) { const got = settle(await list(['--search', `${r.subtaskId} in:title,body`]), `search ${r.subtaskId}`); if (got) return got }
    return { ok: false, reason: tried.length ? `no merged PR proven — ${tried.join('; ')}` : 'no merged PR proven: the piece records no PR, branch or sha and no author worktree names one' }
  } catch (e) {
    return { ok: false, reason: `the merged PR could not be looked up (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` }
  }
}

// Only negative ancestry facts survive polls: commits and a resolved tag SHA are immutable. A new
// first page restarts pagination (offsets may have shifted). Never cache a run's mutable verdict.
interface ReleaseSearch { page: number; firstPage: string; checked: Map<string, boolean> }
const releaseSearches = new WeakMap<GateFacts, Map<string, ReleaseSearch>>()
const RELEASE_SEARCH_PAGES = 10
const RELEASE_SEARCH_COMPARES = 150

/** Run ONE gate against the record. Never throws: an unreachable source is a refusal naming it. */
export async function runGate(name: GateName, r: DeliveryRecord, f: GateFacts): Promise<GateVerdict> {
  try {
    switch (name) {
      case 'predispatch': return judgePredispatch(await f.subtask(r.subtaskId))
      case 'vaga': {
        const sub = await f.subtask(r.subtaskId)
        const [sessions, budgets, memoryBytes, topCap] = await Promise.all([f.sessions(), f.budgets().catch(() => []), f.memoryBytes().catch(() => null), f.topCap(sub?.staged?.harness ?? '')])
        return judgeVaga(sub, { sessions, budgets, memoryBytes, topCap })
      }
      case 'qa-modelo': {
        const sessions = await f.sessions()
        return judgeQaModel(authorOf(r, sessions), qaOf(r, sessions))
      }
      case 'salvo': {
        const author = authorOf(r, await f.sessions())
        if (!author) return no('no author session is filed on this subtask', ['sessão autora'])
        if (!author.worktree) return no('the author does not work in its own recorded worktree', ['worktree própria'])
        const text = async (args: string[]) => (await f.git(author.cwd, args)).trim()
        const head = await text(['rev-parse', 'HEAD'])
        if ((await f.git(author.cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) return no('the working tree is dirty', ['árvore limpa'], { head })
        const branch = await text(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
        if (!branch || branch === 'main' || branch === 'dev') return no('a feature branch is required', ['branch de feature'], { head })
        const remote = (await text(['ls-remote', 'origin', `refs/heads/${branch}`])).split(/\s/)[0]
        if (remote !== head) return no(`HEAD ${head.slice(0, 9)} is not on origin/${branch}`, ['push do HEAD'], { head, branch, remote: remote || null })
        let runs: { check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }> }
        try { runs = JSON.parse(await f.gh(author.rootPath ?? author.cwd, ['api', `repos/{owner}/{repo}/commits/${head}/check-runs`])) } catch (e) { return no(`the check runs of ${head.slice(0, 9)} could not be read (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`, ['fonte de evidência acessível'], { head, branch }) }
        const checkRuns = runs.check_runs ?? []
        const bad = judgeChecks(checkRuns, head)
        if (bad) return { ...bad, evidence: { ...bad.evidence, branch } }
        return { ok: true, evidence: { head, branch, pushed: 'ls-remote', checks: 'passed', checkRuns: checkRuns.map(c => `${c.name}:${c.conclusion}`) }, patch: { headSha: head, branch, authorSessionId: author.id, ...(author.model ? { authorModel: author.model } : {}) } }
      }
      case 'cabeca': {
        const author = authorOf(r, await f.sessions())
        if (!author) return no('no author session is filed on this subtask', ['sessão autora'])
        if (!r.branch || !r.qaSha) return no('no branch / QA sha recorded for this delivery', ['branch e sha do QA'])
        const remote = (await f.git(author.cwd, ['ls-remote', 'origin', `refs/heads/${r.branch}`])).trim().split(/\s/)[0]
        if (remote !== r.qaSha) return no(`origin/${r.branch} is at ${remote ? remote.slice(0, 9) : '(missing)'}, not the sha QA tested (${r.qaSha.slice(0, 9)}) — go back through ajuste → qa`, ['HEAD igual ao do QA'], { branch: r.branch, remote: remote || null, qaSha: r.qaSha })
        return { ok: true, evidence: { branch: r.branch, head: remote, qaSha: r.qaSha } }
      }
      case 'delecoes': {
        const repo = await repoOf(r, f, authorOf(r, await f.sessions()))
        if (!repo) return no('the repository of the delivery is not known', ['repositório'])
        const cwd = repo.cwd
        let pr = r.pr
        if (!pr && r.branch) pr = json<{ number?: number }>(await f.gh(cwd, ['pr', 'view', r.branch, ...repoArgs(repo.slug), '--json', 'number']).catch(() => '{}'), {}).number
        if (!pr) return no('no PR is known for this delivery', ['PR aberto'])
        const files = json<Array<{ filename: string; status: string }>>(await f.gh(cwd, ['api', '--paginate', `repos/${repoPath(repo.slug)}/pulls/${pr}/files?per_page=100`]), [])
        return judgeDeletions(Array.isArray(files) ? files : [], r.allowDeletions?.paths ?? [], pr)
      }
      case 'mergeado': {
        const repo = await repoOf(r, f, authorOf(r, await f.sessions()))
        if (!repo) return no('the repository of the delivery is not known', ['repositório'])
        const cwd = repo.cwd
        const ref = r.pr ? String(r.pr) : r.branch
        if (!ref) return no('no PR or branch recorded', ['PR'])
        const view = json<{ number?: number; state?: string; headRefOid?: string; mergeCommit?: { oid?: string } | null }>(await f.gh(cwd, ['pr', 'view', ref, ...repoArgs(repo.slug), '--json', 'number,state,headRefOid,mergeCommit']), {})
        let onMain: boolean | null = null
        const oid = view.mergeCommit?.oid
        if (view.state === 'MERGED' && oid) {
          const cmp = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${repoPath(repo.slug)}/compare/${oid}...main`, '--jq', '{status: .status}']).catch(() => '{}'), {})
          onMain = cmp.status === 'ahead' || cmp.status === 'identical' ? true : cmp.status ? false : null
        }
        return judgeMerged({ view, ...(r.qaSha ? { qaSha: r.qaSha } : {}), onMain })
      }
      case 'release': {
        const author = authorOf(r, await f.sessions())
        // ONE REPOSITORY PER RELEASE. A piece declared by `agentop flow release` records the `owner/name` it was declared in
        // (`releaseRepo`), and the gate asks gh THERE with explicit paths: the author session's checkout is irrelevant (a
        // piece worked in the engine repo or the workspace must not ask the wrong repository and wait in `ci` forever), and
        // so is the server's own cwd. A record with no `releaseRepo` (merged by the flow) keeps the author's checkout.
        const slug = r.releaseRepo
        const cwd = slug
          ? (await f.repoCwd?.().catch(() => null)) ?? '.'
          : author?.rootPath ?? author?.cwd ?? (await f.repoCwd?.().catch(() => null)) ?? undefined
        if (!cwd) return no('the repository of the delivery is not known', ['repositório'])
        const repoPath = slug ?? '{owner}/{repo}'
        // A DECLARED release names its tag. A piece the flow saw MERGED (no declaration) is published by the first tag that
        // CONTAINS its merge commit — a planned `versionTarget` is a plan, not proof that the tag carries the merge.
        const wanted = r.tag ?? (r.versionTarget && /^\d/.test(r.versionTarget) && (r.declaredRelease || !r.mergeSha) ? `v${r.versionTarget}` : null)
        if (!r.mergeSha && !wanted) return no('no merge sha recorded', ['sha do merge'])
        const runList = ['run', 'list', ...(slug ? ['-R', slug] : []), '--workflow', 'release.yml', '--json', 'databaseId,status,conclusion,headSha,updatedAt', '--limit', '50']
        const runsRaw = json<ReleaseRun[]>(await f.gh(cwd, runList), [])
        const runs = Array.isArray(runsRaw) ? runsRaw : []
        // The tag by its EXACT name (never a page of the newest tags: a `vscode-v*` flood would push it off the page).
        let tag: string | null = null
        let tagSha: string | null = null
        if (wanted) {
          const ref = json<{ object?: { sha?: string; type?: string } }>(await f.gh(cwd, ['api', `repos/${repoPath}/git/ref/tags/${wanted}`]).catch(() => '{}'), {})
          tagSha = ref.object?.sha ?? null
          if (tagSha && ref.object?.type === 'tag') {
            // An annotated tag points at a tag object: the commit is one hop further.
            const obj = json<{ object?: { sha?: string } }>(await f.gh(cwd, ['api', `repos/${repoPath}/git/tags/${tagSha}`]).catch(() => '{}'), {})
            tagSha = obj.object?.sha ?? null
          }
          if (tagSha) tag = wanted
        } else if (r.mergeSha) {
          const tags = json<Array<{ name?: string; commit?: { sha?: string } }>>(await f.gh(cwd, ['api', `repos/${repoPath}/tags?per_page=30`]).catch(() => '[]'), [])
          const list = (Array.isArray(tags) ? tags : []).flatMap(t => (t.name && t.commit?.sha ? [{ name: t.name, sha: t.commit.sha }] : []))
          const relations = new Map<string, string | undefined>()
          for (const t of list) {
            if (t.sha === r.mergeSha) { relations.set(t.sha, 'identical'); continue }
            const cmp = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${repoPath}/compare/${r.mergeSha}...${t.sha}`, '--jq', '{status: .status}']).catch(() => '{}'), {})
            relations.set(t.sha, cmp.status)
            if (cmp.status !== 'ahead' && cmp.status !== 'identical') break
          }
          tag = pickReleaseTag(list, null, r.mergeSha, sha => relations.get(sha))
          tagSha = list.find(t => t.name === tag)?.sha ?? null
        }
        // The run that produced the tag: walking the runs newest-first, the first whose commit the tag contains.
        let contained: ReleaseRun[] | undefined
        if (tag && tagSha) {
          let searches = releaseSearches.get(f)
          if (!searches) { searches = new Map(); releaseSearches.set(f, searches) }
          const key = `${cwd}:${repoPath}:${tag}:${tagSha}`
          const firstPage = JSON.stringify(runs)
          let search = searches.get(key)
          if (!search || search.firstPage !== firstPage) {
            search = { page: 1, firstPage, checked: new Map() }
            searches.set(key, search)
            if (searches.size > 100) searches.delete(searches.keys().next().value!)
          }
          const checked = search.checked
          let pageRuns = runs
          let page = 1
          let pages = 1
          let compares = 0
          let searched = 0
          while (true) {
            const newestFirst = [...pageRuns].filter(x => x.headSha).sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))
            for (const run of newestFirst) {
              const sha = run.headSha!
              searched += 1
              if (!checked.has(sha)) {
                if (sha === tagSha) checked.set(sha, true)
                else {
                  if (compares >= RELEASE_SEARCH_COMPARES) {
                    search.page = page
                    return no(`release run search paused after ${searched - 1} runs (${compares} comparisons); resumes at page ${page} next poll`, ['release.yml verde'], { searched: searched - 1, nextPage: page })
                  }
                  // A checkout that holds both commits answers for free (this walk was 2.533 of the reconcile's 3.275 calls, CICLO.RECONCILE-2 H5).
                  const local = (await f.git(cwd, ['rev-list', '--count', `${tagSha}..${sha}`]).catch(() => '')).trim()
                  if (/^\d+$/.test(local)) { checked.set(sha, local === '0'); if (checked.get(sha)) { contained = [run]; break }; continue }
                  compares += 1
                  const cmp = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${repoPath}/compare/${sha}...${tagSha}`, '--jq', '{status: .status}']).catch(() => '{}'), {})
                  if (!cmp.status) {
                    search.page = page
                    return no(`release run ancestry could not be read after ${searched} runs; retry page ${page}`, ['fonte de evidência acessível'], { searched, nextPage: page })
                  }
                  checked.set(sha, cmp.status === 'ahead' || cmp.status === 'identical')
                  if (checked.size > 5000) checked.delete(checked.keys().next().value!)
                }
              }
              if (checked.get(sha)) { contained = [run]; break }
            }
            if (contained || pageRuns.length < 50) { searches.delete(key); break }
            // Recheck page one on every poll, then resume the immutable non-containing prefix already searched.
            page = page === 1 && search.page > 1 ? search.page : page + 1
            search.page = page
            if (pages >= RELEASE_SEARCH_PAGES) return no(`release run search paused after ${searched} runs (${pages} pages); resumes at page ${page} next poll`, ['release.yml verde'], { searched, nextPage: page })
            pages += 1
            const older = json<{ workflow_runs?: Array<{ id?: number; status?: string; conclusion?: string | null; head_sha?: string; updated_at?: string }> }>(await f.gh(cwd, ['api', `repos/${repoPath}/actions/workflows/release.yml/runs?per_page=50&page=${page}`]), {})
            pageRuns = (older.workflow_runs ?? []).map(x => ({ databaseId: x.id, status: x.status, conclusion: x.conclusion ?? undefined, headSha: x.head_sha, updatedAt: x.updated_at }))
            runs.push(...pageRuns)
          }
        }
        return judgeRelease({ mergeSha: r.mergeSha, runs, ...(contained ? { contained } : {}), tag, tagSha, wanted, declared: Boolean(r.declaredRelease || r.mergeDetected), pr: r.pr ?? null })
      }
    }
  } catch (error) {
    return no(`${name}: evidence could not be read (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`, ['fonte de evidência acessível'])
  }
}

/** The machine's facts. Imports are lazy: the CLI must not load the server to run one gate. */
export function defaultGateFacts(): GateFacts {
  const run = async (cmd: string, cwd: string, args: string[]) => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { gitEnv } = await import('../backup/repo-probe')
    return (await promisify(execFile)(cmd, cmd === 'git' ? ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args] : args, { cwd, timeout: 20_000, env: gitEnv(), maxBuffer: 8 * 1024 * 1024 })).stdout
  }
  return {
    blockedSubtasks: async () => {
      const { loadTaskWorld } = await import('../sessions/task-source')
      return blockedPiecesOf((await loadTaskWorld()).book)
    },
    pieceStatus: async id => {
      const { loadTaskWorld } = await import('../sessions/task-source')
      const { book } = await loadTaskWorld()
      return book.subtasks.find(s => s.id === id)?.status ?? book.tasks.find(t => t.id === id)?.status ?? null
    },
    subtask: async id => {
      const { loadTaskWorld } = await import('../sessions/task-source')
      const w = await loadTaskWorld()
      const s = w.book.subtasks.find(x => x.id === id)
      if (!s) return null
      const st = s.stagedSession as (StagedFact & { prompt: string }) | undefined
      const taskRow = w.book.tasks.find(t => t.id === s.taskId)
      return { id: s.id, taskId: s.taskId, title: s.title, status: s.status, groupMember: Boolean(s.parentGroupId), ...(s.parentGroupId ? { parentGroupId: s.parentGroupId } : {}), blockedBy: s.blockedBy ?? [], priority: (await import('../sessions/task-model')).migratePriority(taskRow?.priority), ...(st ? { staged: { prompt: st.prompt, harness: st.harness, model: st.model, effort: st.effort, account: st.account, cwd: st.cwd } } : {}) }
    },
    sessions: async () => {
      const [{ readRegistry }, { readRolesDoc, roleOfRow }, { AGENTISTICS_DATA_DIR }] = await Promise.all([import('../sessions/registry'), import('../sessions/session-roles'), import('../config')])
      const { resolveBackend } = await import('../sessions/index')
      const [registry, doc, backend] = await Promise.all([readRegistry(), readRolesDoc(AGENTISTICS_DATA_DIR), (await resolveBackend()).list()])
      const running = runningSessionIds(registry, backend)
      return registry.map(m => ({
        id: m.id, harness: m.harness, cwd: m.cwd, worktree: m.repo?.worktree === true,
        ...(m.repo?.rootPath ? { rootPath: m.repo.rootPath } : {}),
        ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}), ...(m.accountId ? { account: m.accountId } : {}),
        ...(m.taskId ? { taskId: m.taskId } : {}), ...(m.subtaskId ? { subtaskId: m.subtaskId } : {}),
        ...(m.label ? { label: m.label } : {}), ...(m.createdAt ? { createdAt: m.createdAt } : {}),
        role: roleOfRow(doc.roles, { id: m.id, conversationId: m.conversationId }) ?? (m.leader ? 'leader' : 'worker'),
        alive: running.has(m.id),
      }))
    },
    budgets: async () => {
      const [{ planLimitsPayload }, { readPreferences }] = await Promise.all([import('../plan-limits'), import('../preferences')])
      const rows = (await planLimitsPayload((await readPreferences()).billing, Date.now())).budgets
      return rows.map(b => ({ harness: b.harness, account: (b as { account?: string }).account ?? 'default', fiveHourPct: b.fiveHourPct, weekPct: b.weekPct, stale: b.stale }))
    },
    queueExtras: async id => {
      const { loadTaskWorld } = await import('../sessions/task-source')
      const { book } = await loadTaskWorld()
      const s = book.subtasks.find(x => x.id === id)
      if (!s) return null
      const notes = book.comments.filter(c => c.subtaskId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return {
        taskTitle: book.tasks.find(t => t.id === s.taskId)?.title ?? s.taskId,
        members: book.subtasks.filter(m => m.parentGroupId === id).map(m => ({ id: m.id, title: m.title, status: m.status })),
        notes: { total: notes.length, last: notes.slice(-3).reverse().map(c => ({ author: c.author, at: c.createdAt, body: c.body })) },
      }
    },
    memoryBytes: async () => (await import('../cli-run')).memAvailableAnyBytes(),
    topCap: async harness => {
      const [{ readPreferences }, core] = await Promise.all([import('../preferences'), import('@agentistics/core')])
      const state = core.parseAwayState((await readPreferences() as { away?: unknown }).away)
      return core.HARNESS_ORDER.includes(harness as never) ? core.awayTopCap(state, harness as never) : core.AWAY_DEFAULT_TOP_CAP
    },
    git: (cwd, args) => run('git', cwd, args),
    gh: (cwd, args) => run('gh', cwd, args),
    repoCwd: async () => (await run('git', process.cwd(), ['rev-parse', '--show-toplevel'])).trim() || null,
  }
}
