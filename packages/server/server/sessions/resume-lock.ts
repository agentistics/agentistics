/**
 * resume-lock.ts — one resume attempt at a time, per conversation.
 *
 * WHY IT EXISTS. `resumeSession` (cli-start.ts) checks who holds a conversation
 * (`conversationHeldBy`, a fresh live read) and, if nobody does, spawns a new
 * `claude --resume <id>`. That check is live but not EXCLUSIVE: nothing stopped a second call for
 * the SAME conversation from running its own check before the first call's spawn had registered a
 * holder. Two `resume` requests arriving within milliseconds of each other — two browser tabs, or
 * a phone and a desktop both reacting to a session that looked stuck at the same instant — both
 * read "nobody holds this" and both spawned. Measured on a real machine: two `claude --resume
 * <same-id>` processes, 62ms apart, each with its own tmux pane, both writing into one transcript.
 *
 * This is a CONVERSATION lock, not a pane lock (see `pane-writer.ts`, which this mirrors) — the key
 * is the conversation id being resumed, not a session or pane id, because the race is between two
 * REQUESTS that have not yet created a pane at all.
 *
 * FIFO by construction: each call links onto the chain for its own conversation id, so the second
 * caller's check-and-spawn only runs after the first's has fully settled — by which point the first
 * has either registered a holder (so the second correctly refuses) or failed outright (so the
 * second gets a clean attempt).
 *
 * A REJECTION NEVER BREAKS THE CHAIN. A failed resume must not wedge every later resume attempt for
 * that conversation.
 */

const chains = new Map<string, Promise<unknown>>()

/**
 * Run `fn` once every resume already queued for `conversationId` has finished.
 *
 * The returned promise settles exactly as `fn` does — a throw is still a throw for the caller.
 */
export function withResumeLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(conversationId) ?? Promise.resolve()
  const run = prior.then(fn, fn)
  // The stored link never rejects, so a failure cannot wedge the chain. The CALLER still sees it.
  const tail = run.then(() => undefined, () => undefined)
  chains.set(conversationId, tail)
  void tail.then(() => { if (chains.get(conversationId) === tail) chains.delete(conversationId) })
  return run
}

/** How many conversations currently hold a chain — for a test, and for nothing else. */
export function conversationsWithPendingResumes(): number {
  return chains.size
}

/** Test seam: the map is process-wide, so a test that writes must be able to reset it. */
export function resetResumeLocks(): void {
  chains.clear()
}
