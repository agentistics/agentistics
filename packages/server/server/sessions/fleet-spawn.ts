/**
 * fleet-spawn.ts — PURE. What a START request arriving over HTTP is allowed to ask for.
 *
 * The cockpit's wizard cannot produce an invalid request: it only ever offers the harnesses
 * `startableHarnesses()` returned and the efforts that harness printed in its own `--help`. A
 * request off the wire has no such shape, so the checks the wizard performs by CONSTRUCTION have to
 * be performed here explicitly — and refused in a sentence, never repaired. A spawn is the most
 * powerful thing this server does: it starts a billable coding assistant, with a prompt, in a
 * directory, on this machine.
 *
 * Three rules, each of which exists because the alternative fails silently:
 *
 * - **The directory must be ABSOLUTE.** A relative path resolves against the SERVER's own working
 *   directory, which is wherever `agentop server` happened to be started — not anywhere the caller
 *   named. The session would start somewhere nobody chose and appear, correctly filed, under that
 *   project. Absolute is the only path a caller and this process provably read the same way.
 * - **The harness must be one this machine can START.** The caller passes the list
 *   `startableHarnesses()` produced, so a harness with no spawn spec is refused here for exactly
 *   the reason it is absent from the wizard: it would be offered and then fail.
 * - **An `effort` must be one the CLI itself prints.** `SpawnSpec.efforts` is a genuine closed enum
 *   read off the tool's `--help`; anything else is a usage error the assistant dies on, in a pane
 *   nobody is looking at. A `model`, by contrast, is NEVER validated — `claude --help` documents
 *   `--model` as an alias "or a model's full name", so a fixed list would reject valid input the day
 *   a model ships. It is only refused when the harness has no model flag AT ALL, which is a
 *   different fact: silently dropping it would start a session that is not the one asked for.
 *
 * `attach` is not a field of the request and never can be: attaching needs a real tty, and an HTTP
 * caller has none. A client that wants to enter the session asks for the attach ticket afterwards.
 */

/**
 * What this module needs to know about a harness — a structural subset of
 * `SessionHarnessOption`.
 *
 * Declared locally rather than imported so this leaf names nothing under `@agentistics/tui`, whose
 * entry point pulls in Ink and React. `index.ts` names these types to parse a request body, and the
 * fleet routes load their implementation by dynamic import precisely so a machine that never opens
 * the Sessions page never pays for that graph.
 */
import { hasRolePrefix, isCanonicalMode, readAwaySpawn, type AwaySpawnRequest, type CanonicalMode, type HarnessId } from '@agentistics/core'
import { decideSpawnAccount, type SpawnAccountContext, type SpawnAccountRefusal } from './spawn-account'

export interface SpawnHarness {
  id: string
  /** False when the CLI has no model flag at all — a different fact from an empty suggestion list. */
  supportsModel: boolean
  /** The closed enum the CLI prints. Empty means the tool has no effort flag. */
  efforts: string[]
  /**
   * MODE.EVERYWHERE — the canonical permission modes a session of this harness can START in here: the
   * TUI's flags (`tuiStartModes`) plus what its structured driver takes when a web spawn would run
   * structured. Absent = only the harness's default (no field shown).
   */
  modes?: CanonicalMode[]
}

/** The request body, as it arrives: every field unknown until it has been read. */
export interface FleetSpawnBody {
  harness?: unknown
  cwd?: unknown
  task?: unknown
  /** Board ids of the task / subtask the session is created for (context only; the client files it). */
  taskId?: unknown
  subtaskId?: unknown
  /** The managed id of the session that is starting this one (a verified-by-lookup session id, see `planFleetSpawn`). */
  parent?: unknown
  /** SET BY THE SERVER ONLY (the route overwrites it): the caller proved it is `parent`. */
  parentVerified?: unknown
  /** A leader hand-off: the child inherits the parent's task/subtask filing. Strict boolean. */
  handoff?: unknown
  prompt?: unknown
  model?: unknown
  effort?: unknown
  /** MODE.EVERYWHERE — one of `CANONICAL_MODES`; absent or `default` = the harness's own configuration. */
  mode?: unknown
  label?: unknown
  /**
   * PER-SESSION AWAY MODE: `true`, `false` or `'inherit'` (absent = inherit a VERIFIED away parent's
   * own flag). Read strictly — a truthy string must not switch it on, nor a falsy one off.
   */
  away?: unknown
  /**
   * Start even if this machine's memory budget refuses. Read with a STRICT `typeof` check — see
   * `readForce` below — because JSON carries no guarantee this is a boolean, and a truthy string
   * must never read as consent nobody gave.
   */
  force?: unknown
  /**
   * PLAN.ACCOUNTS D3 (flag `multi-account`): the harness account id (`acc_…`) to run on. Absent →
   * the router's pick for that harness, else the default root. See `spawn-account.ts`.
   */
  account?: unknown
  /**
   * SET BY THE SERVER ONLY (the route overwrites it): the request carries a VERIFIED session identity
   * — an agent is asking. Only then is an account that is off for agents refused.
   */
  callerVerified?: unknown
}

/** An accepted request, in the shape `ControlHost.spawnSession` takes. */
export interface FleetSpawnPlan {
  harness: string
  cwd: string
  task?: string
  taskId?: string
  subtaskId?: string
  parentSessionId?: string
  /** The caller proved it is `parentSessionId` (server-set). */
  parentVerified?: true
  handoff?: true
  prompt?: string
  model?: string
  effort?: string
  mode?: CanonicalMode
  label?: string
  /** A leader title prefix is an explicit leader-role request, shared with the CLI path. */
  role?: 'leader'
  /** Per-session away mode as requested (absent = inherit). */
  away?: AwaySpawnRequest
  /** Always false — see the header. */
  attach: false
  /** See `FleetSpawnBody.force`. Always a genuine boolean, never merely truthy. */
  force?: boolean
  /** PLAN.ACCOUNTS D3: the account decided by `decideSpawnAccount` (absent = the default root). */
  accountId?: string
  /** PLAN.ACCOUNTS D3: always true — the host must not decide the account a second time. */
  accountDecided: true
  /** PLAN.ACCOUNTS D3: the request carried a verified session identity (server-set, see the body). */
  callerVerified?: true
}

/** Why a request was refused. The caller turns it into the user's own language. */
export type FleetSpawnRefusal =
  | 'unknown_harness'
  | 'cwd_missing'
  | 'cwd_relative'
  | 'unknown_effort'
  | 'model_unsupported'
  | 'unknown_mode'
  | 'bad_away'
  | SpawnAccountRefusal

export type FleetSpawnDecision =
  | { ok: true; plan: FleetSpawnPlan }
  /** `detail` is the offending value, so the sentence can name it. */
  | { ok: false; reason: FleetSpawnRefusal; detail?: string }

/**
 * A string field, read the way every other text field in this product is read: trimmed, and an
 * empty one treated as absent rather than as an empty value. A `label` of `''` would name a row
 * with nothing.
 */
function text(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length > 0 ? t : undefined
}

/**
 * POSIX-absolute, and deliberately not `path.isAbsolute`.
 *
 * The session backend is tmux and there is no Windows one (`sessions/index.ts` records why), so a
 * drive-letter path is not a path this machine can start a session in — accepting one because the
 * host process happens to run on Windows would accept a request nothing downstream can honour. A
 * NUL byte is refused outright: it truncates the path in every syscall that eventually receives it.
 */
function absolutePath(raw: string): boolean {
  return raw.startsWith('/') && !raw.includes('\0')
}

/**
 * `true` only for the literal boolean `true` — a STRICT check, not a truthiness one. `force` is
 * consent to start a session this machine's memory budget refused, and JSON gives no guarantee a
 * caller sent a boolean at all: a stray string (`"false"`, a pasted `"0"`) is truthy in JavaScript
 * and must never be read as an override nobody actually gave.
 */
function readForce(raw: unknown): boolean {
  return raw === true
}

/**
 * Read one start request, or say why it cannot be honoured.
 *
 * Total: it never throws, whatever arrives, and it performs no I/O — whether the directory EXISTS
 * is not asked here, because that is a fact about the moment and belongs to the spawn itself (the
 * same distinction `repo-facts.ts` draws between a missing directory and a non-repository one).
 */
export function planFleetSpawn(
  body: FleetSpawnBody,
  harnesses: readonly SpawnHarness[],
  /** PLAN.ACCOUNTS D3: the registry + flag + router picks. Absent = flag off (no account ever). */
  accounts: SpawnAccountContext = { enabled: false, accounts: [] },
): FleetSpawnDecision {
  const harness = text(body.harness)
  const spec = harnesses.find(h => h.id === harness)
  if (!harness || !spec) return { ok: false, reason: 'unknown_harness', ...(harness ? { detail: harness } : {}) }

  const cwd = text(body.cwd)
  if (!cwd) return { ok: false, reason: 'cwd_missing' }
  if (!absolutePath(cwd)) return { ok: false, reason: 'cwd_relative', detail: cwd }

  const effort = text(body.effort)
  if (effort && !spec.efforts.includes(effort)) {
    return { ok: false, reason: 'unknown_effort', detail: effort }
  }

  // A mode is a closed enum (`CANONICAL_MODES`) narrowed to what THIS harness can start in here. A mode it
  // cannot honour is refused, never started in another — "no questions" silently becoming "asks" (or the
  // reverse) is exactly the surprise this field exists to remove.
  const modeText = text(body.mode)
  if (modeText !== undefined && (!isCanonicalMode(modeText) || (modeText !== 'default' && !(spec.modes ?? []).includes(modeText)))) {
    return { ok: false, reason: 'unknown_mode', detail: modeText }
  }
  const mode = modeText !== undefined && modeText !== 'default' ? (modeText as CanonicalMode) : undefined

  const model = text(body.model)
  if (model && !spec.supportsModel) {
    return { ok: false, reason: 'model_unsupported', detail: harness }
  }

  const away = readAwaySpawn(body.away)
  if (away === null) return { ok: false, reason: 'bad_away', detail: String(body.away) }

  // The account comes LAST among the checks: it is the one that can name a 403, and a request with a
  // plain usage error should hear about that first. A non-string `account` is a usage error too.
  if (body.account !== undefined && typeof body.account !== 'string') return { ok: false, reason: 'unknown_account', detail: String(body.account) }
  const account = decideSpawnAccount({
    harness: harness as HarnessId,
    ...(text(body.account) ? { requested: text(body.account)! } : {}),
    agentCaller: body.callerVerified === true,
    context: accounts,
  })
  if (!account.ok) return { ok: false, reason: account.reason, detail: account.detail }

  const task = text(body.task)
  const taskId = text(body.taskId)
  const subtaskId = taskId ? text(body.subtaskId) : undefined
  const parentSessionId = text(body.parent)
  const prompt = text(body.prompt)
  const label = text(body.label)
  const role = label && hasRolePrefix(label) ? 'leader' as const : undefined
  const force = readForce(body.force)
  const handoff = parentSessionId && body.handoff === true
  const parentVerified = parentSessionId && body.parentVerified === true

  return {
    ok: true,
    plan: {
      harness,
      cwd,
      ...(task ? { task } : {}),
      ...(taskId ? { taskId } : {}),
      ...(subtaskId ? { subtaskId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(parentVerified ? { parentVerified: true as const } : {}),
      ...(handoff ? { handoff: true as const } : {}),
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(mode ? { mode } : {}),
      ...(label ? { label } : {}),
      ...(role ? { role } : {}),
      ...(away !== undefined ? { away } : {}),
      ...(force ? { force: true } : {}),
      ...(account.account ? { accountId: account.account.id } : {}),
      accountDecided: true,
      ...(body.callerVerified === true ? { callerVerified: true as const } : {}),
      attach: false,
    },
  }
}
