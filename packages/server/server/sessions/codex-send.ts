import { rulesFor } from './attention-rules'

/**
 * PURE: the safe next step when sending a line to Codex's terminal composer.
 *
 * Codex renders a bracketed paste as a `[Pasted Content N chars]` chip.  An Enter sent in the
 * same burst as that paste can be swallowed as paste input, so the chip must be observed first.
 * After Enter, a remaining chip means the first return did not submit; one retry is safe because
 * a submitted composer no longer has a chip.  Blocking screens are never typed into.
 */

export type CodexSendPhase = 'before-paste' | 'after-paste' | 'after-enter' | 'after-retry'
export type CodexSendAction = 'blocked' | 'paste' | 'wait' | 'enter' | 'retry-enter' | 'delivered' | 'failed'

const PASTED = /Pasted Content(?:\s+\d+\s+chars?)?/i
const COMPOSER_MARKER = /^\s*›/
/** How much of the bottom of the screen a blocking dialog is looked for in (non-blank lines). */
const BLOCKING_LINES = 8

/**
 * The bottom of the screen: its last `BLOCKING_LINES` non-blank lines.
 *
 * It used to end at the line matching `NN% left` ("the status line") and look 8 lines above it. That
 * line is NOT a stable anchor: codex 0.161.0 dropped the old `model · 100% left · cwd` footer for
 * `GPT-5.6-Luna medium · <cwd>` plus `? for shortcuts`, and `NN% left` now survives only inside a
 * rate-limit warning (`⚠ 5h limit: 49% left · resets at 13:41`) drawn ABOVE the composer — so the
 * anchor moved up to a warning, the composer fell below the "area", and a pasted message was
 * invisible: measured live, `sendTextReliable` gave up after 600 ms without pressing Enter and left
 * the text typed in the box. A dialog's footer is the LAST thing on the screen in every version, so
 * the screen's own bottom is the anchor.
 */
export function codexComposerArea(frame: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = frame.length - 1; i >= 0 && kept.length < BLOCKING_LINES; i--) {
    if ((frame[i] ?? '').trim() !== '') kept.unshift(frame[i]!)
  }
  return kept
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The ACTIVE input box only: from the LAST `›` on the screen down.
 *
 * Codex draws a submitted message in the history with the very same `›` marker, directly above the
 * composer, so looking for the sent text in a window of the screen found the ECHO of a message that
 * had been delivered, read it as "still in the box", pressed Return a second time on an empty input
 * and called the send failed — a live Codex target that had taken the message answered "the session
 * ended". The composer is the bottom-most marker, which is what puts the history echo (further up)
 * outside it. Called only on a screen that is not a dialog (`planCodexSend` checks blocking first),
 * where the last marker is the composer and not a menu option.
 */
export function codexComposerInput(frame: readonly string[]): string[] {
  const i = frame.findLastIndex(line => COMPOSER_MARKER.test(line))
  return i >= 0 ? frame.slice(i) : codexComposerArea(frame)
}

function codexHasComposerText(frame: readonly string[], sentText: string): boolean {
  const area = codexComposerInput(frame).join('\n')
  const tail = normalise(sentText).slice(-30)
  return PASTED.test(area) || (tail.length > 0 && normalise(area).includes(tail))
}

export function codexIsBlockingFrame(frame: readonly string[]): boolean {
  const active = codexComposerArea(frame).join('\n')
  const update = /Update available/i.test(active) && /Update now/i.test(active) && /\bSkip\b/i.test(active)
  const approval = rulesFor('codex')?.approval.some(re => re.test(active)) === true
  return update || approval
}

/**
 * Classify a failed write using the screen read immediately after the backend refused it.
 *
 * `ended` is reserved for a pane that is GONE. A live pane that is not on a dialog is `unconfirmed`:
 * the keys were written and the submit could not be shown to have landed — saying "the session
 * ended" there sent people to reopen a conversation that was running fine.
 */
export function classifyCodexSendFailure(frame: readonly string[], alive: boolean): 'prompt' | 'ended' | 'unconfirmed' {
  if (!alive) return 'ended'
  return codexIsBlockingFrame(frame) ? 'prompt' : 'unconfirmed'
}

export function codexHasPastedComposer(frame: readonly string[], sentText = ''): boolean {
  return codexHasComposerText(frame, sentText)
}

export function planCodexSend(
  phase: CodexSendPhase,
  frame: readonly string[],
  sentText = '',
): CodexSendAction {
  if (codexIsBlockingFrame(frame)) return 'blocked'
  const pasted = codexHasPastedComposer(frame, sentText)
  if (phase === 'before-paste') return 'paste'
  if (phase === 'after-paste') return pasted ? 'enter' : 'wait'
  if (phase === 'after-enter') return pasted ? 'retry-enter' : 'delivered'
  return pasted ? 'failed' : 'delivered'
}
