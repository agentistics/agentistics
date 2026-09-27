/**
 * tools/contract.ts — the ONE contract every B3 tool, the policy and the loop are written against
 * (spec docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md §3, §4, D-T3).
 *
 * ## The shape, in one paragraph
 *
 * A tool is declared with `defineTool` (`./define.ts`). It states, for a given input, the
 * `PolicySubject`s it would touch — every path it would read or write, every shell command it would
 * run. The GATE (`./gate.ts` `runTool`) is the only caller that executes a tool: it asks the
 * `ToolPolicy` about those subjects, and only an `allow` mints a `PolicyGrant` (`./grant.ts`). A tool
 * built by `defineTool` refuses to run without a live grant whose subjects are exactly the ones it
 * derives from its input — so there is no path around the policy, not merely a convention.
 *
 * ## What never leaves the runtime in an event
 *
 * `ToolOutcome.modelText` (what the model reads back) and every input are CONVERSATION CONTENT.
 * They go to the content store (`ContentSink`) under the context-manager rules and are referenced
 * by `{sha256, bytes}`; an event carries only facts — a class, a count, a duration (D5).
 *
 * ## Frozen for the B3 fan-out
 *
 * Items B3.1–B3.8 are built in parallel against this file. A change to it is an integration
 * decision, not an item's: an item that needs one says so in its handback instead of editing here.
 */

import type { ToolKind } from '@agentistics/core'

// ── Errors: a CLASS, never a sentence to be regexed later (§1: keyword classification explained
// only 18,9 % of real tool errors) ───────────────────────────────────────────────────────────────

export const TOOL_ERROR_CLASSES = [
  /** the path / session / repository named does not exist */
  'not-found',
  /** the OS refused (EACCES, EPERM) */
  'permission',
  /** the policy refused — the model is told why in words (`ToolOutcome.modelText`) */
  'denied',
  /** the target is outside the session's workspace and the policy did not allow it */
  'outside-workspace',
  /** the input did not satisfy the tool's schema or its own rules */
  'invalid-input',
  /** a bounded wait expired (a shell yield is NOT this — a yield returns a handle) */
  'timeout',
  /** the run or the tool was cancelled / the process was killed */
  'killed',
  /** a process exited with a non-zero status */
  'nonzero',
  /** file.patch: the file changed on disk since it was read */
  'stale',
  /** file.patch: no tier matched the hunk's context */
  'no-match',
  /** file.patch: the context matched in more than one place */
  'ambiguous',
  /** a result or an input larger than the tool accepts */
  'too-large',
  /** the capability this tool needs is not available here (no git, no docker, no PTY…) */
  'unavailable',
  /** a defect in the tool itself; `detail` says what, the event carries only the class */
  'internal',
] as const
export type ToolErrorClass = (typeof TOOL_ERROR_CLASSES)[number]

export interface ToolError {
  class: ToolErrorClass
  /** A short sentence for the MODEL. Never journaled (it can quote a path or a line of output). */
  detail?: string
}

// ── What a tool asks the policy about ───────────────────────────────────────────────────────────

/**
 * One effect a call would have. Paths are ABSOLUTE and already resolved through symlinks
 * (`./paths.ts` `resolveToolPath`), so the policy judges the file that would really be touched.
 */
export type PolicySubject =
  | { action: 'read'; path: string }
  | {
      action: 'write'
      path: string
      op: 'create' | 'overwrite' | 'update' | 'delete' | 'rename-from' | 'rename-to'
    }
  /** The WHOLE command; the policy parses it into segments itself (D-T3 rule 2). */
  | { action: 'shell'; command: string; cwd: string; tty: boolean }
  /** Writing stdin to a running shell (`shell.write`, class `ask`). */
  | { action: 'shell-input'; shellId: string; bytes: number }
  /** Reading from or stopping a shell this run started (`shell.read` / `shell.stop`, class `auto`). */
  | { action: 'shell-control'; shellId: string; verb: 'read' | 'stop' }
  | { action: 'git-read'; repo: string; verb: 'status' | 'diff' | 'log' }
  /** The model's own checklist — touches nothing outside the run. */
  | { action: 'plan' }
  /** The model asking a person a question. */
  | { action: 'ask-user' }

/** The catalogue's default class for a tool (§3). The policy may override it by rule. */
export type ToolPermission = 'auto' | 'ask' | 'gated'

// ── Asking a person (`ask.user`, and the policy's `ask`) ────────────────────────────────────────

export interface PersonQuestionOption {
  label: string
  description?: string
}

export interface PersonQuestion {
  /** Stable for the call — `toolExecutionId` plus a suffix. */
  id: string
  /** `permission`: the policy asking whether a call may run. `question`: the model asking. */
  kind: 'permission' | 'question'
  text: string
  options: PersonQuestionOption[]
  /** `question` only: a free-text answer is accepted beside the options. */
  allowFreeText?: boolean
  /** `permission` only: what the call would touch, for the person to read before answering. */
  subjects?: readonly PolicySubject[]
}

export type PersonAnswer =
  | { answered: true; choice?: number; text?: string }
  /** Nobody answered. A permission question left unanswered is a DENIAL, never an approval. */
  | { answered: false; reason: 'cancelled' | 'timeout' | 'unavailable' }

/** Implemented by the host (the cockpit, the web, a test). The runtime never answers for a person. */
export interface PersonAsker {
  ask(q: PersonQuestion, signal?: AbortSignal): Promise<PersonAnswer>
}

// ── The policy ──────────────────────────────────────────────────────────────────────────────────

export interface ToolCallInfo {
  /** Minted by the gate (`tx_` prefix); every `tool.*` / `policy.*` event of the call names it. */
  toolExecutionId: string
  toolName: string
}

export interface PolicyRequest {
  call: ToolCallInfo
  kind: ToolKind
  permission: ToolPermission
  subjects: readonly PolicySubject[]
  workspaceRoot: string
  asker?: PersonAsker
  signal?: AbortSignal
}

export type PolicyVerdict =
  | {
      decision: 'allow'
      /** `auto`: the default class allowed it. `policy`: a rule did. `user`: a person did. */
      by: 'auto' | 'policy' | 'user'
      /** The rule id that decided, or `default:<class>`. Journaled (it is config, not content). */
      policy: string
    }
  | {
      decision: 'deny'
      by: 'policy' | 'user'
      policy: string
      /** A stable code (`policy.denied.outside-workspace`, …) — journaled. */
      code: string
      /** The refusal in WORDS for the model (hard rule: a refused call is reported in words). */
      sentence: string
    }

/**
 * Never throws and never hangs past `signal`: a policy that cannot decide DENIES — the pre-tool
 * gate is the one place that fails closed (D-T3 rule 5).
 */
export interface ToolPolicy {
  evaluate(req: PolicyRequest): Promise<PolicyVerdict>
}

// ── Where content and facts go ──────────────────────────────────────────────────────────────────

export interface ContentRef {
  sha256: string
  bytes: number
}

/** The content store (context manager §8.1). Never throws: a failed write is `null`, counted by the host. */
export interface ContentSink {
  put(text: string): Promise<ContentRef | null>
}

/** Facts a completed call states — counts and names of files, never their contents. */
export interface ToolFacts {
  filesTouched?: string[]
  linesAdded?: number
  linesRemoved?: number
  exitCode?: number
}

/**
 * Where the gate reports a call's life. Implemented by the loop's canonical emitter (B3.1); a test
 * passes a recorder. Every method resolves, never rejects (a journal that fails never fails a call).
 */
export interface ToolEventSink {
  requested(e: { call: ToolCallInfo; kind: ToolKind; occurredAt: string }): Promise<void>
  policyRequested(e: { call: ToolCallInfo; occurredAt: string }): Promise<void>
  policyDecided(e: { call: ToolCallInfo; verdict: PolicyVerdict; occurredAt: string }): Promise<void>
  completed(e: {
    call: ToolCallInfo
    facts: ToolFacts
    durationMs: number
    result: ContentRef | null
    occurredAt: string
  }): Promise<void>
  failed(e: {
    call: ToolCallInfo
    status: 'failed' | 'cancelled'
    errorClass: ToolErrorClass
    exitCode?: number
    durationMs: number
    result: ContentRef | null
    occurredAt: string
  }): Promise<void>
}

// ── Execution ───────────────────────────────────────────────────────────────────────────────────

export interface ToolContext {
  /** The session's workspace. Nothing is read or written outside it unless the policy allowed it. */
  workspaceRoot: string
  /** The run's current directory; relative paths resolve against it. */
  cwd: string
  signal: AbortSignal
  toolExecutionId: string
  sessionId?: string
  runId?: string
  agentId?: string
  /** Present when a person can be reached. Absent: `ask.user` fails `unavailable`, in words. */
  asker?: PersonAsker
  /** Injected clock for tests. */
  now(): Date
}

export interface ToolOutcome {
  ok: boolean
  /** What the model reads back as the tool result. Never journaled. */
  modelText: string
  /** Present exactly when `ok` is false. */
  error?: ToolError
  facts?: ToolFacts
  /** The tool's structured result (`ShellResult`, `FilePatchResult`, …) for a typed caller. */
  result?: unknown
}

/** A tool as the loop and the gate see it. Built only through `defineTool`. */
export interface Tool<I = unknown> {
  readonly name: string
  readonly description: string
  readonly kind: ToolKind
  readonly permission: ToolPermission
  /** JSON Schema of the input — sent to the provider as a `ProviderToolDecl`. */
  readonly inputSchema: Record<string, unknown>
  /** Validates the model's input. A string is the refusal sentence (→ `invalid-input`). */
  parse(input: unknown): I | string
  /** Every effect this input would have. Must be deterministic for a given input and context. */
  subjects(input: I, ctx: ToolContext): Promise<readonly PolicySubject[]>
  /** Runs only with a live grant for exactly `subjects(input, ctx)` — see `./define.ts`. */
  execute(input: I, ctx: ToolContext, grant: unknown): Promise<ToolOutcome>
}

// ── Sandbox (D-T5): the shell asks the launcher how to start a process ─────────────────────────

/** What would be spawned. `argv[0]` is the program; the launcher may wrap it (prlimit, docker run). */
export interface SpawnPlan {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

/**
 * The four states the owner decided must be said in plain words (D-T5): no sandbox · filesystem
 * only · full container · requested but unavailable.
 */
export type SandboxState = 'none' | 'filesystem-only' | 'container' | 'unavailable'

export interface SandboxLauncher {
  readonly state: SandboxState
  /** The state as a sentence, for a screen and for the model. EN; the host localises by `state`. */
  readonly sentence: string
  /** The plan to actually spawn, or a refusal in words (e.g. requested but unavailable). */
  wrap(plan: SpawnPlan): SpawnPlan | { refused: string }
}
