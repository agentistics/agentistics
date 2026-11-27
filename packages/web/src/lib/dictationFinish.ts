/**
 * dictationFinish.ts — ending a live dictation because the person pressed SEND, without losing
 * a word of it.
 *
 * Every composer used to end dictation on send by DETACHING `onresult` and calling `abort()`, which
 * by definition discards whatever the recogniser had not settled on yet. In continuous mode that is
 * routinely most of what was said: Chrome settles a phrase only at a pause, and until then the words
 * exist only as the interim guess drawn beside the field. The send then read a draft without them
 * and the person had to say it all again (owner, 2026-11-27, every day).
 *
 * So the recogniser is asked to STOP (which, unlike abort, makes it finalise the audio it holds),
 * its results are COLLECTED here rather than written into the draft, and the promise resolves with
 * that text when it ends — or after a short bounded wait with the best text it had (the last
 * interim), because a send that waits on a recogniser that never answers is a send that hangs.
 * Every handler is detached when it resolves, so a result or an end arriving later can neither
 * re-fill the box with text already sent nor wipe the next message.
 *
 * The caller appends the resolved text to the draft (`appendDictation`) and sends that.
 */
import { appendDictation, splitDictation } from './dictation'

export interface FinishableRecognition {
  stop: () => void
  abort?: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
}

/** How long a send waits for the recogniser to settle what it heard. */
export const DICTATION_FLUSH_MS = 1500

/**
 * Stop `rec` and resolve with the text it had not yet written into the draft.
 * `pendingInterim` is the interim guess on screen at the moment of the send.
 */
export function finishDictation(
  rec: FinishableRecognition,
  pendingInterim: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  return new Promise(resolve => {
    let settled = ''
    let pending = pendingInterim
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (discard: boolean) => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      rec.onresult = null
      rec.onend = null
      rec.onerror = null
      // Only a recogniser still running is aborted: the wait is over and its text has been taken.
      if (discard) { try { rec.abort?.() } catch { /* already ended */ } }
      resolve(appendDictation(settled, pending))
    }
    rec.onresult = e => {
      const { final, interim } = splitDictation(e as never)
      settled = appendDictation(settled, final)
      pending = interim
    }
    rec.onend = () => finish(false)
    rec.onerror = () => finish(false)
    timer = setTimeout(() => finish(true), opts.timeoutMs ?? DICTATION_FLUSH_MS)
    try { rec.stop() } catch { finish(false) }
  })
}
