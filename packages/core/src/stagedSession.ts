/**
 * stagedSession.ts — a DORMANT session draft held on one subtask (or group) of a delivery.
 *
 * Board task t-918cc82233. Distinct from `sessionPresets.ts` in exactly the way that module's own
 * header states: a `SessionPreset` is machine-wide and task-agnostic (a personal "quick launch"
 * shelf with no board connection at all); a `StagedSessionDraft` is the opposite — it lives ON one
 * specific subtask or group of one specific delivery, and firing it FILES the resulting session
 * under that exact subtask/group automatically, with no manual filing step afterward. The two share
 * a shape (prompt + optional harness/model/effort/cwd) because they answer the same underlying
 * question — "what does a new session need to start" — but they are stored, validated and launched
 * through entirely separate paths; a preset never becomes a staged draft or vice versa.
 *
 * WHY THE FIELDS ARE ALL OPTIONAL EXCEPT `prompt`: unlike `SessionPreset` (whose `harness` is
 * required — it launches from a machine-wide shelf with no other context to fall back on), a staged
 * draft is composed IN PLACE on a subtask, ahead of time, possibly before the person has decided
 * which assistant or folder fits. `prompt` alone is required — a draft with nothing to say is not a
 * draft, the same reasoning `sessionPresets.ts` applies to `promptTemplate`. Firing a draft missing
 * `harness` or `cwd` falls back to the ordinary new-session wizard, pre-filled with whatever the
 * draft DOES have (see `NewSessionModal`'s `initialPreset`/`initialSubtaskId`) — the wizard's own
 * review step is that draft's consent gate, exactly as it is for a cwd-less `SessionPreset`.
 *
 * ATTACHMENTS are `TaskFile` ids, never a second file store: a pasted screenshot or an uploaded spec
 * becomes a real task file (the same mechanism a comment's pasted image uses — see
 * `web/src/lib/commentBody.ts`), and the draft holds only a REFERENCE to it. At fire time the
 * referenced files are materialized into the new session's own local attachment paths (the same
 * `/api/fleet/attach` store the ordinary composer uses) and prepended to the prompt — see
 * `composePromptWithPaths`, which mirrors `NewSessionModal`'s own `promptWithAttachments` exactly.
 *
 * A GROUP MEMBER can never hold this — see `task-attach.ts`'s `subtask_in_group` refusal, which this
 * module's callers must reuse rather than reimplement (a member can never receive a session of its
 * own, so a draft that could never be fired there is refused at the same point).
 */

import { absolutePresetPath } from './sessionPresets'

/** A saved-in-place session draft, held on `Subtask.stagedSession`. */
export interface StagedSessionDraft {
  /** The literal first message. Required — see this file's own header. */
  prompt: string
  /** `TaskFile` ids, in the order they were attached. Absent or empty means none. */
  attachmentIds?: string[]
  /** A bare `HarnessId`-shaped string — see `SessionPreset.harness`'s own note on why this is not
   *  typed against the closed `HarnessId` enum here. */
  harness?: string
  cwd?: string
  model?: string
  effort?: string
}

/** Past this, a compose panel is not something anyone reviews before firing — well above what a
 *  single message plausibly needs. */
export const MAX_STAGED_ATTACHMENTS = 12

function trimmedOrUndefined(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length > 0 ? t : undefined
}

/** What a compose form must have before it can be saved. Pure — no I/O, no closed-set checks
 *  against installed harnesses (that belongs to launch time, exactly as `sessionPresets.ts` draws
 *  the same line for its own draft). */
export type StagedSessionIssue = 'prompt' | 'cwd_relative'

export interface StagedSessionDraftInput {
  prompt: string
  attachmentIds?: string[]
  harness?: string
  cwd?: string
  model?: string
  effort?: string
}

export function validateStagedSessionDraft(
  input: StagedSessionDraftInput,
): { ok: true } | { ok: false; issue: StagedSessionIssue } {
  if (!trimmedOrUndefined(input.prompt)) return { ok: false, issue: 'prompt' }
  const cwd = trimmedOrUndefined(input.cwd)
  if (cwd && !absolutePresetPath(cwd)) return { ok: false, issue: 'cwd_relative' }
  return { ok: true }
}

/**
 * Read whatever is in the store into a draft we can trust, or `undefined` — never repairs a
 * half-read one. Total, never throws.
 *
 * Mirrors `normalizeSessionPresets`'s own rules: a missing `prompt` or a relative `cwd` drops the
 * WHOLE draft rather than salvaging the rest of it, because a half-read draft would fire a session
 * with a prompt or a folder nobody actually asked for.
 */
export function normalizeStagedSession(raw: unknown): StagedSessionDraft | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const prompt = trimmedOrUndefined(r.prompt)
  if (!prompt) return undefined
  const cwd = trimmedOrUndefined(r.cwd)
  if (cwd && !absolutePresetPath(cwd)) return undefined
  const harness = trimmedOrUndefined(r.harness)
  const model = trimmedOrUndefined(r.model)
  const effort = trimmedOrUndefined(r.effort)
  const attachmentIds = Array.isArray(r.attachmentIds)
    ? [...new Set(r.attachmentIds.filter((x): x is string => typeof x === 'string' && x.length > 0))]
      .slice(0, MAX_STAGED_ATTACHMENTS)
    : []
  return {
    prompt,
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(harness ? { harness } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/**
 * The first message as it will be TYPED once materialized attachment paths are known — the exact
 * convention `NewSessionModal`'s own `promptWithAttachments` uses: the paths first, each on its own
 * line, then the words. Duplicated rather than imported (that component owns its live composer's
 * own attachment list, which is a different lifecycle from a dormant draft's), the same call
 * `sessionPresets.ts` makes for `absolutePresetPath` versus `fleet-spawn.ts`'s own copy.
 */
export function composePromptWithPaths(paths: readonly string[], prompt: string): string {
  return [...paths, prompt].filter(x => x !== '').join('\n')
}
