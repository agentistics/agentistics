/**
 * relayedComposer.ts — PURE: may a central answer ANOTHER machine's session, and if not, why.
 *
 * On a central the session screen is `RelayedScreen`, a snapshot, and its own header told the
 * reader "answering the session is what the message field is for" — over a pane that drew no field.
 * The only way to answer was the `prompt` verb buried in the ⋯ menu, so the workspace read as one
 * where nothing could be done. The field is drawn now, and it is decided by the verb the MACHINE
 * already resolved for this row (`machineActions.ts` + the row's own state), never by the browser:
 *
 *   - no `prompt` verb at all: the machine has not granted its screen, so the central may not type
 *     into it (answering needs the question to be READABLE). No field; `RelayedScreen` already says
 *     where the switch lives.
 *   - `prompt` present and disabled: the field is replaced by the machine's own sentence.
 *   - `prompt` enabled: the field.
 */
import type { FleetRow } from './fleet'

export type RelayedComposerState =
  | { kind: 'absent' }
  | { kind: 'refused'; reason: string | null }
  | { kind: 'send' }

export function relayedComposerState(row: Pick<FleetRow, 'verbs'> | undefined): RelayedComposerState {
  const verb = row?.verbs?.find(v => v.action === 'prompt')
  if (!verb) return { kind: 'absent' }
  if (!verb.enabled) return { kind: 'refused', reason: verb.reason ?? null }
  return { kind: 'send' }
}
