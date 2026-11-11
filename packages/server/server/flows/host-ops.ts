import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readlink, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { gitEnv } from '../backup/repo-probe'
import { sessaoComPapelHostOp } from '../sessions/spawn-gate'
import { lastMessageTo } from '../sessions/last-message'
import { ambienteHostOps } from './ambiente-host'
import { processHostOps } from './process-ops'
import { stalledHostOps } from './stalled-host'
import { perfWatchHostOps } from './perf-watch'
import { pipelineHostOps } from './pipeline-host'
import { deliveryHostOps } from '../delivery/host-ops'
import { isLiveState } from '@agentistics/core'

const exec = promisify(execFile)
/**
 * Bound every git probe and suppress index refreshes, fsmonitor hooks and credential prompts. The environment drops the
 * repository-location variables (GIT_DIR, GIT_INDEX_FILE…) a parent git exports, so a probe always reads `cwd`'s repo.
 */
const git = (cwd: string, args: string[]) => exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
  timeout: 15_000,
  env: gitEnv(),
})
type Input = Record<string, unknown>
type Refusal = { refused: true; reason: string; missing: string[] }
const refuse = (reason: string, missing: string[] = []): Refusal => ({ refused: true, reason, missing })
const inputOf = (v: unknown): Input => v && typeof v === 'object' ? v as Input : {}
const cwdOf = (v: unknown): string | null => typeof inputOf(v).cwd === 'string' && (inputOf(v).cwd as string).length > 0 ? inputOf(v).cwd as string : null
const sessionOf = (v: unknown): string | null => {
  const i = inputOf(v)
  return typeof i.sessionId === 'string' ? i.sessionId : typeof i.session === 'string' ? i.session : null
}

/** Resolve a path through symlinks; a path that no longer exists comes back as written (never throws). */
const real = async (p: string): Promise<string> => realpath(p).catch(() => p)
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

export interface WorktreeEntry { path: string; locked: boolean; prunable: boolean }
/** Parse `git worktree list --porcelain`; the first entry is always the main checkout. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  return out.split(/\n\s*\n/).map(block => {
    const lines = block.split('\n')
    const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
    return path ? { path, locked: lines.some(l => l === 'locked' || l.startsWith('locked ')), prunable: lines.some(l => l === 'prunable' || l.startsWith('prunable')) } : null
  }).filter((x): x is WorktreeEntry => x !== null)
}

/** I3/I4/I5 — what the worktree-removal ops need to read, injected so the mapping is tested without a fleet. */
export interface WorktreeTargetDeps {
  registry(): Promise<ReadonlyArray<{ id: string; cwd: string; endedAt?: string; repo?: { repo?: string; root?: string; rootPath?: string; worktree: boolean } }>>
  git(cwd: string, args: string[], timeoutMs?: number): Promise<string>
  /** cwd of every process on the machine, or null where it cannot be read (not Linux). */
  procCwds(): Promise<string[] | null>
}

export type WorktreeTarget =
  | { kind: 'shared'; path: string; reason: string }
  | { kind: 'gone'; path: string; rootPath: string; listed: boolean }
  | { kind: 'target'; path: string; rootPath: string; branch: string; head: string; repo: string; endedAt?: string; liveSessions: string[]; liveProcesses: number; processCheck: 'ok' | 'skipped' }
  | ({ kind: 'refused' } & Refusal)

/**
 * The ONE worktree a session may have removed, derived only from the registry (I3): its recorded cwd, a linked worktree of
 * a recorded parent repository that still exists. A shared checkout (cwd in the main checkout) is never a target (I5).
 */
export async function worktreeTarget(sessionId: string, deps: WorktreeTargetDeps): Promise<WorktreeTarget> {
  const denied = (reason: string, missing: string[] = []): WorktreeTarget => ({ kind: 'refused', ...refuse(reason, missing) })
  const rows = await deps.registry().catch(() => null)
  if (!rows) return denied('the session registry could not be read', ['readable registry'])
  const row = rows.find(r => r.id === sessionId)
  if (!row) return denied('session was not found', ['existing session'])
  const cwd = await real(row.cwd)
  if (!row.repo?.worktree) return { kind: 'shared', path: cwd, reason: 'the registry does not record a linked worktree' }
  const rootRaw = row.repo.rootPath
  if (!rootRaw) return denied('the registry has no parent repository path', ['repo.rootPath'])
  const rootPath = await real(rootRaw)
  const text = async (dir: string, args: string[], t?: number) => (await deps.git(dir, args, t)).trim()
  let alvo: string
  try { await readdir(rootPath) } catch { return denied('the parent repository no longer exists', ['parent repository']) }
  // The folder is already gone: say whether git still lists it, so the flow can tell "already removed" from "metadata left".
  if (!(await stat(row.cwd).then(() => true, () => false))) {
    const listed = await deps.git(rootPath, ['worktree', 'list', '--porcelain']).then(o => parseWorktreeList(o).some(e => e.path === row.cwd || e.path === cwd), () => true)
    return { kind: 'gone', path: cwd, rootPath, listed }
  }
  try { alvo = await real(await text(cwd, ['rev-parse', '--show-toplevel'])) } catch { return denied('the session folder is gone or not a git worktree', ['existing worktree']) }
  if (alvo === rootPath) return { kind: 'shared', path: alvo, reason: 'the session works in the main checkout' }
  try {
    const gitDir = await real(await text(alvo, ['rev-parse', '--absolute-git-dir']))
    const common = await real((await text(alvo, ['rev-parse', '--git-common-dir'])).replace(/^(?!\/)/, alvo + '/'))
    if (gitDir === common) return { kind: 'shared', path: alvo, reason: 'the folder is a main checkout, not a linked worktree' }
  } catch { return denied('could not tell a linked worktree from a main checkout', ['readable git dir']) }
  let entries: WorktreeEntry[]
  try { entries = parseWorktreeList(await deps.git(rootPath, ['worktree', 'list', '--porcelain'])) } catch { return denied('could not list the repository worktrees', ['readable worktree list']) }
  const resolved = await Promise.all(entries.map(async e => ({ ...e, path: await real(e.path) })))
  const at = resolved.findIndex(e => e.path === alvo)
  if (at < 0) return denied('the folder is not a worktree of the recorded repository', ['listed worktree'])
  if (at === 0) return { kind: 'shared', path: alvo, reason: 'the folder is the main checkout' }
  if (resolved[at]!.locked) return denied('the worktree is locked', ['unlocked worktree'])
  if (resolved[at]!.prunable) return denied('the worktree is prunable (metadata only)', ['present worktree'])
  if (resolved.some((e, i) => i !== at && e.path !== alvo && inside(e.path, alvo))) return denied('another worktree lives inside this one', ['no nested worktree'])
  let head: string
  let branch: string
  try { head = await text(alvo, ['rev-parse', 'HEAD']); branch = await text(alvo, ['branch', '--show-current']) } catch { return denied('could not read the worktree HEAD', ['readable HEAD']) }
  const liveRows = await Promise.all(rows.filter(r => !r.endedAt).map(async r => ({ id: r.id, cwd: await real(r.cwd) })))
  const liveSessions = liveRows.filter(r => inside(r.cwd, alvo)).map(r => r.id)
  const procs = await deps.procCwds().catch(() => null)
  const liveProcesses = procs ? (await Promise.all(procs.map(p => real(p)))).filter(p => inside(p, alvo)).length : 0
  return { kind: 'target', path: alvo, rootPath, branch, head, repo: row.repo.repo ?? '', ...(row.endedAt ? { endedAt: row.endedAt } : {}), liveSessions, liveProcesses, processCheck: procs ? 'ok' : 'skipped' }
}

/** Linux only: the cwd of every process, read with readlink; permission errors are ignored. */
async function linuxProcCwds(): Promise<string[] | null> {
  if (process.platform !== 'linux') return null
  const pids = (await readdir('/proc').catch(() => [])).filter(n => /^\d+$/.test(n))
  const out = await Promise.all(pids.map(pid => readlink(join('/proc', pid, 'cwd')).catch(() => null)))
  return out.filter((x): x is string => typeof x === 'string')
}

export function defaultWorktreeTargetDeps(): WorktreeTargetDeps {
  return {
    registry: async () => (await import('../sessions/registry')).readRegistry(),
    git: async (cwd, args, timeoutMs = 15_000) => (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { timeout: timeoutMs, env: gitEnv() })).stdout,
    procCwds: linuxProcCwds,
  }
}

/** `alvo-trabalho` — where a session's work really is, read only from facts the host already holds. */
export interface WorkTargetDeps {
  /** The registry row: the cwd the session was STARTED in and its conversation id. */
  session(sessionId: string): Promise<{ cwd: string; conversationId?: string; label?: string } | null>
  /** The cwd the session ENDED UP in (`SessionMeta.current_cwd`, the consolidate store), when it records one. */
  storedCwd(sessionId: string, conversationId?: string): Promise<string | undefined>
  git(cwd: string, args: string[]): Promise<string>
}

/**
 * FECHAR.CWD-COMPARTILHADO: a worker started in a BARE clone (or a shared checkout) does its work in a linked worktree it
 * made itself, so the registry cwd says nothing about whether ITS work is saved. The one place that names where it went is
 * the store's `current_cwd`. It is accepted only if it is a LINKED worktree (not bare, not a main checkout) of the SAME
 * repository the session started in and git lists it; anything else is "not identified" — never a guess.
 *  - `{ ok: true, path }`          the session's own worktree (differs from its start cwd).
 *  - `{ ok: true, bare: boolean }` nothing identified; `bare` says the start cwd has no work tree at all.
 */
export async function workTarget(sessionId: string, deps: WorkTargetDeps): Promise<Record<string, unknown> | Refusal> {
  const row = await deps.session(sessionId).catch(() => null)
  if (!row) return refuse('session was not found', ['existing session'])
  const text = async (dir: string, args: string[]) => (await deps.git(dir, args)).trim()
  const start = await real(row.cwd)
  let bare = false
  let startCommon: string | null = null
  // FLUXO.AVISOS: "the folder is gone" and "the folder is not a repository" are FACTS the engine needs (a handback plus a
  // stopped session is then the evidence), not a silent `ok` that makes the close flow ask for a commit nobody can make.
  let unreadable = false
  try {
    bare = (await text(start, ['rev-parse', '--is-bare-repository'])) === 'true'
    startCommon = await real(await text(start, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  } catch { unreadable = true }
  const exists = await stat(start).then(s => s.isDirectory(), () => false)
  const none: Record<string, unknown> = {
    ok: true, bare, cwd: start,
    ...(!exists ? { gone: true } : {}),
    ...(exists && unreadable ? { notRepo: true } : {}),
  }
  const where = await deps.storedCwd(sessionId, row.conversationId).catch(() => undefined)
  if (!where || !startCommon) return none
  const path = await real(where)
  if (path === start) return none
  // The worktree the session worked in is recorded and no longer there (it removed it itself): say so, never guess a path.
  if (!(await stat(path).then(s => s.isDirectory(), () => false))) return { ...none, goneWorktree: path }
  try {
    if ((await text(path, ['rev-parse', '--is-bare-repository'])) === 'true') return none
    const gitDir = await real(await text(path, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']))
    const common = await real(await text(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    if (gitDir === common || common !== startCommon) return none
    const top = await real(await text(path, ['rev-parse', '--show-toplevel']))
    const listed = parseWorktreeList(await deps.git(start, ['worktree', 'list', '--porcelain']))
    if (!(await Promise.all(listed.map(e => real(e.path)))).includes(top)) return none
    return { ok: true, bare, path: top, cwd: start }
  } catch { return none }
}

/** A session whose NAME says it only reads: a QA or a probe has no code of its own to save. */
const NO_CODE_LABEL = /(^|[^a-z])(qa|probe|sonda)([^a-z]|$)/i

/**
 * FLUXO.AVISOS 7 — PURE. Does this session have code of its own that "saved work" could mean something for?
 *  - `qa` / `probe`: its name says it only reads (a QA session reviews another's branch, a probe measures);
 *  - `no-worktree`: it started in a bare/shared checkout or a folder that is gone or not a repository and NO worktree of
 *    its own could be identified (or the one it made is already removed) — there is no tree to inspect.
 * In both, the final handback plus a stopped session is the whole proof; the engine must not ask for a commit or push.
 */
export function ownsNoCode(label: string | undefined, target: Record<string, unknown>): { noCode: boolean; reason: string } {
  if (label && NO_CODE_LABEL.test(label)) return { noCode: true, reason: /(^|[^a-z])qa([^a-z]|$)/i.test(label) ? 'qa' : 'probe' }
  const identified = typeof target.path === 'string'
  if (!identified && (target.gone === true || target.notRepo === true || target.bare === true || typeof target.goneWorktree === 'string')) return { noCode: true, reason: 'no-worktree' }
  return { noCode: false, reason: 'owns-work' }
}

export function defaultWorkTargetDeps(): WorkTargetDeps {
  return {
    session: async id => {
      const row = (await (await import('../sessions/registry')).readRegistry()).find(r => r.id === id)
      return row ? { cwd: row.cwd, ...(row.conversationId ? { conversationId: row.conversationId } : {}), ...(row.label ? { label: row.label } : {}) } : null
    },
    storedCwd: async (id, conversationId) => {
      const map = await (await import('../consolidate')).loadConsolidated()
      const meta = (conversationId ? map.get(conversationId) : undefined) ?? map.get(id)
      return meta?.current_cwd || undefined
    },
    git: async (cwd, args) => (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { timeout: 15_000, env: gitEnv() })).stdout,
  }
}

const REMOVE_KEYS = new Set(['sessionId', 'path', 'head', 'snapshotId'])

/** The two worktree ops: read the target (I11), and remove it only after recomputing everything (I9). */
export function worktreeHostOps(deps: WorktreeTargetDeps = defaultWorktreeTargetDeps()) {
  return {
    'alvo-worktree': async (value: unknown) => {
      const id = sessionOf(value)
      if (!id) return refuse('session id is required', ['sessionId'])
      const t = await worktreeTarget(id, deps)
      if (t.kind === 'refused') return { refused: true, reason: t.reason, missing: t.missing }
      if (t.kind === 'shared') return { ok: true, shared: true, path: t.path, reason: t.reason }
      if (t.kind === 'gone') return { ok: true, shared: false, gone: true, path: t.path, rootPath: t.rootPath, listed: t.listed }
      return { ok: true, shared: false, path: t.path, rootPath: t.rootPath, branch: t.branch, head: t.head, repo: t.repo, ...(t.endedAt ? { endedAt: t.endedAt } : {}), liveSessions: t.liveSessions, liveProcesses: t.liveProcesses, processCheck: t.processCheck }
    },
    'remover-worktree': async (value: unknown) => {
      const i = inputOf(value)
      const extra = Object.keys(i).find(k => !REMOVE_KEYS.has(k))
      if (extra) return refuse(`unexpected input ${extra}`, [])
      const { sessionId, path, head, snapshotId } = i
      if (typeof sessionId !== 'string' || !sessionId || typeof path !== 'string' || !path || typeof head !== 'string' || !head || typeof snapshotId !== 'string' || !snapshotId) {
        return refuse('sessionId, path, head and snapshotId are required', ['sessionId', 'path', 'head', 'snapshotId'])
      }
      const t = await worktreeTarget(sessionId, deps)
      if (t.kind === 'refused') return { refused: true, reason: t.reason, missing: t.missing }
      if (t.kind === 'shared') return refuse('a shared checkout is never removed', ['linked worktree'])
      if (t.kind === 'gone') return refuse('the worktree folder is already gone', ['existing worktree'])
      if (!t.endedAt) return refuse('the session has not ended', ['ended session'])
      if (t.path !== path) return refuse('the requested path is not the registry worktree', ['registry worktree'])
      if (t.head !== head) return refuse('HEAD changed since the snapshot', ['HEAD equal to the snapshot'])
      if (t.liveSessions.length || t.liveProcesses) return refuse('a live session or process is inside the worktree', ['no live session or process'])
      try {
        const status = await deps.git(t.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
        if (status.length > 0) return refuse('working tree is dirty', ['clean working tree'])
        await deps.git(t.rootPath, ['worktree', 'remove', t.path], 120_000)
      } catch (error) { return refuse(`git refused to remove the worktree: ${String(error).slice(0, 300)}`, ['removable worktree']) }
      return { ok: true, removed: true, path: t.path, branch: t.branch, head: t.head, snapshotId }
    },
  }
}

/** F3 DOCKER.DETECTAR — what the read-only probe needs, injected so it is tested with a fake `docker`. */
export interface DockerProbeDeps {
  /** Run `docker <args>`; `null` when the binary is missing, otherwise its exit code and stdout. */
  docker(args: string[]): Promise<{ code: number; stdout: string } | null>
  isWsl(): boolean
  /** True where Docker Desktop's WSL integration mount exists. */
  desktopMount(): boolean
}
export type DockerKind = 'wsl2-desktop' | 'desktop' | 'native' | 'none'
export interface DockerState { present: boolean; running: boolean; version: string | null; kind: DockerKind }

export function defaultDockerProbeDeps(): DockerProbeDeps {
  return {
    docker: async args => {
      try { return { code: 0, stdout: (await exec('docker', args, { timeout: 8_000, windowsHide: true })).stdout } }
      catch (error) {
        const e = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string }
        return e.code === 'ENOENT' ? null : { code: typeof e.code === 'number' ? e.code : 1, stdout: typeof e.stdout === 'string' ? e.stdout : '' }
      }
    },
    isWsl: () => process.platform === 'linux' && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(readFileSync('/proc/version', 'utf8'))),
    desktopMount: () => existsSync('/mnt/wsl/docker-desktop'),
  }
}

/** Read-only: asks `docker` about itself and never installs, starts or stops anything. */
export async function detectDocker(deps: DockerProbeDeps = defaultDockerProbeDeps()): Promise<DockerState> {
  const client = await deps.docker(['version', '--format', '{{.Client.Version}}'])
  // A missing binary is the only "absent": an installed client with no daemon still answers with its own version.
  if (!client) return { present: false, running: false, version: null, kind: 'none' }
  const clientVersion = client.stdout.trim()
  const server = await deps.docker(['version', '--format', '{{.Server.Version}}'])
  const serverVersion = server && server.code === 0 ? server.stdout.trim() : ''
  const running = serverVersion.length > 0
  const os = running ? (await deps.docker(['info', '--format', '{{.OperatingSystem}}']))?.stdout.trim() ?? '' : ''
  const desktop = /docker desktop/i.test(os) || (!running && deps.desktopMount())
  const kind: DockerKind = desktop ? (deps.isWsl() ? 'wsl2-desktop' : 'desktop') : 'native'
  return { present: true, running, version: serverVersion || clientVersion || null, kind }
}

/** The read-only `docker-detectar` host op. */
export function dockerHostOps(deps?: DockerProbeDeps) {
  return { 'docker-detectar': async () => ({ ok: true, ...(await detectDocker(deps)) }) }
}

const streaks = new Map<string, { at: number; count: number }>()
/** Two waiting polls count as consecutive only when they are at most this far apart (the idle poller ticks every 15 s). */
export const STREAK_MAX_GAP_MS = 45_000
/** Test seam: forget every remembered streak. */
export const resetStoppedStreaks = () => streaks.clear()

/**
 * The "agent stopped" decision for one session over a fleet snapshot, with the streak bookkeeping (N6): a refusal ends the
 * streak, and a streak only grows from a poll that is newer than the last yet within STREAK_MAX_GAP_MS of it.
 */
export function judgeStopped(id: string, snapshot: { polledAtMs: number; sessions: ReadonlyArray<{ id: string; status?: string; activity?: string; background?: boolean }> }): Refusal | { ok: true; sessionId: string; polls: number } {
  const row = snapshot.sessions.find(s => s.id === id)
  if (!row) { streaks.delete(id); return refuse('session was not found', ['existing session']) }
  if (row.status !== 'running' || row.activity !== 'waiting' || row.background === true) {
    streaks.delete(id)
    return refuse('session is not confirmed stopped', ['waiting activity on two consecutive polls', 'no background work'])
  }
  const previous = streaks.get(id)
  // The SAME poll read again (the hub serves a snapshot up to 1 s old, so the flow's `parada` and the `fechar` re-check
  // right after it often share one) adds nothing — but it must not RESET what the earlier read already established
  // either: it answers with the streak's own count. Counting it as a first sighting refused 35 of 42 closes.
  if (previous && snapshot.polledAtMs <= previous.at) {
    return previous.count >= 2 ? { ok: true, sessionId: id, polls: previous.count } : refuse('session is waiting, but needs a second confirmed poll', ['second waiting poll'])
  }
  const consecutive = previous !== undefined && snapshot.polledAtMs - previous.at <= STREAK_MAX_GAP_MS
  const count = consecutive ? previous.count + 1 : 1
  streaks.set(id, { at: snapshot.polledAtMs, count })
  return count >= 2 ? { ok: true, sessionId: id, polls: count } : refuse('session is waiting, but needs a second confirmed poll', ['second waiting poll'])
}

/** A row in one of these is not a process to type into (`successorAlive` reads the same words). */
const DEAD_STATES = new Set(['exited', 'lost', 'closed', 'finished'])

/** What the event-triggered flows need from the host, injected so the mapping is tested without a fleet. */
export interface TriggerHostDeps {
  registry(): Promise<ReadonlyArray<{ id: string; cwd: string; createdAt?: string; endedAt?: string; taskId?: string; subtaskId?: string; leader?: boolean; conversationId?: string; parentSessionId?: string | null }>>
  rows(): Promise<ReadonlyArray<{ id: string; conversationId?: string | undefined; state?: string }>>
  /** The stored roles, read FRESH for each universe snapshot (a promotion or demotion counts at once). */
  roles(): Promise<(row: { id: string; conversationId?: string | undefined }) => string | undefined>
  /** Type a line into a live session through the composer's send path (`failure` as the composer states it). */
  prompt(rowId: string, text: string): Promise<{ ok: boolean; message?: string; failure?: 'prompt' | 'ended' | 'unconfirmed' }>
  /** The owner-facing away notice (bell, Nay toast, phone push) — `away.notice`. */
  awayNotice(text: string): Promise<boolean>
  /**
   * Autonomous mode now (FLUXO.ENTREGA-DSL audit, owner 07/11 ~00:00Z). Optional so older test doubles keep working;
   * absent = read from preferences.
   */
  autonomous?(): Promise<boolean>
  /** End a managed session — the same kill `agentop session kill` and the fleet's kill verb run. */
  kill(rowId: string): Promise<{ ok: boolean; message?: string }>
}

export function defaultTriggerHostDeps(): TriggerHostDeps {
  return {
    registry: async () => (await import('../sessions/registry')).readRegistry(),
    rows: async () => (await (await import('../sessions/fleet-web')).readFleet('en')).rows,
    roles: async () => {
      const [{ readRolesDoc, roleOfRow }, { AGENTISTICS_DATA_DIR }] = await Promise.all([import('../sessions/session-roles'), import('../config')])
      const doc = await readRolesDoc(AGENTISTICS_DATA_DIR)
      return row => roleOfRow(doc.roles, row)
    },
    prompt: async (rowId, text) => {
      const { runFleetAction } = await import('../sessions/fleet-web')
      const out = await runFleetAction('en', { action: 'prompt', id: rowId, text })
      return { ok: out.ok, ...(out.message ? { message: out.message } : {}), ...(out.failure ? { failure: out.failure } : {}) }
    },
    awayNotice: async text => {
      const notify = (await (await import('../away')).defaultAwayDeps()).notify
      if (!notify) return false
      notify(text, 'flow:pedido-do-dono')
      return true
    },
    kill: async rowId => {
      const { runFleetAction } = await import('../sessions/fleet-web')
      const out = await runFleetAction('en', { action: 'kill', id: rowId })
      return { ok: out.ok, ...(out.message ? { message: out.message } : {}) }
    },
  }
}

/**
 * ORQ.H4 — what the plan allows right now, for the engine's "does a worker fit?" (`encaixe.ts`): the cadence
 * (`parallel`) and the 5-hour window of the ASKING LEADER's own account, from the same source as
 * `GET /api/plan-limits` / `agentistics_plan_limits`. Only a FRESH reading of that account counts (QA F4): a stale row
 * describes a meter nobody read, another account's row describes someone else's room — either way the capacity is
 * UNKNOWN → refused, and the engine queues (an unknown capacity never fits). No `rows[0]` fallback.
 */
export async function workerCapacity(
  budgets: () => Promise<readonly import('@agentistics/core').PlanBudget[]>,
  leader: () => Promise<{ harness: string; account: string } | null> = async () => null,
): Promise<{ parallel: number; fiveHourPct: number } | Refusal> {
  const rows = await budgets().catch(() => [] as readonly import('@agentistics/core').PlanBudget[])
  if (!rows.length) return refuse('no plan-limits reading', ['plan-limits reading'])
  const who = await leader().catch(() => null)
  if (!who) return refuse('the asking leader (and so its account) is not known', ['leader session'])
  const accountOf = (b: import('@agentistics/core').PlanBudget) => (b as { account?: string }).account ?? 'default'
  const row = rows.find(b => !b.stale && b.harness === who.harness && accountOf(b) === who.account)
  if (!row) return refuse(`no fresh plan-limits reading of the leader's account (${who.harness}:${who.account})`, ['fresh reading of the leader account'])
  const { routeRecommendation } = await import('@agentistics/core')
  return { parallel: routeRecommendation([row], 'spec-impl').cadence.parallel, fiveHourPct: row.fiveHourPct }
}

/** The harness and account of a managed session (the leader asking for capacity), from the registry. */
export async function sessionAccount(sessionId: string | undefined): Promise<{ harness: string; account: string } | null> {
  if (!sessionId) return null
  const row = (await (await import('../sessions/registry')).readRegistry()).find(m => m.id === sessionId)
  return row ? { harness: row.harness, account: row.accountId ?? 'default' } : null
}

const defaultBudgets = async () => {
  const [{ planLimitsPayload }, { readPreferences }] = await Promise.all([import('../plan-limits'), import('../preferences')])
  return (await planLimitsPayload((await readPreferences()).billing, Date.now())).budgets
}

/** The host ops the trigger layer calls: the managed-session universe and a nudge into a live session. */
export const NUDGE_REPEAT_MS = 60 * 60_000

export function triggerHostOps(deps: TriggerHostDeps = defaultTriggerHostDeps(), now: () => number = Date.now) {
  /** session + flow + text → when it was last delivered. The same reason is not typed into the same session twice in an hour. */
  const nudged = new Map<string, number>()
  return {
    'aviso-ao-dono': async (value: unknown, ctx?: { step?: string }) => {
      const text = typeof inputOf(value).text === 'string' ? (inputOf(value).text as string).trim() : ''
      if (!text) return refuse('an away notice needs text', ['text'])
      // The pedidos reminder's 3rd step ESCALATES to the owner (a request nobody took) — a human step; so does a wait whose
      // owner session ended with no leader to tell (`wait-ended`). The board note still records both. While autonomous
      // mode is on it is skipped here too, so an engine built before the audit cannot call the owner either.
      if (ctx?.step === 'h1-lembrar' || ctx?.step === 'wait-ended') {
        const away = deps.autonomous ? await deps.autonomous().catch(() => true) : await (await import('../delivery/host')).deliveryAutonomous().catch(() => true)
        if (away) return { ok: true, skipped: 'pulado: modo autônomo' }
      }
      return (await deps.awayNotice(text)) ? { ok: true } : refuse('the away notice could not be raised', ['owner notification'])
    },
    'sessoes-gerenciadas': async () => {
      const [registry, rows, roleOf] = await Promise.all([deps.registry(), deps.rows().catch(() => []), deps.roles().catch(() => () => undefined)])
      const live = new Set(rows.filter(r => isLiveState(r.state)).map(r => r.id))
      const stateOf = new Map(rows.map(r => [r.id, r.state]))
      const sessions = registry.map(m => ({
        id: m.id,
        cwd: m.cwd,
        alive: !m.endedAt && live.has(m.id),
        ...(stateOf.get(m.id) ? { state: stateOf.get(m.id) } : {}),
        ...(m.createdAt ? { createdAt: m.createdAt } : {}),
        ...(m.endedAt ? { endedAt: m.endedAt } : {}),
        ...(m.taskId ? { taskId: m.taskId } : {}),
        ...(m.subtaskId ? { subtaskId: m.subtaskId } : {}),
        ...(m.conversationId ? { conversationId: m.conversationId } : {}),
        ...(m.parentSessionId ? { parentSessionId: m.parentSessionId } : {}),
        // The stored role wins (a demotion counts); the spawn-time flag only fills in when none is stored.
        ...((roleOf({ id: m.id, conversationId: m.conversationId }) ?? (m.leader ? 'leader' : undefined)) === 'leader' ? { role: 'leader' } : {}),
      }))
      return { sessions }
    },
    'cutucar-sessao': async (value: unknown) => {
      const i = inputOf(value)
      const to = typeof i.to === 'string' ? i.to : ''
      const body = typeof i.body === 'string' ? i.body.trim() : ''
      if (!to || !body) return refuse('a nudge needs to and body', ['to', 'body'])
      const flow = typeof i.flow === 'string' && /^[a-z0-9-]+$/.test(i.flow) ? i.flow : 'dsl'
      // A wait's wake is re-sent by design until acked (the engine owns that cadence); every other flow nudges once an hour.
      const key = `${to}\0${flow}\0${body}`
      const last = nudged.get(key)
      if (flow !== 'wait' && last !== undefined && now() - last < NUDGE_REPEAT_MS) return { ok: true, to, deduped: true }
      // FLUXO.AVISOS: a session that already ENDED is never typed into — the composer's prompt path follows an ended row to
      // its continuation (or reopens it), so a late nudge (seen 5x on 07-08/11) woke a session somebody had just closed.
      // The fleet is re-read RIGHT NOW (not the engine's earlier snapshot): killed since the flow decided to nudge = not typed into.
      const target = (await deps.registry().catch(() => [])).find(m => m.id === to)
      const state = (await deps.rows().catch(() => [])).find(r => r.id === to)?.state
      if (target?.endedAt || (state !== undefined && DEAD_STATES.has(state))) return { ...refuse('the session already ended; nothing was typed into it', ['live session']), failure: 'ended' as const }
      const sent = await deps.prompt(to, `[from flow ${flow} · nudge]\n${body}`)
      if (sent.ok) {
        nudged.set(key, now())
        if (nudged.size > 500) for (const [k, at] of nudged) if (now() - at >= NUDGE_REPEAT_MS) nudged.delete(k)
      }
      // DSL.ACORDAR reads `failure`: a dialog open (`prompt`, nothing typed) is retried later; `unconfirmed` may have arrived.
      return sent.ok ? { ok: true, to } : { ...refuse(sent.message ?? 'the nudge was not delivered', ['live session']), ...(sent.failure ? { failure: sent.failure } : {}) }
    },
    // SESSÕES.FECHAR: the engine's `fechar-entregue` calls this only after every gate passed (handback, stopped on two
    // reads, clean tree, work saved). The host only ends the session; it decides nothing.
    'encerrar-sessao': async (value: unknown) => {
      const id = sessionOf(value)
      if (!id) return refuse('session id is required', ['sessionId'])
      const out = await deps.kill(id).catch(error => ({ ok: false, message: String(error) }))
      return out.ok ? { ok: true, sessionId: id, ...(out.message ? { message: out.message } : {}) } : refuse(out.message ?? 'the session could not be ended', ['session end'])
    },
  }
}

/** The host operation registry: the v1 read-only gates plus the trigger layer's two host ops. */
export function flowHostOps(triggerDeps?: TriggerHostDeps, worktreeDeps?: WorktreeTargetDeps, dockerDeps?: DockerProbeDeps, workDeps: WorkTargetDeps = defaultWorkTargetDeps()) {
  return {
    // DSL.TIPO-SESSAO op 1, called by the engine's `portao-de-spawn` flow — the same decision the host applies without it.
    'sessao-com-papel': sessaoComPapelHostOp(),
    // ORQ.H4: what the plan allows now (op 3 of the spawn gate and the encaixe-do-pedido flow).
    'capacidade-de-workers': async (value: unknown) => workerCapacity(defaultBudgets, () => sessionAccount(sessionOf(value) ?? undefined)),
    ...triggerHostOps(triggerDeps),
    ...worktreeHostOps(worktreeDeps),
    ...dockerHostOps(dockerDeps),
    ...processHostOps(),
    ...stalledHostOps(),
    // APP.LENTO: `vigia-desempenho` — sample this process, keep a profile and tell once when a budget stays broken.
    ...perfWatchHostOps(),
    ...pipelineHostOps(),
    // FLUXO.ENTREGA-DSL — the delivery state machine's doors for the engine's entrega/demanda/bloqueio flows.
    ...deliveryHostOps(),
    'alvo-trabalho': async (value: unknown) => {
      const id = sessionOf(value)
      return id ? workTarget(id, workDeps) : refuse('session id is required', ['sessionId'])
    },
    // FLUXO.AVISOS 7: decided here, deterministically — never handed to a model. See `ownsNoCode`.
    'sessao-sem-codigo': async (value: unknown) => {
      const id = sessionOf(value)
      if (!id) return refuse('session id is required', ['sessionId'])
      const target = await workTarget(id, workDeps)
      if ('refused' in target) return target
      const row = await workDeps.session(id).catch(() => null)
      return { ok: true, ...ownsNoCode(row?.label, target), sessionId: id }
    },
    // FLUXO.AVISOS: the newest message typed INTO the session by someone else; the engine's `fechar-entregue` keeps a worker
    // open when this is newer than its final handback (kind='handback' is ignored there). Nothing known = ok:false.
    'ultima-mensagem-sessao': async (value: unknown) => {
      const id = sessionOf(value)
      if (!id) return refuse('session id is required', ['sessionId'])
      const m = lastMessageTo(id)
      return m ? { ok: true, ...m, sessionId: id } : { ok: false, sessionId: id }
    },
    ...ambienteHostOps(),
    'sessao-parada': async (value: unknown) => {
      const id = sessionOf(value)
      if (!id) return refuse('session id is required', ['sessionId'])
      // Loaded lazily (N2): the TUI/backup-sized cli-start module must not weigh on every engine load.
      const { readRawFleetSnapshot } = await import('../cli-start')
      return judgeStopped(id, await readRawFleetSnapshot())
    },
    'arvore-limpa': async (value: unknown) => {
      const cwd = cwdOf(value)
      if (!cwd) return refuse('repository cwd is required', ['cwd'])
      try {
        const { stdout } = await git(cwd, ['status', '--porcelain'])
        return stdout.trim() ? refuse('working tree is dirty', stdout.trim().split('\n')) : { ok: true, cwd }
      } catch (error) { return refuse(`could not inspect working tree: ${String(error)}`, ['readable git worktree']) }
    },
    'trabalho-salvo': async (value: unknown) => {
      const cwd = cwdOf(value)
      if (!cwd) return refuse('repository cwd is required', ['cwd'])
      try {
        const { stdout: branchOut } = await git(cwd, ['branch', '--show-current'])
        const branch = branchOut.trim()
        if (!branch) return refuse('current branch could not be determined', ['branch'])
        const { stdout: headOut } = await git(cwd, ['rev-parse', 'HEAD'])
        const head = headOut.trim()
        const { stdout: remoteOut } = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
        const remote = remoteOut.trim().split(/\s+/)[0]
        return remote === head ? { ok: true, branch, head, evidence: 'ls-remote' } : refuse('local HEAD is not saved on origin', [`push ${branch}`])
      } catch (error) { return refuse(`could not verify remote save: ${String(error)}`, ['reachable origin']) }
    },
    'handback-recebido': async (value: unknown) => {
      const i = inputOf(value)
      return i.handbackReceived === true ? { ok: true } : refuse('no handback was received after the latest commit', ['handback from session to leader'])
    },
    'gravar-veredito': async () => ({ ok: true, readOnly: true }),
    'limpeza-dry-run': async (value: unknown) => {
      const cwd = cwdOf(value) ?? process.cwd()
      try {
        const { stdout } = await git(cwd, ['worktree', 'list', '--porcelain'])
        const paths = stdout.split(/\n(?=worktree )/).map(x => x.match(/^worktree (.+)$/m)?.[1]).filter((x): x is string => Boolean(x))
        return { ok: true, dryRun: true, cwd, worktrees: paths.map(path => ({ path, wouldRemove: false, why: 'deletion is disabled in v1' })) }
      } catch (error) { return refuse(`could not list worktrees: ${String(error)}`, ['readable git worktree']) }
    },
  }
}
