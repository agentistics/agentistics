/**
 * rename.ts — carrying a rename typed in agentop through into the harness itself.
 *
 * The decision is the pure `rename-spec.ts`; this is the part that has to touch a backend. It exists
 * as ONE function rather than as code at each call site for the reason `task-reopen.ts` exists: the
 * CLI's `agentop session rename` and the cockpit's Rename verb are the same gesture, and the last
 * time this codebase implemented one gesture twice the two drifted and only one of them was right.
 *
 * The screen is RE-READ here rather than trusted from a poll, exactly as `promptSession` does, and
 * for exactly the same reason: a session that was idle five seconds ago may be sitting on a
 * permission prompt now, where the input line is a menu and a typed `/rename` is an answer to a
 * question nobody read.
 */

import type { HarnessId } from '@agentistics/core'
import type { CliStrings } from '../cli-i18n'
import { rulesFor } from './attention-rules'
import { planHarnessRename, renameSpecFor, type RenameSkipReason } from './rename-spec'
import type { SessionBackend } from './types'

/** What became of the harness half. The agentop label is written by the caller either way. */
export type HarnessRenameResult =
  /** The command was typed and submitted. */
  | { kind: 'sent' }
  /** It was never attempted, and this is why — one reason, one sentence. */
  | { kind: 'skipped'; reason: RenameSkipReason }
  /** It was attempted and the backend refused to type it. */
  | { kind: 'failed' }

/**
 * Is this rename a NO-OP? PURE. Renaming a session to the title it already carries must change
 * nothing — not the registry stamp and, above all, not the harness: each `/rename` typed into Claude
 * Code writes a command entry plus an acknowledgement into the conversation, so a repeat (a leader
 * spawned with `--role leader` that then calls `agentistics_session_role leader`, both computing the
 * same `[ LÍDER ] - X`, the second against a fleet row the 5 s poll had not refreshed yet) showed the
 * same rename twice. The comparison is on the TRIMMED label, against what agentop recorded.
 */
export function isRenameNoop(
  current: { label?: string; renameSent?: string } | undefined,
  requested: string,
): boolean {
  const wanted = requested.trim()
  // The label is written BEFORE the harness half, so a matching label alone proves nothing about the
  // harness: a skipped (not running / dialog open) or failed rename left it recorded, and a retry
  // must still reach the harness. Only a title the harness CONFIRMED is a no-op.
  return wanted !== '' && current?.renameSent !== undefined && current.renameSent.trim() === wanted
}

/** The registry patch that remembers what the harness half became. PURE. */
export function renameOutcomeRecord(result: HarnessRenameResult, title: string): { renameSent: string | null } {
  return { renameSent: result.kind === 'sent' ? title.trim() : null }
}

/** How much of the screen to read before typing. The same window `promptSession` uses. */
const CAPTURE_LINES = 60

/**
 * Rename a session inside its harness, if that is possible at this instant.
 *
 * NEVER throws and never reports a rename it did not perform: a backend that cannot be listed or a
 * capture that fails leaves the session's state unknown, and an unknown state is treated as a
 * blocking dialog — the one reading that cannot cause a keystroke to land somewhere it should not.
 *
 * The harness spec is checked FIRST, before the backend is touched at all. Five of the six harnesses
 * have no rename channel, and asking tmux to list sessions in order to discover that would spend a
 * process to learn something the table already knew.
 */
export async function renameInHarness(
  session: { id: string; harness: HarnessId },
  title: string,
  backend: SessionBackend,
): Promise<HarnessRenameResult> {
  if (!renameSpecFor(session.harness)) return { kind: 'skipped', reason: 'unsupported' }

  const live = (await backend.list().catch(() => [])).find(b => b.id === session.id)
  const running = live?.alive === true

  // A failed capture is not an empty screen. `promptSession` can treat it as one because its own
  // rules then simply fail to match; here the same shortcut would mean "no dialog", which is the
  // permissive answer. So a capture that throws is read as a dialog being open, and the rename is
  // skipped and said to be skipped.
  let dialogOpen = false
  if (running) {
    const frame = await backend.capture(session.id, CAPTURE_LINES).catch(() => null)
    if (frame === null) dialogOpen = true
    else {
      const rules = rulesFor(session.harness)
      dialogOpen = rules ? rules.approval.some(re => re.test(frame.join('\n'))) : false
    }
  }

  const plan = planHarnessRename({
    harness: session.harness,
    title,
    // Reached only with a registry entry in hand, which is what "agentop hosts this" means.
    managed: true,
    running,
    dialogOpen,
  })
  if (plan.kind === 'skip') return { kind: 'skipped', reason: plan.reason }

  return (await backend.sendText(session.id, plan.line).catch(() => false))
    ? { kind: 'sent' }
    : { kind: 'failed' }
}

/**
 * What to TELL the user about a rename, given what became of the harness half. PURE.
 *
 * One sentence per outcome, and deliberately not one sentence with a boolean in it: "renamed here
 * and inside the session" and "renamed in agentop only, because that session has a question open"
 * send someone to two different places, and a shared "renamed (partially)" sends them to neither.
 *
 * The agentop label is written on every path that reaches here, so every sentence is a SUCCESS
 * sentence with a different amount of reach — never an error. A rename that refused outright would
 * leave a `lost` row unnameable, and naming those rows is most of what the verb is for.
 */
export function renameMessage(result: HarnessRenameResult, harness: HarnessId, s: CliStrings): string {
  if (result.kind === 'sent') return s.sessRenamedBoth
  if (result.kind === 'failed') return s.sessRenamedLocalOnly(s.sessRenameWhyFailed)
  switch (result.reason) {
    case 'unsupported': return s.sessRenamedLocalOnly(s.sessRenameWhyUnsupported(harness))
    case 'external': return s.sessRenamedLocalOnly(s.sessRenameWhyExternal)
    case 'not-running': return s.sessRenamedLocalOnly(s.sessRenameWhyNotRunning)
    case 'dialog': return s.sessRenamedLocalOnly(s.sessRenameWhyDialog)
    case 'untypable': return s.sessRenamedLocalOnly(s.sessRenameWhyUntypable)
  }
}
