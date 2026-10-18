/**
 * Walk a file's lines WITHOUT materialising them as an array.
 *
 * `content.split('\n')` allocates a second copy of every byte in the file, plus a string header
 * per line — and this parser used to do it TWICE on the same content (once for the main loop, once
 * for `extractAgentMetrics`). On a 25 MB transcript that is ~50 MB of strings for a file already
 * held whole in memory, and `scanProjects` runs 30 of these concurrently.
 *
 * Measured on a real store (862 MB of transcripts across 2.694 files): the boot warm-build peaked
 * at 1.095 MB RSS. The peak is what matters, not the settled figure — it is what makes a laptop
 * swap, and several agentop instances plus the assistants they are watching share that machine.
 *
 * A generator yields each line as it is found, so the peak holds one line at a time on top of the
 * file itself. `trim()` stays the caller's job — the two callers already do it, and doing it here
 * would allocate a second string per line for no gain.
 */
export function* iterLines(content: string): Generator<string> {
  let start = 0
  for (;;) {
    const nl = content.indexOf('\n', start)
    if (nl === -1) {
      if (start < content.length) yield content.slice(start)
      return
    }
    yield content.slice(start, nl)
    start = nl + 1
  }
}

