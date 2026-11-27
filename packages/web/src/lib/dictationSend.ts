/**
 * dictationSend.ts — the one step both composers take when Send is pressed while dictating:
 * wait for the recogniser to hand back what it had not settled on yet, append that tail to the
 * draft AS IT IS AFTER THE WAIT, write it back, and hand the caller the draft to compose from.
 *
 * It lives here, not inline in each composer, so the step is tested once as behaviour
 * (`dictationSend.test.ts`) instead of being pinned over a component's source text. Two rules it
 * keeps for both callers:
 *
 * - The draft is read AFTER the tail arrives and is never cleared before it: a send that fails
 *   (or is refused) must leave the person's typed text AND the dictated tail in the field.
 * - The `guard` is held while waiting. A second press in that window would otherwise send the
 *   draft WITHOUT the tail (the recogniser is already detached, so it looks like nothing is being
 *   dictated); callers return early while `guard.current` is true.
 */
import { appendDictation } from './dictation'

/** The draft after a dictation tail is appended — the same spacing rule the composers use while listening. */
export function draftWithDictationTail(draft: string, tail: string): string {
  return appendDictation(draft, tail)
}

export interface DictationFlushIo {
  /** Stop the recogniser and resolve with the text it had not written into the draft yet. */
  finish: () => Promise<string>
  /** The draft as it is NOW (read after the wait, never captured before it). */
  readDraft: () => string
  /** Write the new draft into the field. Called only when the tail changed it. */
  writeDraft: (next: string) => void
}

export interface DictationFlushResult {
  /** The draft to compose the message from. */
  draft: string
  /** Whether the tail changed the draft (and `writeDraft` was called). */
  changed: boolean
}

/**
 * Wait for the dictation tail and fold it into the draft. Holds `guard.current = true` while
 * waiting, and releases it even when `finish` rejects (the tail is then empty).
 */
export async function flushDictationIntoDraft(
  guard: { current: boolean },
  io: DictationFlushIo,
): Promise<DictationFlushResult> {
  guard.current = true
  let tail = ''
  try { tail = await io.finish() } catch { tail = '' } finally { guard.current = false }
  const before = io.readDraft()
  const draft = draftWithDictationTail(before, tail)
  const changed = draft !== before
  if (changed) io.writeDraft(draft)
  return { draft, changed }
}
