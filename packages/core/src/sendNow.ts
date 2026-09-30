/**
 * sendNow.ts — PURE: what "send now" on a queued message does, how long each step is given, and
 * what the person is told while it happens. Shared by the server (which drives the pane) and the web
 * (which draws the progress bar), so the caption can never describe a step the server is not in.
 *
 * WHY THIS IS TWO STEPS, measured against Claude Code 2.1.285 on 2026-09-29 (probe session, tmux):
 *
 *   1. GENTLE — claude's own `ctrl+x ctrl+s` ("chat:sendNow"). Since the changelog entry "Changed
 *      send now … to move running tools to the background instead of cancelling the turn" it no
 *      longer interrupts anything: it hands the queued message to a scheduler that delivers it at a
 *      SAFE point — a streaming reply is cut at once (measured: delivered in under 2 s), a movable
 *      tool is moved to the background (measured: same). But the scheduler WAITS whenever it has no
 *      safe point: an API retry back-off (no request in flight), compaction, an open dialog, or a
 *      tool it cannot move. Read out of the binary's own decision table (`wait not_sampling`,
 *      `wait compacting`, `wait held_by_dialog`, `wait unmovable_grace`). Over a day of real
 *      transcripts on the reporting machine, queued messages sat 4–8 minutes before being absorbed.
 *      agentop sent the two keys and answered "sent" without looking, so the button said the message
 *      went while it was still waiting — which is the report this module exists for.
 *
 *   2. FIRM — `Esc`. Measured on the same build: with a message queued, Esc interrupts the turn and
 *      claude submits the queue IMMEDIATELY as the next turn. It costs the running turn (a
 *      foreground tool is cancelled), which is why it is the second step and never the first, and
 *      why the result sentence says so when it was needed.
 *
 * Between and after the steps the SCREEN is the judge: the queue is drawn above the input box with
 * the send-now hint under it, and the empty input box says "Press up to edit queued messages". When
 * neither is on screen, the queue has drained.
 *
 * PER HARNESS: only Claude Code has a harness-side queue with a send-now key that agentop has
 * measured. Every other harness gets no button (`sendNowShown` in the web) — a keystroke nobody has
 * driven against that CLI is a keystroke nobody asked for.
 */

/** How long claude's own send-now is given to drain the queue before agentop interrupts the turn. */
export const SEND_NOW_GENTLE_MS = 3000
/** How long the interrupt is given to hand the queue over as the next turn. */
export const SEND_NOW_FIRM_MS = 4000
/** How often the pane is re-read while waiting. */
export const SEND_NOW_POLL_MS = 150

/**
 * What happened, in the order a person would want to know it:
 * - `sent`        — claude's own send-now delivered it; the running turn was kept.
 * - `interrupted` — it did not move in time, so the turn was interrupted and the queue went.
 * - `nothing`     — the session showed no queued message: it was already taken in (or never queued).
 * - `stuck`       — even the interrupt did not drain it; the message is still waiting.
 * - `no-focus`    — the input box could not be given the keyboard; nothing was pressed.
 * - `failed`      — tmux refused a keystroke.
 */
export type SendNowOutcome = 'sent' | 'interrupted' | 'nothing' | 'stuck' | 'no-focus' | 'failed'

/**
 * claude's own horizontal rule — the input box sits between the last two. It STARTS with a run of
 * `─` and may carry a LABEL after it: a session renamed with `/rename` draws its name into the top
 * rule (`──── Líder — Runtime/Harness (sessão 3) ─`), measured on the owner's screen 2026-09-30.
 * Requiring a run of `─` at the END too missed that rule, so no queue was ever found on a named
 * session and "send now" answered "nothing queued" over a queued message.
 */
const RULE = /^\s*─{3,}/
/** The hint claude draws under the queued messages (`ctrl+enter` on terminals that send it). */
const SEND_NOW_HINT = /^\s*(?:ctrl\+x ctrl\+s|ctrl\+enter) to send now\s*$/
/** The empty input box's placeholder while something is queued. */
const QUEUE_PLACEHOLDER = /Press up to edit queued messages/
/** How many lines above the input box the hint is looked for — the queue is drawn right there. */
export const QUEUE_HINT_LINES = 12

/**
 * Is claude holding a queued message on this screen?
 *
 * Read ONLY around the input box, for the reason `attention.ts` records: this product is developed
 * with this product, and a session editing this very file has these strings on screen as source. The
 * hint must be a WHOLE line (a quoted one sits inside other text), and the placeholder must be inside
 * the input box, between its two rules.
 */
export function hasQueuedMessages(frame: readonly string[]): boolean {
  const lines = frame.filter(l => l.trim() !== '')
  const rules: number[] = []
  for (let i = 0; i < lines.length; i++) if (RULE.test(lines[i]!)) rules.push(i)
  if (rules.length < 2) return false
  const bottom = rules[rules.length - 1]!
  const top = rules[rules.length - 2]!
  for (let i = top + 1; i < bottom; i++) if (QUEUE_PLACEHOLDER.test(lines[i]!)) return true
  for (let i = Math.max(0, top - QUEUE_HINT_LINES); i < top; i++) {
    if (SEND_NOW_HINT.test(lines[i]!)) return true
  }
  return false
}

/** Did the delivery reach the conversation? The web's success/failure split. */
export function sendNowDelivered(outcome: SendNowOutcome): boolean {
  return outcome === 'sent' || outcome === 'interrupted' || outcome === 'nothing'
}

// ---------------------------------------------------------------------------------------------
// The progress the web draws while the request is open

export type SendNowPhase = 'gentle' | 'firm'

export interface SendNowProgress {
  phase: SendNowPhase
  /** 0..1, never 1 while the request is open — only the answer fills the bar. */
  fraction: number
  caption: string
}

/** The most the bar reaches before the server answers. */
const OPEN_CEILING = 0.92

/**
 * The bar and its caption at `elapsedMs` into the request. The phase follows the server's own
 * clock (`SEND_NOW_GENTLE_MS`), so "interrupting" is said exactly when the server starts to.
 */
export function sendNowProgress(elapsedMs: number, pt: boolean): SendNowProgress {
  const total = SEND_NOW_GENTLE_MS + SEND_NOW_FIRM_MS
  const t = Math.max(0, elapsedMs)
  const fraction = Math.min(OPEN_CEILING, (t / total) * OPEN_CEILING)
  if (t < SEND_NOW_GENTLE_MS) {
    return {
      phase: 'gentle', fraction,
      caption: pt ? 'Inserindo mensagem imediatamente…' : 'Inserting the message right away…',
    }
  }
  return {
    phase: 'firm', fraction,
    caption: pt
      ? 'A sessão não liberou a vez — interrompendo o turno atual para entregar…'
      : 'The session did not yield — interrupting the current turn to deliver it…',
  }
}
