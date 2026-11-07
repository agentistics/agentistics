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

export interface StagedFact { prompt?: string; harness?: string; model?: string; effort?: string; account?: string; cwd?: string }
export interface SubtaskFact { id: string; taskId: string; title: string; status: string; groupMember: boolean; staged?: StagedFact; blockedBy: string[] }
export interface SessionFact {
  id: string; harness: string; model?: string; effort?: string; account?: string; taskId?: string; subtaskId?: string
  role?: string; label?: string; alive: boolean; cwd: string; worktree: boolean; rootPath?: string; createdAt?: string
}
export interface BudgetFact { harness: string; account: string; fiveHourPct: number; weekPct: number; stale: boolean }

export interface GateFacts {
  subtask(id: string): Promise<SubtaskFact | null>
  sessions(): Promise<SessionFact[]>
  budgets(): Promise<BudgetFact[]>
  memoryBytes(): Promise<number | null>
  /** Top-tier ceiling for a harness (autonomous mode's `topCaps`, else the shared default). */
  topCap(harness: string): Promise<number>
  git(cwd: string, args: string[]): Promise<string>
  gh(cwd: string, args: string[]): Promise<string>
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
  return !v.ok && /failed/.test(v.reason ?? '')
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
        const author = authorOf(r, await f.sessions())
        const cwd = author?.rootPath ?? author?.cwd
        if (!cwd) return no('the repository of the delivery is not known', ['repositório'])
        let pr = r.pr
        if (!pr && r.branch) pr = json<{ number?: number }>(await f.gh(cwd, ['pr', 'view', r.branch, '--json', 'number']).catch(() => '{}'), {}).number
        if (!pr) return no('no PR is known for this delivery', ['PR aberto'])
        const files = json<Array<{ filename: string; status: string }>>(await f.gh(cwd, ['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr}/files?per_page=100`]), [])
        return judgeDeletions(Array.isArray(files) ? files : [], r.allowDeletions?.paths ?? [], pr)
      }
      case 'mergeado': {
        const author = authorOf(r, await f.sessions())
        const cwd = author?.rootPath ?? author?.cwd
        if (!cwd) return no('the repository of the delivery is not known', ['repositório'])
        const ref = r.pr ? String(r.pr) : r.branch
        if (!ref) return no('no PR or branch recorded', ['PR'])
        const view = json<{ number?: number; state?: string; headRefOid?: string; mergeCommit?: { oid?: string } | null }>(await f.gh(cwd, ['pr', 'view', ref, '--json', 'number,state,headRefOid,mergeCommit']), {})
        let onMain: boolean | null = null
        const oid = view.mergeCommit?.oid
        if (view.state === 'MERGED' && oid) {
          const cmp = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/{owner}/{repo}/compare/${oid}...main`, '--jq', '{status: .status}']).catch(() => '{}'), {})
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
        const wanted = r.tag ?? (r.versionTarget && /^\d/.test(r.versionTarget) ? `v${r.versionTarget}` : null)
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
          const checked = new Map<string, boolean>()
          let pageRuns = runs
          let page = 1
          while (true) {
            const newestFirst = [...pageRuns].filter(x => x.headSha).sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))
            for (const run of newestFirst) {
              const sha = run.headSha!
              if (!checked.has(sha)) {
                if (sha === tagSha) checked.set(sha, true)
                else {
                  const cmp = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/${repoPath}/compare/${sha}...${tagSha}`, '--jq', '{status: .status}']).catch(() => '{}'), {})
                  checked.set(sha, cmp.status === 'ahead' || cmp.status === 'identical')
                }
              }
              if (checked.get(sha)) { contained = [run]; break }
            }
            if (contained || pageRuns.length < 50) break
            // gh run list has no page flag. Continue through the workflow API until the tag's run or the end,
            // rather than making a historical release permanently unreachable behind a fixed search limit.
            page += 1
            const older = json<{ workflow_runs?: Array<{ id?: number; status?: string; conclusion?: string | null; head_sha?: string; updated_at?: string }> }>(await f.gh(cwd, ['api', `repos/${repoPath}/actions/workflows/release.yml/runs?per_page=50&page=${page}`]), {})
            pageRuns = (older.workflow_runs ?? []).map(x => ({ databaseId: x.id, status: x.status, conclusion: x.conclusion ?? undefined, headSha: x.head_sha, updatedAt: x.updated_at }))
            runs.push(...pageRuns)
          }
        }
        return judgeRelease({ mergeSha: r.mergeSha, runs, ...(contained ? { contained } : {}), tag, tagSha, wanted, declared: Boolean(r.declaredRelease), pr: r.pr ?? null })
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
    subtask: async id => {
      const { loadTaskWorld } = await import('../sessions/task-source')
      const w = await loadTaskWorld()
      const s = w.book.subtasks.find(x => x.id === id)
      if (!s) return null
      const st = s.stagedSession as (StagedFact & { prompt: string }) | undefined
      return { id: s.id, taskId: s.taskId, title: s.title, status: s.status, groupMember: Boolean(s.parentGroupId), blockedBy: s.blockedBy ?? [], ...(st ? { staged: { prompt: st.prompt, harness: st.harness, model: st.model, effort: st.effort, account: st.account, cwd: st.cwd } } : {}) }
    },
    sessions: async () => {
      const [{ readRegistry }, { readRolesDoc, roleOfRow }, { AGENTISTICS_DATA_DIR }] = await Promise.all([import('../sessions/registry'), import('../sessions/session-roles'), import('../config')])
      const [registry, doc] = await Promise.all([readRegistry(), readRolesDoc(AGENTISTICS_DATA_DIR)])
      return registry.map(m => ({
        id: m.id, harness: m.harness, cwd: m.cwd, worktree: m.repo?.worktree === true,
        ...(m.repo?.rootPath ? { rootPath: m.repo.rootPath } : {}),
        ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}), ...(m.accountId ? { account: m.accountId } : {}),
        ...(m.taskId ? { taskId: m.taskId } : {}), ...(m.subtaskId ? { subtaskId: m.subtaskId } : {}),
        ...(m.label ? { label: m.label } : {}), ...(m.createdAt ? { createdAt: m.createdAt } : {}),
        role: roleOfRow(doc.roles, { id: m.id, conversationId: m.conversationId }) ?? (m.leader ? 'leader' : 'worker'),
        // The registry's own end stamp: a session killed or exited is not running (a reboot's `lost` rows keep no stamp
        // and count as running until reconciled — the conservative direction for a capacity gate).
        alive: !m.endedAt,
      }))
    },
    budgets: async () => {
      const [{ planLimitsPayload }, { readPreferences }] = await Promise.all([import('../plan-limits'), import('../preferences')])
      const rows = (await planLimitsPayload((await readPreferences()).billing, Date.now())).budgets
      return rows.map(b => ({ harness: b.harness, account: (b as { account?: string }).account ?? 'default', fiveHourPct: b.fiveHourPct, weekPct: b.weekPct, stale: b.stale }))
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
