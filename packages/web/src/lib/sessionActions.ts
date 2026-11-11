/**
 * sessionActions.ts — PURE. Which single action a session row leads with, and which of its verbs
 * are watchable, decided from the fleet row alone.
 *
 * The eight verbs a session can take (`Answer its question`, `Send a prompt`, `Rename`, `Note`,
 * `Task`, `Open whole task`, `Finish task`, `Stop session`) live behind a menu — a row is not a
 * toolbar. What stays on the row is the ONE action that state is about, so a glance answers "what
 * would I do here". This module decides that one, and it decides it the same way the terminal
 * cockpit does: from the state, using the server's own already-localized verb labels, never
 * inventing a new rule the two surfaces could then disagree on.
 *
 * The one invariant this module carries in TYPES: **`Answer its question` is a HUMAN action.** A
 * `waiting-approval` session is blocked on a person, and nothing in this product may answer for
 * them — so `primaryAction` marks that one `human: true`, and the UI renders it as a person's
 * click, never a thing the page could do on its own.
 */

import type { FleetActionId, FleetRow, FleetVerb } from './fleet'

/** The kinds of lead action a row can carry. `watch` is not a verb — it opens the live terminal. */
export type PrimaryKind = 'approve' | 'prompt' | 'resume' | 'watch'

export interface PrimaryAction {
  kind: PrimaryKind
  /** The fleet verb this maps to, when it maps to one (`watch` opens the terminal and has none). */
  action?: FleetActionId
  /** The server's own verb, carrying its localized label and its `enabled` / `reason`. */
  verb?: FleetVerb
  /** True only for `approve`: a person answers; the UI must render it as a human click. */
  human: boolean
}

/**
 * The states that have a LIVE tmux pane worth reading — an assistant running or blocked on a
 * person. Mirrors `watchableFleetRows` in `terminalStream.ts`; kept here too so a row can decide
 * "does my primary action open a terminal" without importing the stream module.
 */
const WATCHABLE: ReadonlySet<FleetRow['state']> = new Set<FleetRow['state']>([
  'working',
  'waiting',
  'waiting-approval',
])

export function isWatchable(state: FleetRow['state']): boolean {
  return WATCHABLE.has(state)
}

/**
 * The single lead action for a row's state, or `null` when the state has none to surface (an
 * `unknown`/external row agentop never started, which nothing here can act on).
 *
 * The chosen verb is returned even when the server marked it DISABLED — the row still leads with the
 * action its state is about, and a disabled lead says why when pressed, exactly as the menu does.
 * `waiting-approval` therefore always leads with `approve`, so the person always sees the answer
 * prompt, whether or not this harness can be answered by number.
 */
export function primaryAction(row: FleetRow): PrimaryAction | null {
  const find = (a: FleetActionId): FleetVerb | undefined => row.verbs.find(v => v.action === a)
  switch (row.state) {
    case 'waiting-approval': {
      const v = find('approve')
      // A person answers. Marked human so the UI can never present it as automatable.
      if (v) return { kind: 'approve', action: 'approve', verb: v, human: true }
      return { kind: 'watch', human: false }
    }
    case 'idle':
    case 'waiting': {
      const v = find('prompt')
      if (v) return { kind: 'prompt', action: 'prompt', verb: v, human: false }
      return { kind: 'watch', human: false }
    }
    case 'working':
      // Busy — the useful thing is to watch it, which opens the terminal rather than acting.
      return { kind: 'watch', human: false }
    case 'exited':
    case 'lost':
    case 'closed': {
      const v = find('resume')
      if (v) return { kind: 'resume', action: 'resume', verb: v, human: false }
      return null
    }
    default:
      return null
  }
}
