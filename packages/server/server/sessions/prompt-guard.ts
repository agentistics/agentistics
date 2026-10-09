/**
 * prompt-guard.ts — PURE: may a line be typed into this session's screen, and when a write did not
 * land, WHAT is the honest reason?
 *
 * `promptSession` (the one send path behind the composer, `agentop session prompt`, the broadcast and
 * `agentistics_session_message`) used to carry these decisions inline, harness by harness, and only
 * Codex got a post-failure diagnosis — every other harness answered "did not take the keystroke" with
 * the `ended` recovery attached to a session that was alive. They live here so each harness is tested
 * against its own screens, not argued from the shape of the code.
 *
 * Three reasons and no more, and they are not interchangeable:
 *  - `prompt`      a dialog is open: nothing was typed, answer it first.
 *  - `ended`       the pane is gone: reopen is the recovery.
 *  - `unconfirmed` the pane is alive and not on a dialog, and the submit could not be shown to have
 *                  landed: the message MAY have arrived, so the sender looks before it resends.
 * `ended` is never said of a live pane.
 */

import type { HarnessId } from '@agentistics/core'
import { rulesFor } from './attention-rules'
import { classifyCodexSendFailure, codexIsBlockingFrame } from './codex-send'

export type SendFailure = 'prompt' | 'ended' | 'unconfirmed'

/** Is this screen a dialog a typed line would answer instead of being a message? */
export function promptIsBlocked(harness: HarnessId, frame: readonly string[]): boolean {
  if (harness === 'codex') return codexIsBlockingFrame(frame)
  const text = frame.join('\n')
  return rulesFor(harness)?.approval.some(re => re.test(text)) === true
}

/** Why a write that the backend reported as not delivered did not land, read from the screen AFTER it. */
export function classifySendFailure(harness: HarnessId, frame: readonly string[], alive: boolean): SendFailure {
  if (harness === 'codex') return classifyCodexSendFailure(frame, alive)
  if (!alive) return 'ended'
  return promptIsBlocked(harness, frame) ? 'prompt' : 'unconfirmed'
}
