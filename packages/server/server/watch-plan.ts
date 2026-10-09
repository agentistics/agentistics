/**
 * watch-plan.ts — PURE. Which harness directories still need a watcher.
 *
 * `setupFileWatcher` used to decide this ONCE, at boot: a directory that did not exist then
 * (`~/.gemini/tmp` on a machine that had never run gemini, `~/.kimi-code/sessions` before kimi's first
 * session) was logged as "not found" and never looked at again, so that harness's writes refreshed
 * nothing until the server restarted. The decision is now a function of (wanted, already watching,
 * what exists NOW), re-asked on a timer, and the IO stays in `sse.ts`.
 */

export interface WatchWant {
  dir: string
  /** The harness this directory belongs to — only for the log line. */
  label: string
}

/** The wanted directories that exist now, are not watched yet, and appear once each (first label wins). */
export function planLateWatches(
  wanted: readonly WatchWant[],
  watched: ReadonlySet<string>,
  exists: (dir: string) => boolean,
): WatchWant[] {
  const out: WatchWant[] = []
  const claimed = new Set<string>()
  for (const w of wanted) {
    if (watched.has(w.dir) || claimed.has(w.dir)) continue
    if (!exists(w.dir)) continue
    claimed.add(w.dir)
    out.push(w)
  }
  return out
}

/** How often a missing directory is looked for again. A stat per missing directory — cheap, and slow enough to be free. */
export const LATE_WATCH_INTERVAL_MS = 30_000
