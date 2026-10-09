/**
 * transcript-activity.ts — "a harness just wrote into its transcript tree", from the file watcher to
 * whoever links conversations in this process.
 *
 * The watcher (`sse.ts`) already sees every write under each harness's session directory; it used
 * that only to schedule a data rebuild. kimi holds its session files open only while it writes them
 * (see `process-transcript.ts`), so the moment of a write is the one moment its pane process can be
 * caught naming its conversation — and the watcher is the only thing that knows when that moment is.
 * This carries the fact across, and nothing else: no path, no content, no decision. The listener
 * (`cli-start.ts`) decides whether any row is waiting for a link and samples if so.
 *
 * A plain in-process registry rather than an event emitter dependency: one producer, at most a
 * couple of listeners, and a listener that throws must never break the watcher that called it.
 */

import { sep } from 'node:path'
import type { HarnessId } from '@agentistics/core'

type Listener = (harness: HarnessId) => void

const listeners = new Set<Listener>()

/** Subscribe; returns the unsubscribe. */
export function onTranscriptActivity(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function noteTranscriptActivity(harness: HarnessId): void {
  for (const fn of listeners) {
    try { fn(harness) } catch { /* a listener's failure is its own */ }
  }
}

/**
 * Which harness's session root a changed path sits under, or `null`. PURE.
 *
 * Matched on a whole path SEGMENT boundary, so a root `/x/sessions` does not claim `/x/sessions-old`.
 */
export function harnessOfPath(
  path: string,
  roots: Readonly<Partial<Record<HarnessId, string | null>>>,
): HarnessId | null {
  for (const [harness, root] of Object.entries(roots) as [HarnessId, string | null | undefined][]) {
    if (!root) continue
    if (path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)) return harness
  }
  return null
}
