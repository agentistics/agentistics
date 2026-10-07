/**
 * prompt-deadline.ts — PURE: how long a send may hold the HTTP response.
 *
 * `promptSession` re-reads the pane, brings focus back to the input, types, presses Enter and polls
 * for the pane to move, every step a `tmux` spawn queued behind the pane's write lock. On a busy
 * machine that exceeded the browser's 20 s budget while the message HAD been delivered, so the
 * composer showed "the machine did not answer in time" over a message the assistant was already
 * answering.
 *
 * The response is therefore released after `PROMPT_ACK_MS`: the keystrokes are in flight, the
 * work carries on, and a LATE failure is reported through `onLate` (a notification) instead of by
 * holding the request.
 */
export const PROMPT_ACK_MS = 4_000

export type DeadlineResult<T> = { settled: true; value: T } | { settled: false }

/**
 * Wait for `work` up to `ms`. When it is still running, `onLate` receives its eventual outcome
 * (a rejection becomes `{ error }`), so nothing is lost and nothing is unhandled.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onLate: (outcome: { value: T } | { error: unknown }) => void,
): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), ms) })
  const first = await Promise.race([
    work.then(value => ({ value }), error => ({ error })),
    late,
  ])
  clearTimeout(timer)
  if (first === 'late') {
    void work.then(value => onLate({ value }), error => onLate({ error }))
    return { settled: false }
  }
  if ('error' in first) throw first.error
  return { settled: true, value: first.value }
}
