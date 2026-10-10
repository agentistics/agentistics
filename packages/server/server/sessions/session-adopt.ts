/**
 * session-adopt.ts — PURE. Taking a running session BACK into the registry when its record is gone.
 *
 * `reconcileSessions` already has a name for this row: `unregistered` — the backend is running
 * `agentop-<id>` and the registry holds nothing by that id. Until now that was where the story
 * ended, and the row showed up with no harness, no directory, no label and no task, filed under
 * `GONE_PROJECT_KEY` ("no registered directory"). Every verb the cockpit offers resolves against the
 * registry, so such a row cannot be attached, renamed, filed or killed: it is visible and inert.
 *
 * ## Why a row can be running and unregistered at all
 *
 * The registry serialises writes with an IN-PROCESS queue (`registry.ts`), which is exactly as much
 * as it can promise: `agentop` runs as several processes at once — the cockpit, the daemon, and
 * every one-shot `agentop session …` — and they all read-modify-write one file. A record added by a
 * short-lived CLI process can therefore be erased by a longer-lived one that had read the file just
 * before. Measured on this machine on 2026-08-15: a takeover (`agentop session attach` on a
 * conversation id) spawned `agentop-a2b569c123`, wrote its record, and the file that survived did
 * not contain it — while nine other sessions in the same registry were intact.
 *
 * The write path is being hardened separately, and that is worth doing. It is not sufficient on its
 * own: a lost write is invisible at the moment it happens, and the session it loses is the one the
 * user is sitting in. Adoption is what makes the loss recoverable rather than permanent, and it also
 * covers the cases no write-path fix can — a registry restored from a backup, a `--corrupt`
 * quarantine, a second agentop build with its own registry.
 *
 * ## What may be adopted, and what may never be invented
 *
 * The link is the harness's OWN record naming our tmux session (`tmux: "agentop-<id>:@w.%p"` in
 * `~/.claude/sessions/<pid>.json`), which `harness-sessions.ts` indexes as `byManagedId`. That is an
 * EXACT link, not a guess by harness-and-directory — the same distinction the rest of this module
 * family is built on.
 *
 * So a row is adopted only when such a record exists AND names a directory. Everything else is left
 * `unregistered`, deliberately: a row whose directory nobody can state would be adopted into the
 * registry as a permanent record with an invented `cwd`, and an invented cwd is what `repo-facts.ts`
 * exists to have stopped. A row left unregistered is visible and says what it is; a row adopted with
 * a made-up directory is filed under a project it was never in, and nothing on screen says so.
 *
 * The name is taken only when the harness says a PERSON chose it. A `derived` name (`aipe-46`) is
 * not a name — `harness-session-file.ts` measured 24 of 40 — and adopting one would write a label
 * the user never typed into a registry that outlives the process, where `pickTitle` would then have
 * to treat it as a deliberate choice forever.
 */

import type { HarnessId } from '@agentistics/core'
import { chosenName } from './harness-session-file'
import type { HarnessSessionFile } from './harness-session-file'
import type { ManagedSession } from './types'

/** The one status this module acts on. Kept as a literal so a caller cannot pass the wrong rows. */
export const ADOPTABLE_STATUS = 'unregistered' as const

export interface AdoptInput {
  /** The reconciled fleet. Only `unregistered` rows are even looked at. */
  rows: readonly { id: string; status: string }[]
  /**
   * The harness's own records keyed by OUR managed id — `HarnessSessionIndex.byManagedId`.
   *
   * Claude-only today, because it is the only harness that writes such a file. A harness that never
   * appears here is never adopted, which is the correct outcome and not a gap: without its own
   * record there is no exact link, and an inexact one is what this module refuses.
   */
  byManagedId: ReadonlyMap<string, HarnessSessionFile>
  /**
   * The registry as read this poll. A re-created row (a resume, a takeover) whose record was LOST has
   * a retired predecessor here carrying the SAME conversation — and with it the filing nobody else
   * can state again: the session that started it, its task/subtask, its note and label. Matched by
   * the exact conversation id only, never by directory. Optional so older callers keep working.
   */
  registry?: readonly ManagedSession[]
  /** The harness every record in `byManagedId` belongs to. */
  harness: HarnessId
  /** `createdAt` for the records written. The caller's clock, so a test can pin it. */
  nowIso: string
}

/**
 * The registry records that should be written to take running sessions back.
 *
 * Empty whenever there is nothing to do, which is the ordinary case — the caller can then skip the
 * write entirely rather than touching the registry on every poll.
 *
 * `createdAt` is the moment of ADOPTION, not of the session's birth, and that is honest rather than
 * lossy: the harness record carries `startedAt`, but it is the start of the process now holding the
 * conversation, which after a takeover or a resume is not when the work began. A field that would be
 * wrong in the interesting case is better left saying what it can defend.
 */
export function planAdoptions(input: AdoptInput): ManagedSession[] {
  const out: ManagedSession[] = []
  for (const row of input.rows) {
    if (row.status !== ADOPTABLE_STATUS) continue
    const file = input.byManagedId.get(row.id)
    // No exact link, or a link that names no directory: leave it visible and unregistered rather
    // than filing it under a directory nobody can state.
    if (!file?.cwd) continue
    const prior = file.sessionId ? newestOfConversation(input.registry ?? [], file.sessionId) : undefined
    // Only a name a PERSON chose (`chosenName` drops a derived one); else the predecessor's label.
    const label = chosenName(file) ?? prior?.label
    out.push({
      id: row.id,
      harness: input.harness,
      cwd: file.cwd,
      createdAt: input.nowIso,
      ...(label ? { label } : {}),
      ...(prior ? inherited(prior) : {}),
      // The exact conversation, straight from the harness's own record — the whole reason this row
      // is adoptable at all.
      ...(file.sessionId
        ? { conversationId: file.sessionId, conversationLink: 'assigned' as const, conversationLinkVia: 'harness-session-file' as const }
        : {}),
    })
  }
  return out
}

/** The newest registry row linked to `conversationId` — the predecessor a re-created row replaced. */
function newestOfConversation(registry: readonly ManagedSession[], conversationId: string): ManagedSession | undefined {
  let best: ManagedSession | undefined
  for (const r of registry) {
    if (r.conversationId !== conversationId) continue
    if (!best || r.createdAt > best.createdAt) best = r
  }
  return best
}

/**
 * What a re-created row carries over from its predecessor: the filing and the lineage, which were
 * facts at the predecessor's spawn and cannot be re-derived. Never its end, its heartbeat or its
 * directory (the harness record states the directory now).
 */
function inherited(p: ManagedSession): Partial<ManagedSession> {
  return {
    ...(p.note ? { note: p.note } : {}),
    ...(p.task ? { task: p.task } : {}),
    ...(p.taskId ? { taskId: p.taskId } : {}),
    ...(p.subtaskId ? { subtaskId: p.subtaskId } : {}),
    ...(p.attemptId ? { attemptId: p.attemptId } : {}),
    ...(p.parentSessionId ? { parentSessionId: p.parentSessionId } : {}),
    ...(p.parentConversationId ? { parentConversationId: p.parentConversationId } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    ...(p.repo ? { repo: p.repo } : {}),
  }
}
