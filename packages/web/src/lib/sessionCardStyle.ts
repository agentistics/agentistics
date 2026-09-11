/**
 * sessionCardStyle.ts — how ONE session's card shows its state — PURE.
 *
 * Three modes, chosen by the person and stored in `sessionsAsidePrefs.ts`:
 *  - `wash`    — the card's whole background is tinted by the state's color, for all seven
 *    states. Before this module existed only `working`/`waiting`/`waiting-approval` got a tint
 *    and everything else read as plain, which made "the background follows the status" describe
 *    two different things depending on which status a row happened to be in.
 *  - `neutral` — the background stays plain; the state WORD (in the row's meta line) takes the
 *    state's color instead.
 *  - `stripe`  — the background stays plain, plus a colored left edge — the same visual language
 *    `TaskBoard`'s cards already use for their own status stripe.
 *
 * `selected` always wins, in every mode: a selected row's neutral, full-height edge is a fact
 * about where the READER is, and it must never compete with a fact about the SESSION — the same
 * rule `SessionsAside.tsx` states for why selection is not colored orange.
 */

import type { SessionState } from '@agentistics/tui/control/session-fleet'
import type { AsideCardColor } from './sessionsAsidePrefs'

/** The color a state is said in, everywhere this feature draws one. `working` is its own token,
 *  never `success` (which reads teal on a terminal and sits within a hair of a harness color). */
export const STATE_COLOR: Record<SessionState, string> = {
  working: '#22c55e',
  waiting: 'var(--anthropic-orange)',
  'waiting-approval': 'var(--anthropic-orange)',
  exited: 'var(--text-tertiary)',
  lost: 'var(--accent-red)',
  closed: 'var(--text-tertiary)',
  unknown: 'var(--text-tertiary)',
}

/** How much of the state's color the `wash` background carries, in percent. The three states
 *  that already had a wash keep their exact figures; the four newly-covered ones take the same
 *  figure `working` always used. */
const WASH_PCT: Record<SessionState, number> = {
  working: 10, waiting: 12, 'waiting-approval': 12,
  exited: 10, lost: 10, closed: 10, unknown: 10,
}

export interface CardStyle {
  background: string
  /** The left-edge indicator (an inset box-shadow), or undefined for none. */
  edge?: string
  /** Set only in `neutral` mode — the meta line's state-word color. */
  stateTextColor?: string
}

const SELECTED: CardStyle = {
  background: 'var(--bg-elevated)',
  edge: 'inset 3px 0 0 var(--text-primary), inset 0 0 0 1px var(--border)',
}

export function sessionCardStyle(
  state: SessionState,
  mode: AsideCardColor,
  selected: boolean,
): CardStyle {
  if (selected) return SELECTED
  const color = STATE_COLOR[state]
  switch (mode) {
    case 'wash':
      return {
        background: `color-mix(in srgb, ${color} ${WASH_PCT[state]}%, transparent)`,
        edge: `inset 2px 0 0 ${color}`,
      }
    case 'stripe':
      return { background: 'transparent', edge: `inset 3px 0 0 ${color}` }
    case 'neutral':
      return { background: 'transparent', stateTextColor: color }
  }
}
