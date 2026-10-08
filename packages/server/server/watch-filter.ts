/**
 * watch-filter.ts — which file events under a watched session directory mean "the data may have
 * changed" (PERF.1 step 1). Pure.
 *
 * The session directories used to be watched by chokidar, which answers every fs.watch event on a
 * directory by re-listing THAT WHOLE DIRECTORY (readdirp, filter and stat per entry, at most once a
 * second per directory) to diff it against what it had. A transcript being written is an event a
 * second, forever, so every live session kept a full listing of its project directory running:
 * measured with three sessions writing on a synthetic home, ~21 % of a core — more than the rebuilds
 * themselves. All the server needs is "something changed under X, at this path", which is exactly
 * what a native recursive `fs.watch` reports, so the rule chokidar applied is applied here instead,
 * to the path in the event: the same noise filter, the same `.sqlite` exclusion, the same depth cap.
 *
 * The filter is tested against the path RELATIVE to the watched root. Chokidar tested the absolute
 * path, so a root that itself sat under a directory named like a noise tree (`…/cache/…`) silently
 * watched nothing.
 */

/** chokidar's `depth: 6`: subdirectories six levels down are watched, so their files are depth 7. */
export const WATCH_DEPTH = 6

export function watchedEvent(relative: string | null | undefined, ignored: RegExp, depth = WATCH_DEPTH): boolean {
  // No file name: the platform could not say what changed — treat it as a change, never as nothing.
  if (!relative) return true
  const rel = relative.replace(/\\/g, '/')
  if (ignored.test(rel) || /\.sqlite/.test(rel)) return false
  return rel.split('/').filter(Boolean).length <= depth + 1
}
