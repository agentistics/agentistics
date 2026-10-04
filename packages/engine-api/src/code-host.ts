/**
 * code-host.ts — the contract between the control center's `code` tab (public, `@agentistics/tui`) and the
 * ENGINE that drives a native runtime session for it (`engine.codeHost`). TYPES ONLY (engine-api 1.8, ES.6h).
 *
 * The tab folds the `CodeEvent`s below with a pure reducer and decides nothing about a session on its own:
 * every refusal arrives as a sentence the engine already localized, every permission option is the policy's
 * own, in the policy's own order. The engine TRANSLATES the runtime's hub frames into these events; nothing
 * here imports the runtime. Every member is OPTIONAL on `CodeHost` (engine.ts), so an engine built against
 * 1.7 (an opaque handle) still loads and the tab then says the machine cannot drive a session.
 *
 * Spec: docs/superpowers/specs/2026-09-28-harness-tui-design.md (D-TUI-3, D-TUI-6, D-TUI-7, D-TUI-9; CD-01…CD-12, NW-01, NW-06).
 */

/** A value or a refusal in words. The sentence is already localized by the host. */
export type CodeResult<T extends object = object> = ({ ok: true } & T) | { ok: false; sentence: string }

/** Whether this machine can drive a native session at all, and why not. */
export type CodeAvailability = { ok: true } | { ok: false; sentence: string }

/**
 * The model a new session would use, and where that answer came from. The provider layer has no
 * default model and guessing one is a billing decision, so a model only ever comes from somewhere
 * the person put it: the `--model` flag, or the model their most recent native session ran.
 */
export interface CodeModelChoice {
  id: string
  source: 'flag' | 'last-session'
}

export interface CodeDefaults {
  /** `null`: nothing names a model — the review step refuses to start and says how to give one. */
  model: CodeModelChoice | null
  /** Present exactly when `model` is null: how to give one, in words. */
  noModelSentence?: string
  /** Where the session would work, and the workspace (git toplevel or the folder) it may touch. */
  cwd: string
  workspaceRoot: string
  /** The provider the session is driven through (`anthropic` for now). */
  provider: string
}

/** One task the wizard can file a session under (open tasks only — a done task takes no new work). */
export interface CodeTaskOption {
  id: string
  /** The short handle the board prints (`t-e479`). */
  ref: string
  title: string
  /** The board's own status id and its label, as the board names it. */
  status: string
  statusLabel: string
}

export interface CodeStartInput {
  /** REQUIRED (D-TUI-6): a session the TUI starts is always filed under a task. */
  taskId: string
  model: string
  /** NW-03: the keyed provider to run it on (`anthropic`, `openrouter`, `ollama`, …); absent = the host's default. */
  provider?: string
  cwd: string
  /** Sent as the first prompt right after the session starts. */
  firstMessage?: string
}

/**
 * CD-15: the permission mode, by the runtime's own profile ids (B4.7, `policy/profiles.ts`). The words the tab
 * prints map onto them exactly: `ask` = `default` (everything not allowlisted asks first), `edits` =
 * `accept-edits` (file writes inside the workspace are allowed; the shell still asks), `plan` = `plan` (writes
 * and mutating shell commands are refused).
 */
export type CodeModeId = 'default' | 'accept-edits' | 'plan'

/** CD-16: one "allow for this session" answer the policy is holding, in the question's own words. */
export interface CodeSessionRule {
  label: string
  /** When the person gave it (ISO). */
  at: string
}

/**
 * CD-13: what the policy decided about one call, read off the runtime's own `policy.approved` /
 * `policy.denied` events — never inferred from the tool's outcome.
 */
export interface CodePolicyDecision {
  decision: 'allowed' | 'denied'
  /** `user`: a person answered (or a session rule they gave matched); `policy`: rules/defaults decided. */
  by: 'user' | 'policy'
  /** The deciding layer or rule, verbatim from the verdict. */
  rule: string
  /** A question was put to a person for this call. */
  asked: boolean
  /** The denial's stable code, when denied (`policy.denied.by-person`, …). */
  code?: string
}

/** CD-18: one earlier prompt on this machine. */
export interface CodePromptRecord {
  text: string
  /** When it was sent (ISO). */
  at: string
  sessionId: string
}

/** HM-04 / SS-01: one native session the home's resume card and the sessions fleet can show. */
export interface CodeRecentSession {
  sessionId: string
  title: string
  /** The task it is filed under, by its short handle and title, when it is filed. */
  task?: string
  /** Last activity (ISO). */
  updatedAt: string
  status: string
  model: string
  /** Where it works (SS-01: the fleet row's folder). */
  cwd?: string
  /** Its latest run is running right now (SS-02: "working"). */
  running?: boolean
  /** SS-06: the policy question it is waiting on right now (answered through `answer`). */
  ask?: { questionId: string; prompt: string; options: readonly string[] }
}

/** What the header (CD-01) says about the open session. */
export interface CodeSessionFacts {
  sessionId: string
  /** First 4 hex of the id after `ses_` — the handle the tab prints. */
  shortId: string
  title: string
  /** `null`: not filed under any task (a session resumed from outside the TUI). */
  task: { id: string; ref: string; title: string } | null
  subtask?: { id: string; title: string }
  cwd: string
  workspaceRoot: string
  model: string
  provider: string
  /**
   * The permission mode, named. A host that speaks CD-15 says a `CodeModeId`; one whose policy has no named
   * modes says `ask` — what the policy does: everything not allowlisted asks first (the tab reads it as
   * `default`). Kept a `string` so a 1.8 engine that says `ask` still satisfies it.
   */
  mode: CodeModeId | (string & {})
}

/** How the tab was opened by `agentop code …` — carried into the tab on its first mount. */
export interface CodeLaunch {
  /** `agentop code "<prompt>"`: the wizard opens at the task step with this as the first message. */
  prompt?: string
  /** `agentop code --resume <id>`: open that session instead of starting a new one. */
  resume?: string
  /** TK-06: the wizard opens with this board task already chosen (straight to the review). */
  taskId?: string
}

// ── the conversation, as events ───────────────────────────────────────────────────────────────

export type CodeDiffOp = ' ' | '+' | '-'

export interface CodeDiffLine {
  op: CodeDiffOp
  text: string
}

export interface CodeDiffHunk {
  /** The `@@ …` context line, when the patch named one. */
  header?: string
  lines: CodeDiffLine[]
}

export interface CodeDiffFile {
  path: string
  op: 'add' | 'update' | 'delete' | 'overwrite'
  moveTo?: string
  added: number
  removed: number
  hunks: CodeDiffHunk[]
}

/** The change a write/patch call makes, read from the call's OWN input — never reconstructed. */
export interface CodeDiff {
  files: CodeDiffFile[]
}

export type CodeToolState = 'running' | 'asking' | 'done' | 'failed' | 'denied'

/** One tool call (CD-03), upserted by `id` as it moves through its life. */
export interface CodeToolCall {
  /** The runtime's `toolExecutionId`. */
  id: string
  /** The tool's own name (`file.patch`). */
  name: string
  /** A short verb for the row (`patch`, `read`, `shell`, `grep`…). */
  verb: string
  /** What it acts on: a path, a pattern, a command summary. `''` when the call names none. */
  target: string
  state: CodeToolState
  durationMs?: number
  /** A short result for the row (`214 lines`, `exit 0`, `3 matches`). Absent: nothing to add. */
  result?: string
  linesAdded?: number
  linesRemoved?: number
  files?: string[]
  /** Why it failed or was refused, in WORDS (CD-03: "failures in words"). */
  failure?: string
  /** For a write/patch: the change, for the inline diff (CD-04). */
  diff?: CodeDiff
  /** When the call was requested (`tool.requested.occurredAt`, ISO). */
  requestedAt?: string
  /** When it finished — completed, failed or denied (that event's `occurredAt`, ISO). */
  endedAt?: string
  /** CD-13: the policy's decision on this call. Absent until the policy decided (or a host that does not say). */
  policy?: CodePolicyDecision
  /**
   * CD-14: the span a person was asked about this call — the question opening and closing, as the host
   * observed it. Absent: nobody was asked. `closedAt` absent: still waiting.
   */
  waited?: { openedAt: string; closedAt?: string }
  /**
   * CD-10: what the tool returned, as text. `lines` is capped (the host keeps the head); `total` is the true
   * line count. Absent: the call returned nothing readable (or the host does not send it).
   */
  output?: { lines: string[]; total: number }
}

/** A question the session is waiting on (CD-07). Options are the POLICY's, in its order. */
export interface CodeAsk {
  id: string
  kind: 'permission' | 'question'
  /** The call it is about, when it is a permission question. */
  toolId?: string
  toolName?: string
  /** The policy's first line (`Allow this command to run?`). */
  title: string
  /** Why it asks — the policy's own reasons, one per line. */
  why: string[]
  /** A shell call: the whole command and where it would run. */
  command?: { command: string; cwd: string }
  /** What the call would touch, for a non-shell call. */
  paths?: { path: string; op: string }[]
  /** A write/patch call: the change it would make (CD-07 card + CD-09 full diff). */
  diff?: CodeDiff
  /** `true` only when the runtime really saves a checkpoint before this call writes. */
  checkpoint: boolean
  options: { label: string; description?: string }[]
  /**
   * The index of the policy's own "Deny" option — what `esc` answers (D-TUI-7: esc is a DENY).
   * `null` when the question has no such option; `esc` then dismisses it, which the policy also
   * reads as a denial.
   */
  denyIndex: number | null
  /** A free-text answer is accepted beside the options (a model's question, not a permission). */
  allowFreeText?: boolean
}

/** One priced model response (from `model.completed`). A counter the source did not report is ABSENT. */
export interface CodeUsage {
  runId?: string
  model: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /** API-equivalent, USD. Absent: not priced. */
  costUSD?: number
  /** A gauge of this call's context, never a sum. */
  contextTokens?: number
  contextWindow?: number
  /** The provider attempt this response is (`attemptId` of `model.invoked` / `model.completed`). */
  attemptId?: string
  /** When the call was sent (ISO). Absent: the invoke was not seen. */
  startedAt?: string
  /** When it completed (ISO). */
  endedAt?: string
  /** Time to first token, measured by the host on one clock. ABSENT when no text streamed — never a 0. */
  ttftMs?: number
  /** The provider's own latency for the call (`model.completed.latencyMs`). */
  latencyMs?: number
  /** Why the model stopped, normalised (`end_turn`, `tool_use`, `max_tokens`, …). */
  stopReason?: string
  /** CD-13: each counter at its own rate. Present exactly when `costUSD` is. */
  costs?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** A turn of a RESUMED session, read from its stored window (text + the tools it called). */
export interface CodeHistoryTurn {
  role: 'user' | 'assistant'
  text: string
  tools: { name: string; verb: string; target: string }[]
}

export interface CodePlanItem {
  text: string
  status: 'done' | 'active' | 'todo'
}

export type CodeEvent =
  | { kind: 'history'; turns: CodeHistoryTurn[] }
  /** The person's prompt, echoed when the host accepted it into the session's queue. */
  | { kind: 'user'; text: string; at: string }
  | { kind: 'run-started'; runId: string; at: string }
  /** A piece of the model's answer as it streams in (CD-02). */
  | { kind: 'delta'; runId?: string; text: string }
  | { kind: 'tool'; call: CodeToolCall }
  | { kind: 'ask'; ask: CodeAsk }
  | { kind: 'ask-closed'; id: string; outcome: 'answered' | 'cancelled' | 'timeout'; choiceLabel?: string }
  | { kind: 'usage'; usage: CodeUsage }
  | { kind: 'plan'; items: CodePlanItem[] }
  /** CD-15: the session moved to another permission mode. `dropped`: session rules it cost. */
  | { kind: 'mode'; mode: CodeModeId; direction: 'stricter' | 'looser' | 'same'; dropped: number }
  /** CD-16: the session rules now in force — the WHOLE list, replacing the previous one. */
  | { kind: 'rules'; rules: CodeSessionRule[] }
  | { kind: 'run-ended'; runId: string; status: 'completed' | 'failed' | 'abandoned' | 'lost'; sentence: string; at: string }
  /** Something the person should read: an input refusal, a gap in the stream, a repair. */
  | { kind: 'notice'; tone: 'info' | 'warn' | 'error'; sentence: string }
  /** The session is over for this surface. Nothing follows. */
  | { kind: 'closed'; sentence: string }

/**
 * Drives native sessions for the `code` tab. Implemented by the ENGINE (`engine.codeHost`); a test or
 * the preview passes a fake. Every method is TOTAL — a failure comes back as `{ok:false, sentence}`,
 * never a throw.
 */
export interface CodeHostPort {
  /** What `agentop code --model/--cwd` named, handed over BEFORE the first `defaults()`; absent: the host's own defaults. */
  configure?(o: { model?: string; cwd?: string }): void
  availability(): CodeAvailability
  defaults(): Promise<CodeDefaults>
  /** Open tasks on this machine's board, most relevant first. */
  openTasks(): Promise<CodeResult<{ tasks: CodeTaskOption[] }>>
  /** NW-01's "new task…": created as `todo`. */
  createTask(title: string): Promise<CodeResult<{ task: CodeTaskOption }>>
  /** NW-06: create the session, take its lease, FILE it under the task, and (optionally) send the
   *  first message. The session only exists on the board once this answers `ok`. */
  start(input: CodeStartInput): Promise<CodeResult<{ facts: CodeSessionFacts; sentence: string }>>
  /** Open a stored session (repairing an interrupted run first), emitting a `history` event. */
  resume(sessionId: string): Promise<CodeResult<{ facts: CodeSessionFacts; sentence: string }>>
  /** Every event of `sessionId` from now on, in order. Returns the unsubscribe. */
  subscribe(sessionId: string, listener: (e: CodeEvent) => void): () => void
  /** Queue a prompt. `ok` means QUEUED (the run may still be refused later, with a notice). */
  submit(sessionId: string, text: string): CodeResult<{ sentence?: string }>
  /**
   * Answer an open question with the option at `choice` (0-based), exactly as the person picked.
   * CD-08: `reason`, with the policy's Deny option, is the person's reason — handed to the agent with the
   * denial (never journaled). A host that does not read it denies without it.
   */
  answer(sessionId: string, questionId: string, choice: number, reason?: string): CodeResult<{ sentence: string }>
  /** Cancel the run in progress. */
  cancel(sessionId: string): CodeResult<{ sentence: string }>
  /** Stop driving the session here: release its lease. The session stays on disk, resumable. */
  end(sessionId: string): Promise<void>
  /**
   * CD-15 (optional): move the session to the next permission mode — `default` → `accept-edits` → `plan` →
   * `default` — and emit `mode` (and `rules` when the switch dropped any). Absent: the tab names the mode and
   * says it cannot be changed here.
   */
  cycleMode?(sessionId: string): CodeResult<{ mode: CodeModeId; sentence: string }>
  /** HM-04 / SS-01 (optional): this machine's most recent native sessions, newest activity first. Absent: none listed. */
  recentSessions?(limit: number): Promise<CodeResult<{ sessions: CodeRecentSession[] }>>
  /** SS-08 (optional): rename a native session (its title in the engine's store). Absent: the rename is refused in words. */
  rename?(sessionId: string, title: string): Promise<CodeResult<{ sentence: string }>>
  /** CD-18 (optional): this machine's earlier prompts, newest first, identical texts once. Absent: no history. */
  promptHistory?(): Promise<CodeResult<{ prompts: CodePromptRecord[] }>>
}
