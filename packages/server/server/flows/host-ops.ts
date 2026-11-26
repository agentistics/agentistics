import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { readRawFleetSnapshot } from '../cli-start'

const exec = promisify(execFile)
/** Bound every git probe and suppress index refreshes, fsmonitor hooks and credential prompts. */
const git = (cwd: string, args: string[]) => exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
  timeout: 15_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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

const LIVE_STATES = new Set(['working', 'waiting', 'waiting-approval'])

/** What the event-triggered flows need from the host, injected so the mapping is tested without a fleet. */
export interface TriggerHostDeps {
  registry(): Promise<ReadonlyArray<{ id: string; cwd: string; createdAt?: string; endedAt?: string; taskId?: string; subtaskId?: string; leader?: boolean; conversationId?: string }>>
  rows(): Promise<ReadonlyArray<{ id: string; conversationId?: string | undefined; state?: string }>>
  /** The stored roles, read FRESH for each universe snapshot (a promotion or demotion counts at once). */
  roles(): Promise<(row: { id: string; conversationId?: string | undefined }) => string | undefined>
  /** Type a line into a live session through the composer's send path. */
  prompt(rowId: string, text: string): Promise<{ ok: boolean; message?: string }>
  /** The owner-facing away notice (bell, Nay toast, phone push) — `away.notice`. */
  awayNotice(text: string): Promise<boolean>
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
      return { ok: out.ok, ...(out.message ? { message: out.message } : {}) }
    },
    awayNotice: async text => {
      const notify = (await (await import('../away')).defaultAwayDeps()).notify
      if (!notify) return false
      notify(text, 'flow:pedido-do-dono')
      return true
    },
  }
}

/** What proving "the caller is the owner, outside every managed session" reads (injected for tests). */
export interface OwnerProofDeps {
  env: Record<string, string | undefined>
  /** Live pane pids by managed id; `undefined` = the backend could not list them. */
  panePids(): Promise<ReadonlyMap<string, number> | undefined>
  /** Pids agentop recorded for pane-less (structured) sessions. */
  managedPids(): Promise<number[]>
  /** This process's ancestor chain, self first. */
  chain(): number[]
  /** `/proc/<pid>/cgroup` (`self` for this process); `undefined` = unreadable, `null` = this platform has none. */
  cgroup(pid: number | 'self'): string | undefined | null
}

/**
 * PURE over its deps. The owner's override must come from OUTSIDE every managed session: not by the
 * environment (an `env -u` drops it) but by the process tree (no session pane or recorded process is an
 * ancestor) AND the cgroup (a session's processes, even a `setsid` escapee, stay in the server's unit).
 * Anything that cannot be read REFUSES.
 */
export async function proveOwnerCaller(d: OwnerProofDeps): Promise<{ ok: true } | Refusal> {
  if (d.env.AGENTOP_MANAGED_ID?.trim()) return refuse('the caller runs inside a managed session (AGENTOP_MANAGED_ID)', ['a terminal outside agentistics sessions'])
  const panes = await d.panePids().catch(() => undefined)
  if (!panes) return refuse('the session backend could not list its panes, so the caller cannot be proven outside them', ['readable session backend'])
  const anchors = [...panes.values(), ...(await d.managedPids().catch(() => [] as number[]))]
  const chain = d.chain()
  if (chain.length < 2) return refuse('the process tree could not be read', ['readable process tree'])
  if (anchors.some(a => chain.includes(a))) return refuse('the caller descends from a managed session', ['a terminal outside agentistics sessions'])
  const mine = d.cgroup('self')
  if (mine === undefined) return refuse('the caller cgroup could not be read', ['readable /proc/self/cgroup'])
  if (mine !== null) {
    for (const pid of anchors) {
      const theirs = d.cgroup(pid)
      if (theirs === undefined) continue // a pane that just ended
      if (theirs === mine) return refuse('the caller shares the cgroup of a managed session', ['a terminal outside agentistics sessions'])
    }
  }
  return { ok: true }
}

export function defaultOwnerProofDeps(): OwnerProofDeps {
  return {
    env: process.env,
    panePids: async () => {
      const backend = await (await import('../sessions/index')).resolveBackend()
      return (backend as { listPanePids?: () => Promise<Map<string, number>> }).listPanePids?.()
    },
    managedPids: async () => {
      const [{ readRegistry }, { managedProcessPids }] = await Promise.all([import('../sessions/registry'), import('../sessions/session-identity')])
      return (await readRegistry()).filter(r => !r.endedAt).flatMap(r => managedProcessPids(r.id))
    },
    chain: () => {
      const out: number[] = []
      let pid = process.pid
      for (let i = 0; i < 32 && pid > 1 && !out.includes(pid); i++) {
        out.push(pid)
        try { const m = /^PPid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); if (!m) break; pid = Number(m[1]) } catch { break }
      }
      return out
    },
    cgroup: pid => {
      if (!existsSync('/proc/self/cgroup')) return null
      try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim() } catch { return undefined }
    },
  }
}

/** The host ops the trigger layer calls: the managed-session universe and a nudge into a live session. */
export function triggerHostOps(deps: TriggerHostDeps = defaultTriggerHostDeps(), proof: () => OwnerProofDeps = defaultOwnerProofDeps) {
  return {
    'origem-do-dono': async () => proveOwnerCaller(proof()),
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
      return sent.ok ? { ok: true, to } : refuse(sent.message ?? 'the nudge was not delivered', ['live session'])
    },
  }
}

/** The host operation registry: the v1 read-only gates plus the trigger layer's two host ops. */
export function flowHostOps(triggerDeps?: TriggerHostDeps) {
  return {
    ...triggerHostOps(triggerDeps),
    'sessao-parada': async (value: unknown) => {
      const id = sessionOf(value)
      if (!id) return refuse('session id is required', ['sessionId'])
      const snapshot = await readRawFleetSnapshot()
      const row = snapshot.sessions.find(s => s.id === id)
      if (!row) return refuse('session was not found', ['existing session'])
      if (row.status !== 'running' || row.activity !== 'waiting' || row.background === true) {
        return refuse('session is not confirmed stopped', ['waiting activity on two consecutive polls', 'no background work'])
      }
      const previous = streaks.get(id)
      const count = previous && snapshot.polledAtMs > previous.at ? previous.count + 1 : 1
      streaks.set(id, { at: snapshot.polledAtMs, count })
      return count >= 2 ? { ok: true, sessionId: id, polls: count } : refuse('session is waiting, but needs a second confirmed poll', ['second waiting poll'])
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
