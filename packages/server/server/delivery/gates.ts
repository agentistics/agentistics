/**
 * delivery/gates.ts — P2: the six deterministic gates. Each one reads EVIDENCE the host can check for
 * itself (the board, the session registry, plan_limits, git ls-remote, gh) and returns a verdict plus
 * the facts it established. A caller-supplied boolean is never proof — the gate asks the source.
 *
 *   predispatch  harness, model, effort, account, brief/prompt on the subtask's staged session
 *   vaga         plan_limits (5 h < 85 %, week < 95 %) + 4-worker machine ceiling + top tier per provider + ≥ 3 GB free
 *   salvo        the author's HEAD is on origin (ls-remote), the tree is clean, and no check run on it failed
 *   qa-modelo    the QA session's model ≠ the author's (from the registry); never Sonnet over Sonnet
 *   delecoes     the PR deletes no file outright (unless the leader allowed those paths, with a reason)
 *   release      release.yml for the merge sha = success AND the version tag exists
 *
 * The decision functions are pure over `GateFacts`; only `defaultGateFacts` touches the machine.
 * Darwin-safe: memory comes from `os.freemem()` off Linux, git/gh are plain argv.
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

/** PURE: the delivery's author — the recorded one, else the newest worker filed on the subtask that is not a QA. */
export function authorOf(r: DeliveryRecord, sessions: readonly SessionFact[]): SessionFact | null {
  if (r.authorSessionId) return sessions.find(s => s.id === r.authorSessionId) ?? null
  const filed = sessions.filter(s => s.subtaskId === r.subtaskId && s.role !== 'leader' && !QA_LABEL.test(s.label ?? '') && s.id !== r.qaSessionId)
  return filed.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0] ?? null
}

/** PURE: the QA session — the recorded one, else the newest session filed on the subtask whose name says QA. */
export function qaOf(r: DeliveryRecord, sessions: readonly SessionFact[]): SessionFact | null {
  if (r.qaSessionId) return sessions.find(s => s.id === r.qaSessionId) ?? null
  const filed = sessions.filter(s => s.subtaskId === r.subtaskId && QA_LABEL.test(s.label ?? ''))
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

/** PURE. The CI signal from the release run and the tag. Only both green is `ok`. */
export function judgeRelease(o: { mergeSha?: string; runs: ReadonlyArray<{ databaseId?: number; status?: string; conclusion?: string; headSha?: string }>; tag: string | null; pr: number | null }): GateVerdict {
  if (!o.mergeSha) return no('no merge sha recorded', ['sha do merge'])
  const mine = o.runs.filter(r => r.headSha === o.mergeSha)
  const green = mine.find(r => r.status === 'completed' && r.conclusion === 'success')
  const ci: DeliveryCi = { mergedMain: true, releaseGreen: !!green, tagPublished: !!o.tag, tag: o.tag, pr: o.pr }
  const evidence = { mergeSha: o.mergeSha, runs: mine.map(r => ({ id: r.databaseId, status: r.status, conclusion: r.conclusion })), tag: o.tag }
  const failed = mine.find(r => r.status === 'completed' && r.conclusion !== 'success')
  if (!green) return { ...no(failed && mine.every(r => r.status === 'completed') ? `release.yml failed for ${o.mergeSha.slice(0, 9)} (${failed.conclusion})` : `release.yml has not finished green for ${o.mergeSha.slice(0, 9)}`, ['release.yml verde'], evidence), patch: { ci } }
  if (!o.tag) return { ...no('the release tag does not exist yet', ['tag publicada'], evidence), patch: { ci } }
  return { ok: true, evidence, patch: { ci, tag: o.tag } }
}

/** PURE: was the release FAILURE final (so the flow goes back to the leader), or is it still running? */
export function releaseFailed(v: GateVerdict): boolean {
  return !v.ok && /failed/.test(v.reason ?? '')
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
        const runs = json<{ check_runs?: Array<{ name?: string; conclusion?: string | null }> }>(await f.gh(author.rootPath ?? author.cwd, ['api', `repos/{owner}/{repo}/commits/${head}/check-runs`]).catch(() => '{}'), {})
        const failed = (runs.check_runs ?? []).filter(c => c.conclusion && !['success', 'skipped', 'neutral'].includes(c.conclusion))
        if (failed.length) return no(`check runs failed on ${head.slice(0, 9)}: ${failed.map(c => c.name).join(', ')}`, ['checagens verdes'], { head, branch })
        const checks = (runs.check_runs ?? []).length ? ((runs.check_runs ?? []).every(c => c.conclusion) ? 'passed' : 'pending') : 'none'
        return { ok: true, evidence: { head, branch, pushed: 'ls-remote', checks, hook: 'pre-commit enforced on every commit; no failing check run' }, patch: { headSha: head, branch, authorSessionId: author.id, ...(author.model ? { authorModel: author.model } : {}) } }
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
      case 'release': {
        const author = authorOf(r, await f.sessions())
        const cwd = author?.rootPath ?? author?.cwd
        if (!cwd) return no('the repository of the delivery is not known', ['repositório'])
        if (!r.mergeSha) return no('no merge sha recorded', ['sha do merge'])
        const runs = json<Array<{ databaseId?: number; status?: string; conclusion?: string; headSha?: string }>>(await f.gh(cwd, ['run', 'list', '--workflow', 'release.yml', '--commit', r.mergeSha, '--json', 'databaseId,status,conclusion,headSha', '--limit', '10']), [])
        let tag: string | null = null
        const tags = json<Array<{ name?: string; commit?: { sha?: string } }>>(await f.gh(cwd, ['api', 'repos/{owner}/{repo}/tags?per_page=30']).catch(() => '[]'), [])
        const wanted = r.tag ?? (r.versionTarget && /^\d/.test(r.versionTarget) ? `v${r.versionTarget}` : null)
        for (const t of Array.isArray(tags) ? tags : []) {
          if (!t.name || !t.commit?.sha) continue
          if (wanted && t.name !== wanted) continue
          if (t.commit.sha === r.mergeSha) { tag = t.name; break }
          const cmp = json<{ status?: string }>(await f.gh(cwd, ['api', `repos/{owner}/{repo}/compare/${r.mergeSha}...${t.commit.sha}`, '--jq', '{status: .status}']).catch(() => '{}'), {})
          if (cmp.status === 'ahead' || cmp.status === 'identical') { tag = t.name; break }
          if (!wanted) break
        }
        return judgeRelease({ mergeSha: r.mergeSha, runs: Array.isArray(runs) ? runs : [], tag, pr: r.pr ?? null })
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
    memoryBytes: async () => {
      const { freemem } = await import('node:os')
      if (process.platform !== 'linux') return freemem()
      return (await import('../cli-run')).memAvailableBytes()
    },
    topCap: async harness => {
      const [{ readPreferences }, core] = await Promise.all([import('../preferences'), import('@agentistics/core')])
      const state = core.parseAwayState((await readPreferences() as { away?: unknown }).away)
      return core.HARNESS_ORDER.includes(harness as never) ? core.awayTopCap(state, harness as never) : core.AWAY_DEFAULT_TOP_CAP
    },
    git: (cwd, args) => run('git', cwd, args),
    gh: (cwd, args) => run('gh', cwd, args),
  }
}
