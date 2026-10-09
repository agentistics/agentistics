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
const CODEX_STATUS = /\b\d+%\s+left\b/i

/** Only the active composer/modal area: scrollback must never block a new send. */
export function codexComposerArea(frame: readonly string[]): string[] {
  const status = frame.findLastIndex(line => CODEX_STATUS.test(line))
  const end = status >= 0 ? status : frame.length
  return frame.slice(Math.max(0, end - 8), end)
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** How far above the status line the composer's own `›` marker is looked for. */
const COMPOSER_MAX_LINES = 30
const COMPOSER_MARKER = /^\s*›/

/**
 * The ACTIVE input box only: from the last `›` above the status line down to it.
 *
 * Codex draws a submitted message in the history with the very same `›` marker, directly above the
 * composer. Looking for the sent text in the 8 lines above the status line (`codexComposerArea`)
 * therefore found the ECHO of a message that had been delivered, read it as "still in the box",
 * pressed Return a second time on an empty input and then called the send failed — so a live Codex
 * target that had taken the message answered "the session ended". The composer's own marker is the
 * NEAREST one to the status line, which is what makes the history echo (further up) fall outside.
 * When no marker is found within reach the legacy area is used, so the check can only get stricter
 * about what counts as "still typed", never blind.
 */
export function codexComposerInput(frame: readonly string[]): string[] {
  const status = frame.findLastIndex(line => CODEX_STATUS.test(line))
  const end = status >= 0 ? status : frame.length
  for (let i = end - 1; i >= Math.max(0, end - COMPOSER_MAX_LINES); i--) {
    if (COMPOSER_MARKER.test(frame[i] ?? '')) return frame.slice(i, end)
  }
  return codexComposerArea(frame)
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
