/**
 * input-focus.ts — PURE: is the harness's INPUT BOX the thing that will receive a keystroke?
 *
 * A prompt is delivered by typing it into the pane and pressing Enter. That assumes the input box
 * has the focus, and on claude it does not always. With background agents running, claude draws a
 * list of them UNDER its footer (`● main / ◯ general-purpose …`), and one ↓ in the terminal moves
 * the focus into that list — the footer then reads `Enter to view tasks`. From there:
 *
 *   - the typed text reaches no input at all (it was lost, not queued), and
 *   - the Enter OPENS the highlighted agent's detail view (`Shell details … Esc/Enter/Space to
 *     close`) instead of submitting anything.
 *
 * Measured on claude 2.1.284, 2026-09-29, on a probe session: `/api/fleet/act prompt` answered
 * `enviado`, the text was in no transcript, and the pane showed the shell-details view. That is the
 * report this module exists for — two messages sent from the web sat at "delivered — not read yet"
 * forever on a session with background agents, and only arrived when retyped. The submit check
 * accepted it because the Enter DID move the frame; it moved it to the wrong screen.
 *
 * What was measured to bring the focus back: Esc, from the list AND from the detail view, returns
 * it to the input box — and it does NOT interrupt a running turn from there (tested mid-turn: the
 * reply kept streaming). ↑ is not a way back: in the input box it opens the prompt history.
 *
 * WHERE THE MARKERS ARE READ: the list marker is claude's FOOTER — the first non-blank line after the
 * input box's LAST horizontal rule — and the detail view's is in its last few lines. Neither is read
 * anywhere else, for the reason `attention.ts` records: this product is developed with this product,
 * and a session editing this very file has these strings on screen as source code.
 */

export type InputFocus = 'input' | 'tasks' | 'overlay'

/** claude's own horizontal rule — the input box is drawn between two of them. A titled rule
 *  (`─── History 4/4 ───`) is still a rule. */
const RULE = /^\s*─{3,}.*─{3,}\s*$/

/** The background-agents list has the focus. */
const TASKS_FOCUSED = /Enter to view tasks/
/** An agent's detail view is open over the conversation. */
const OVERLAY_OPEN = /Esc\/Enter\/Space to close|← to go back/

/** How many trailing non-blank lines count as the detail view's footer. */
export const OVERLAY_FOOTER_LINES = 3

export function inputFocusOf(frame: readonly string[]): InputFocus {
  const lines = frame.filter(l => l.trim() !== '')
  const tail = lines.slice(-OVERLAY_FOOTER_LINES).join('\n')
  if (OVERLAY_OPEN.test(tail)) return 'overlay'
  let lastRule = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i]!)) { lastRule = i; break }
  }
  const footer = lastRule >= 0 ? lines[lastRule + 1] ?? '' : ''
  if (TASKS_FOCUSED.test(footer)) return 'tasks'
  return 'input'
}

/** How many Esc presses a send may spend bringing the focus back before it refuses. */
export const FOCUS_ATTEMPTS = 3
