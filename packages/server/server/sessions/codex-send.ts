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

function codexHasComposerText(frame: readonly string[], sentText: string): boolean {
  const area = codexComposerArea(frame).join('\n')
  const tail = normalise(sentText).slice(-30)
  return PASTED.test(area) || (tail.length > 0 && normalise(area).includes(tail))
}

export function codexIsBlockingFrame(frame: readonly string[]): boolean {
  const active = codexComposerArea(frame).join('\n')
  const update = /Update available/i.test(active) && /Update now/i.test(active) && /\bSkip\b/i.test(active)
  const approval = rulesFor('codex')?.approval.some(re => re.test(active)) === true
  return update || approval
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
