/**
 * completion/gate.ts — PURE: may this run end NOW? (TOOL.3, the completion gate; spec
 * docs/superpowers/specs/2026-09-28-runtime-planning-orchestration-artifacts.md §6.3.)
 *
 * The loop asks this module one question each time the model ends a turn without asking for a tool:
 * let the run end, or append ONE message stating the facts and give the model another turn. It is
 * POLICY in the loop, not a hook — nothing here runs a command, calls a tool, asks a person or edits
 * the plan. The loop folds facts in (`foldTurn`, `foldToolResult`) and reads a verdict out
 * (`evaluateCompletion`); what the verdict becomes (a message, an event) is the loop's.
 *
 * ## The three rules, in the order they are checked
 *
 * 1. **Open plan items** (`open-plan`). The run's own `task.plan` still names a step that is not
 *    `completed`: block, at most `maxContinuations` (K, default 2) times. With K spent the gate
 *    RELEASES with reason `forced-limit` — a model that will not finish is not held forever.
 * 2. **No progress** (`no-progress`). An EARLY release, before K is spent: the open set has not
 *    changed and no tool call produced a result this run had not already seen, over `noProgressTurns`
 *    (N, default 3) consecutive model turns. Blocking a model that is going in circles only buys more
 *    circles. When the K budget is ALSO spent the reason is `forced-limit` — the hard cap is named
 *    first, so a turn with K spent always reads the same way (acceptance §6.3 #1).
 * 3. **Verification after edit** (`verify-after-edit`, OPT-IN, default OFF). After the last
 *    successful `file.patch` / `file.write` there must be a shell call that exited 0; otherwise ONE
 *    continuation. Checked only when Rule 1 has nothing to say (no open item), so a turn is blocked
 *    for one reason and its message states one set of facts. A second end-turn still unverified
 *    releases with `forced-limit` (that rule's budget is one).
 *
 * A run whose plan is empty (no `task.plan` call, or a plan cleared to nothing) is never blocked by
 * Rule 1 (acceptance §6.3 #3), and a gate that never blocked releases silently: `quiet` tells the loop
 * there is nothing to report, so a run that never engaged the gate emits no completion event at all.
 *
 * ## What the gate proves, and what it cannot
 *
 * It checks STATE, not prose: it cannot tell whether the final message claims success. Rule 3 proves a
 * command exited 0, not that it tested the right thing. A shell call left running in the background
 * (a handle, no exit code yet) is not a pass until a later call reports its exit.
 */

import { sha256Hex } from '@agentistics/core'

export const DEFAULT_MAX_CONTINUATIONS = 2
export const DEFAULT_NO_PROGRESS_TURNS = 3

/** The tools whose successful call counts as an EDIT for Rule 3 (spec §6.3). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['file.patch', 'file.write'])

export type CompletionRule = 'open-plan' | 'verify-after-edit'

/**
 * Why the gate let the run end.
 * - `satisfied` — it had blocked earlier and nothing is open now.
 * - `forced-limit` — the rule's continuation budget is spent (K for Rule 1, one for Rule 3).
 * - `no-progress` — Rule 2.
 * - `run-budget` — the run has no model turn left to spend on a continuation; blocking would turn a
 *   finished answer into a `max-turns` stop.
 */
export type CompletionReleaseReason = 'satisfied' | 'forced-limit' | 'no-progress' | 'run-budget'

export interface CompletionSettings {
  /** K. */
  maxContinuations: number
  /** N. */
  noProgressTurns: number
  /** Rule 3; default false. */
  requireVerificationAfterEdit: boolean
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  maxContinuations: DEFAULT_MAX_CONTINUATIONS,
  noProgressTurns: DEFAULT_NO_PROGRESS_TURNS,
  requireVerificationAfterEdit: false,
}

/** One step of the model's plan, as `task.plan` holds it (structurally; no import of the tool). */
export interface CompletionPlanStep {
  readonly text: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

export interface CompletionState {
  /** Rule 1 continuations appended so far. */
  readonly forced: number
  /** Rule 3 continuations appended so far (0 or 1). */
  readonly verifyForced: number
  /** Digest of the open set at the end of the last folded turn; `null` = no turn folded yet. */
  readonly openKey: string | null
  /** Consecutive turns with the open set unchanged and no new tool result. */
  readonly stagnant: number
  /** Result digests seen this run — bounded by the run's own tool-call budget. */
  readonly seenResults: ReadonlySet<string>
  /** A new result was folded during the current turn. */
  readonly turnHadNewResult: boolean
  /** A successful edit happened and no shell call exited 0 after it. */
  readonly editUnverified: boolean
  /** The gate blocked at least once this run. */
  readonly engaged: boolean
}

export const emptyCompletionState: CompletionState = {
  forced: 0,
  verifyForced: 0,
  openKey: null,
  stagnant: 0,
  seenResults: new Set(),
  turnHadNewResult: false,
  editUnverified: false,
  engaged: false,
}

export function openItems(plan: readonly CompletionPlanStep[]): CompletionPlanStep[] {
  return plan.filter(s => s.status !== 'completed')
}

function openKeyOf(plan: readonly CompletionPlanStep[]): string {
  return sha256Hex(JSON.stringify(openItems(plan).map(s => [s.status, s.text])))
}

/** The facts of one call that reached the gate. `exitCode` only when the tool reported one. */
export interface CompletionToolFact {
  toolName: string
  ok: boolean
  /** Digest of what the model read back (`resultDigest` in loop/repeat-guard.ts). */
  resultDigest: string
  exitCode?: number
  /** The tool's kind (`shell` counts as a verification when it exited 0). */
  kind: string
}

export function foldToolResult(state: CompletionState, fact: CompletionToolFact): CompletionState {
  const isNew = !state.seenResults.has(fact.resultDigest)
  const seenResults = isNew ? new Set([...state.seenResults, fact.resultDigest]) : state.seenResults
  let editUnverified = state.editUnverified
  if (fact.ok && EDIT_TOOLS.has(fact.toolName)) editUnverified = true
  else if (fact.kind === 'shell' && fact.exitCode === 0) editUnverified = false
  return { ...state, seenResults, turnHadNewResult: state.turnHadNewResult || isNew, editUnverified }
}

/** End of one model turn (with or without tool calls): update the progress window. */
export function foldTurn(state: CompletionState, plan: readonly CompletionPlanStep[]): CompletionState {
  const key = openKeyOf(plan)
  const moved = state.openKey === null ? openItems(plan).length > 0 : key !== state.openKey
  const progressed = moved || state.turnHadNewResult
  return { ...state, openKey: key, stagnant: progressed ? 0 : state.stagnant + 1, turnHadNewResult: false }
}

export type CompletionVerdict =
  | {
      allow: false
      rule: CompletionRule
      /** 1-based: the continuation this block appends, counted per rule. */
      attempt: number
      openItems: number
      /** The one message to append — facts only. */
      message: string
      reasons: string[]
    }
  | {
      allow: true
      /** `null` = the gate never engaged and nothing is open: nothing to report. */
      reason: CompletionReleaseReason | null
      quiet: boolean
      openItems: number
      reasons: string[]
    }

export interface CompletionInput {
  state: CompletionState
  plan: readonly CompletionPlanStep[]
  settings: CompletionSettings
  /** Whether the run can still spend one more model turn. */
  turnAvailable: boolean
}

function marker(status: CompletionPlanStep['status']): string {
  return status === 'in_progress' ? '~' : ' '
}

function planMessage(open: readonly CompletionPlanStep[], attempt: number, k: number): string {
  const n = open.length
  const lines = open.map((s, i) => `${i + 1}. [${marker(s.status)}] ${s.text}`)
  return [
    `Completion check (${attempt} of ${k}): ${n} plan item${n === 1 ? ' is' : 's are'} still open in task.plan:`,
    ...lines,
    'The run was not ended while these are open.',
  ].join('\n')
}

const VERIFY_MESSAGE =
  'Completion check: a file was changed with file.patch or file.write, and no shell command has ' +
  'exited 0 since that change. The run was not ended while that is so.'

/**
 * The verdict for a turn that ended with no tool call. Call `foldTurn` for that turn FIRST, so the
 * progress window includes it.
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const { state, plan, settings } = input
  const open = openItems(plan)
  const n = open.length
  const release = (reason: CompletionReleaseReason | null, reasons: string[]): CompletionVerdict => ({
    allow: true, reason, quiet: reason === null, openItems: n, reasons,
  })

  const rule1 = n > 0
  const rule3 = !rule1 && settings.requireVerificationAfterEdit && state.editUnverified
  if (!rule1 && !rule3) return release(state.engaged ? 'satisfied' : null, [])

  const rule: CompletionRule = rule1 ? 'open-plan' : 'verify-after-edit'
  const spent = rule1 ? state.forced >= settings.maxContinuations : state.verifyForced >= 1
  if (spent) return release('forced-limit', [`${rule}: continuation budget spent`])
  if (state.stagnant >= settings.noProgressTurns) {
    return release('no-progress', [`${rule}: no progress over ${state.stagnant} consecutive turns`])
  }
  if (!input.turnAvailable) return release('run-budget', [`${rule}: no model turn left for a continuation`])

  const attempt = rule1 ? state.forced + 1 : state.verifyForced + 1
  return {
    allow: false,
    rule,
    attempt,
    openItems: n,
    message: rule1 ? planMessage(open, attempt, settings.maxContinuations) : VERIFY_MESSAGE,
    reasons: [rule1 ? `open-plan: ${n} open` : 'verify-after-edit: edit not verified'],
  }
}

/** The state after the loop appended the continuation a blocking verdict asked for. */
export function foldBlocked(state: CompletionState, rule: CompletionRule): CompletionState {
  return rule === 'open-plan'
    ? { ...state, forced: state.forced + 1, engaged: true }
    : { ...state, verifyForced: state.verifyForced + 1, engaged: true }
}

export function completionReleaseSentence(reason: CompletionReleaseReason, openCount: number): string {
  const items = `${openCount} plan item${openCount === 1 ? '' : 's'}`
  switch (reason) {
    case 'satisfied': return 'Completion gate: nothing is open any more.'
    case 'forced-limit': return openCount > 0
      ? `Completion gate released: ${items} still open after the allowed continuations.`
      : 'Completion gate released: the edit was still not followed by a passing command after the allowed continuation.'
    case 'no-progress': return openCount > 0
      ? `Completion gate released: ${items} still open and nothing changed over the last turns.`
      : 'Completion gate released: the edit is still unverified and nothing changed over the last turns.'
    case 'run-budget': return 'Completion gate released: the run has no model turn left for a continuation.'
  }
}
