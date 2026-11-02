import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitEnv } from '../backup/repo-probe'
import { sessaoComPapelHostOp } from '../sessions/spawn-gate'

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
  const consecutive = previous && snapshot.polledAtMs > previous.at && snapshot.polledAtMs - previous.at <= STREAK_MAX_GAP_MS
  const count = consecutive ? previous.count + 1 : 1
  // Same poll read twice keeps the older mark so it cannot count as a second confirmation.
  if (!previous || snapshot.polledAtMs > previous.at) streaks.set(id, { at: snapshot.polledAtMs, count })
  return count >= 2 ? { ok: true, sessionId: id, polls: count } : refuse('session is waiting, but needs a second confirmed poll', ['second waiting poll'])
}

const LIVE_STATES = new Set(['working', 'waiting', 'waiting-approval'])

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
export function triggerHostOps(deps: TriggerHostDeps = defaultTriggerHostDeps()) {
  return {
    'aviso-ao-dono': async (value: unknown) => {
      const text = typeof inputOf(value).text === 'string' ? (inputOf(value).text as string).trim() : ''
      if (!text) return refuse('an away notice needs text', ['text'])
      return (await deps.awayNotice(text)) ? { ok: true } : refuse('the away notice could not be raised', ['owner notification'])
    },
    'sessoes-gerenciadas': async () => {
      const [registry, rows, roleOf] = await Promise.all([deps.registry(), deps.rows().catch(() => []), deps.roles().catch(() => () => undefined)])
      const live = new Set(rows.filter(r => LIVE_STATES.has(r.state ?? '')).map(r => r.id))
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
      const sent = await deps.prompt(to, `[from flow ${flow} · nudge]\n${body}`)
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
export function flowHostOps(triggerDeps?: TriggerHostDeps) {
  return {
    // DSL.TIPO-SESSAO op 1, called by the engine's `portao-de-spawn` flow — the same decision the host applies without it.
    'sessao-com-papel': sessaoComPapelHostOp(),
    // ORQ.H4: what the plan allows now (op 3 of the spawn gate and the encaixe-do-pedido flow).
    'capacidade-de-workers': async (value: unknown) => workerCapacity(defaultBudgets, () => sessionAccount(sessionOf(value) ?? undefined)),
    ...triggerHostOps(triggerDeps),
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
