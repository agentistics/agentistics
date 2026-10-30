/**
 * spawn-gate.ts — DSL.TIPO-SESSAO part 2: the ONE spawn gate (`portao-de-spawn`) every door calls BEFORE a role is
 * written or a row created (spec: leader/specs/dsl-tipo-sessao.md). Doors: `agentop session <harness>` (cli-start),
 * `session batch` (cli-batch), the web/TUI/VS Code spawn (fleet-spawn), a reopen, a leader hand-off, an engine and a
 * flow.
 *
 * Op 1 — `sessao-com-papel` — is `decideSessionRole` below: the role comes from the session's FUNCTION, in this order:
 * a hand-off → leader; an explicit `--role`; a leader title prefix → leader; started by a session or a flow (with a
 * parent or a subtask) → worker. A session or a flow that asks for a spawn whose role cannot be decided, or whose role
 * contradicts its function, is REFUSED in plain words; the owner may open a session with no role (shown "no role",
 * never invented). Op 2 (H2, hand-offs) and op 3 (H4, a spawn that serves an owner request) run in the engine's
 * `portao-de-spawn` flow when flows are on (no-op passes until H2/H4 land); with flows off, or no engine, op 1 runs
 * here. Fail closed: a gate that cannot answer refuses.
 *
 * "The owner" here is a request with NO session identity (no AGENTOP_MANAGED_ID, no pane or relay ancestor): the
 * per-machine server has no owner credential yet (SECRETS.4), so a process that hides its identity is
 * indistinguishable from the owner — a known limit, shared with H1.
 */
import type { SessionRole } from '@agentistics/core'

export type SpawnDoor = 'cli-start' | 'cli-batch' | 'fleet-spawn' | 'reopen' | 'handoff' | 'engine' | 'flow'
export type SpawnFunction = 'impl' | 'qa' | 'probe'

export interface SpawnFacts {
  door: SpawnDoor
  /** Who asks: a verified session (its managed id), a flow (its name), or the owner (no session identity). */
  /** `engine`: an agent's delegation through the in-process engine (`engine-delegate.ts`) — an agent, never the owner. */
  requestedBy: { kind: 'session'; id: string } | { kind: 'flow'; name: string } | { kind: 'engine' } | { kind: 'owner' }
  harness: string
  role?: SessionRole
  /** The title wears the leader prefix (`[ LEADER ] - …` / `[ LÍDER ] - …`). */
  leaderPrefix?: boolean
  parentId?: string
  taskId?: string
  subtaskId?: string
  title?: string
  /** A reopen: the role the replaced row already had. */
  inheritedRole?: SessionRole
  /** H4: the owner request this spawn serves, when it serves one. */
  pedidoId?: string
  /** H2: a manual hand-off file the leader cites (`--handoff-file`); every open owner request must appear in it. */
  handoffFile?: string
}

export type SpawnGateRefusal = 'role_required' | 'leader_on_subtask' | 'worker_handoff' | 'role_conflict' | 'gate_failed' | 'gate_refused'
export type SpawnGateAnswer =
  | { ok: true; role?: SessionRole; function?: SpawnFunction; origin: 'owner' | { leader: string } | { flow: string }; runId?: string }
  | { ok: false; code: SpawnGateRefusal; reason: string; runId?: string; missing?: string[] }

const SENTENCE: Record<Exclude<SpawnGateRefusal, 'gate_refused' | 'gate_failed'>, string> = {
  role_required: 'A session started by another session or by a flow must say what it is: pass --role worker or --role leader (or start it under a subtask). Nothing was started.',
  leader_on_subtask: 'A leader is filed on a task, not on a subtask: drop --subtask, or start it as --role worker. Nothing was started.',
  worker_handoff: 'A hand-off successor is the new leader, so it cannot be --role worker. Nothing was started.',
  role_conflict: 'This conversation is already recorded with another role; reopen it as it is (drop --role) or start a new session. Nothing was started.',
}

/** A session identity was CLAIMED (AGENTOP_MANAGED_ID) but could not be proven: refused, never taken as the owner. */
export const UNPROVEN_SESSION = 'This command claims to run inside a managed session, but that session could not be proven (identity token or pane), so nothing was started. Run it from that session\'s own terminal, or from your own.'

/** PURE. Op 1 `sessao-com-papel`: the role a spawn is born with, or the plain-words refusal. */
export function decideSessionRole(f: SpawnFacts): SpawnGateAnswer {
  const origin = f.requestedBy.kind === 'session' ? { leader: f.requestedBy.id }
    : f.requestedBy.kind === 'flow' ? { flow: f.requestedBy.name }
    : f.requestedBy.kind === 'engine' ? { flow: 'engine' } : 'owner' as const
  const no = (code: keyof typeof SENTENCE): SpawnGateAnswer => ({ ok: false, code, reason: SENTENCE[code] })
  if (f.door === 'handoff' && f.role === 'worker') return no('worker_handoff')
  // A reopen/resume keeps the role its conversation has: asking for another is refused BEFORE any spawn (QA F6).
  if (f.inheritedRole && f.role && f.role !== f.inheritedRole && f.door !== 'handoff') return no('role_conflict')
  const role: SessionRole | undefined = f.door === 'handoff' ? 'leader'
    : f.role ?? f.inheritedRole ?? (f.leaderPrefix ? 'leader'
      // A parent makes a worker (the owner filing one under a leader too); an agent (session, flow, engine) with a subtask too.
      : f.parentId || (f.requestedBy.kind !== 'owner' && (f.subtaskId || f.requestedBy.kind === 'flow' || f.requestedBy.kind === 'engine')) ? 'worker' : undefined)
  if (role === 'leader' && f.subtaskId && f.door !== 'reopen') return no('leader_on_subtask')
  // A reopen is the same piece of work: it keeps the role it had, even none (a legacy row stays reopenable).
  if (!role && f.requestedBy.kind !== 'owner' && f.door !== 'reopen') return no('role_required')
  const fn: SpawnFunction | undefined = role === 'worker' ? (/^\s*(?:re-?\s*qa|qa)\b/i.test(f.title ?? '') ? 'qa' : 'impl') : undefined
  return { ok: true, ...(role ? { role } : {}), ...(fn ? { function: fn } : {}), origin }
}

export interface SpawnGateDeps {
  /** The engine's flows, when an official engine with flows on is loaded; null otherwise (then op 1 runs here). */
  flows: () => Promise<{ list(): readonly string[]; run(name: string, inputs?: Record<string, unknown>): Promise<unknown> } | null>
}

export function defaultSpawnGateDeps(): SpawnGateDeps {
  return {
    flows: async () => {
      const { flowsExperimentalOn } = await import('../native-gate')
      if (!flowsExperimentalOn()) return null
      const load = await import('../engine/load')
      await load.loadEngine() // default options: the engine keeps its own load diagnostics (QA F5)
      return load.engine()?.flows ?? null
    },
  }
}

/**
 * The gate. With the engine's `portao-de-spawn` available: one journaled run (event `session.spawn.requested`; op 1,
 * then the H2/H4 slots). Without it: op 1 here. Never throws; anything unreadable REFUSES (`gate_failed`).
 */
export async function spawnGate(f: SpawnFacts, deps: SpawnGateDeps = defaultSpawnGateDeps()): Promise<SpawnGateAnswer> {
  // Op 1 is decided HERE, always, and is authoritative: the engine run may only REFUSE (H2/H4) or confirm it.
  const local = decideSessionRole(f)
  const failed = (why: string, runId?: string): SpawnGateAnswer => ({ ok: false, code: 'gate_failed', reason: `The spawn gate ${why}, so nothing was started — try again.`, ...(runId ? { runId } : {}) })
  let flows: Awaited<ReturnType<SpawnGateDeps['flows']>> = null
  let hasGate = false
  try {
    flows = await deps.flows()
    hasGate = !!flows && flows.list().includes('portao-de-spawn')
  } catch { return failed('could not be reached') }
  if (!flows || !hasGate) return local
  let raw: unknown
  try { raw = await flows.run('portao-de-spawn', { ...f }) } catch (e) { return failed(`failed (${e instanceof Error ? e.message : String(e)})`) }
  const run = (raw && typeof raw === 'object' ? raw : {}) as { runId?: string; status?: string; output?: unknown; refusal?: { reason?: string; missing?: unknown } }
  const id = run.runId ? { runId: run.runId } : {}
  if (run.status === 'refused') {
    // Op 1's own refusal keeps its code; an H2/H4 refusal is the gate's — with what is missing (the pedido ids an
    // H2 refusal names) carried to the door's message, never left in the run record only.
    if (!local.ok) return { ...local, ...id }
    const missing = Array.isArray(run.refusal?.missing) ? run.refusal.missing.filter((m): m is string => typeof m === 'string' && !!m) : []
    const reason = run.refusal?.reason ?? 'The spawn gate refused this start.'
    const unsaid = missing.filter(m => !reason.includes(m))
    return { ok: false, code: 'gate_refused', reason: unsaid.length ? `${reason} (missing: ${unsaid.join(', ')})` : reason, ...(missing.length ? { missing } : {}), ...id }
  }
  if (run.status !== 'success') return failed(`did not finish (${run.status ?? 'no status'})`, run.runId)
  const out = (run.output && typeof run.output === 'object' ? run.output : {}) as Partial<Extract<SpawnGateAnswer, { ok: true }>>
  // FAIL CLOSED: a success the run did not confirm (no output, ok !== true) or a role that disagrees with op 1 here.
  if (out.ok !== true) return failed('returned no decision', run.runId)
  if (!local.ok) return { ...local, ...id }
  if ((out.role ?? undefined) !== (local.role ?? undefined)) return failed(`and the host disagree on the role (${out.role ?? 'none'} vs ${local.role ?? 'none'})`, run.runId)
  return { ...local, ...id }
}

/** The host op the engine flow calls for op 1 (`sessao-com-papel`): the same decision, so both sides agree. */
export function sessaoComPapelHostOp() {
  return async (input: unknown) => {
    const a = decideSessionRole(input as SpawnFacts)
    return a.ok ? a : { refused: true, reason: a.reason, missing: [a.code] }
  }
}

/**
 * Post-spawn: the row is born with the role the gate decided, or the spawn is undone. Re-asserts it once (a role
 * lost to a concurrent writer is written again under the roles lock), then reads it back.
 */
export async function verifyBornRole(
  keys: readonly (string | undefined)[],
  role: SessionRole,
  d: { stored: (keys: readonly (string | undefined)[]) => Promise<SessionRole | undefined>; ensure: (keys: readonly (string | undefined)[], role: SessionRole) => Promise<unknown> },
): Promise<boolean> {
  if ((await d.stored(keys).catch(() => undefined)) === role) return true
  await d.ensure(keys, role).catch(() => undefined)
  return (await d.stored(keys).catch(() => undefined)) === role
}
