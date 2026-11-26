/**
 * Running the transcript search — the IO edge of `transcript-search.ts`.
 *
 * Every dependency that touches the machine is injected, so the rules below are tested against
 * real behaviour rather than a mocked filesystem: what happens without `grep`, what happens with
 * no transcripts, and what happens when one harness fails while others succeed.
 *
 * ## Absence is reported, never rendered as zero
 *
 * The product's standing rule for a metric it cannot produce (`HARNESS_CAPABILITIES`, N/A rather
 * than a confident `0`) applies exactly as well to a search. "No conversation mentions this" and
 * "nothing looked" are different answers, and only one of them is a reason to stop searching. So a
 * missing `grep` and a machine with no transcripts each get their own `unavailable` reason, the
 * caller states it in words, and neither is allowed to look like an empty result set.
 */

import { access } from 'node:fs/promises'
import type { HarnessId } from '@agentistics/core'
import { TRANSCRIPT_SOURCES, grepArgv, parseGrepOutput, type TranscriptSource } from './transcript-search'
import { opencodeDbPath, searchOpencodeDb } from './opencode-store'

export interface TranscriptDeps {
  /** Whether `grep` can be run at all here. */
  hasGrep: () => Promise<boolean>
  dirExists: (path: string) => Promise<boolean>
  /** Run one search; resolve with grep's raw NUL-separated stdout. */
  grep: (query: string, root: string, include: string) => Promise<string>
  /**
   * OpenCode keeps every session in one SQLite store, so it is searched by a read-only SQL query and
   * not by `grep` (and needs no `grep` to be covered). Absent = the store is not searched.
   */
  opencode?: { exists: () => Promise<boolean>; search: (query: string) => Promise<string[]> }
}

export type TranscriptUnavailable =
  /** No `grep` on this machine — the search cannot be performed at all. */
  | 'no-grep'
  /** `grep` is here, but not one harness keeps transcripts on this machine. */
  | 'no-transcripts'

export interface TranscriptSearchResult {
  /** The conversations whose text carries the query. */
  ids: Set<string>
  /** The harnesses actually walked — what the UI may honestly claim to have covered. */
  covered: HarnessId[]
  /** Harnesses whose search errored. Their conversations are missing from `ids`, so say so. */
  failed: HarnessId[]
  /** Set only when nothing was searched. An empty `ids` with this unset is a real "no match". */
  unavailable?: TranscriptUnavailable
}

const empty = (): TranscriptSearchResult => ({ ids: new Set(), covered: [], failed: [] })

export async function runTranscriptSearch(
  query: string,
  deps: TranscriptDeps,
  sources: Partial<Record<HarnessId, TranscriptSource | null>> = TRANSCRIPT_SOURCES,
): Promise<TranscriptSearchResult> {
  // An empty query is not a search. Returning early keeps a cleared field from walking 475 MB.
  if (query.trim() === '') return empty()

  const result = empty()
  // The SQL half. A failure here is reported as `failed` like any other harness, never swallowed into
  // "no match", and it does not need grep.
  let opencodeCovered = false
  if (deps.opencode && await deps.opencode.exists()) {
    try {
      for (const id of await deps.opencode.search(query)) result.ids.add(id)
      result.covered.push('opencode'); opencodeCovered = true
    } catch { result.failed.push('opencode') }
  }

  if (!await deps.hasGrep()) return opencodeCovered ? result : { ...result, unavailable: 'no-grep' }

  const present: Array<[HarnessId, TranscriptSource]> = []
  for (const [id, src] of Object.entries(sources) as Array<[HarnessId, TranscriptSource | null]>) {
    if (src && await deps.dirExists(src.root)) present.push([id, src])
  }
  if (present.length === 0) return opencodeCovered ? result : { ...result, unavailable: 'no-transcripts' }

  // Concurrently: the harnesses are independent directories and the slowest one should set the
  // latency, not the sum. `allSettled` because one harness's failure must not lose the rest —
  // an unguarded throw here would turn a permissions error on one directory into no search at all.
  const runs = await Promise.allSettled(present.map(async ([id, src]) => {
    const out = await deps.grep(query, src.root, src.include)
    return { id, ids: parseGrepOutput(id, out, src.root) }
  }))

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!
    const id = present[i]![0]
    if (run.status === 'rejected') { result.failed.push(id); continue }
    result.covered.push(id)
    for (const conv of run.value.ids) result.ids.add(conv)
  }

  return result
}

// ---------------------------------------------------------------------------
// The real machine
// ---------------------------------------------------------------------------

let grepProbe: Promise<boolean> | null = null

/**
 * The live dependencies.
 *
 * `grep` is spawned with an argv ARRAY, so no shell ever parses the query — see the header of
 * `transcript-search.ts`. Exit code 1 is grep's "no match", which is an ordinary answer and not an
 * error; anything above that is a real failure and throws, so the caller can name the harness.
 */
export function liveTranscriptDeps(): TranscriptDeps {
  return {
    hasGrep: () => (grepProbe ??= (async () => {
      try {
        const p = Bun.spawn(['grep', '--version'], { stdout: 'ignore', stderr: 'ignore' })
        return await p.exited === 0
      } catch { return false }
    })()),

    opencode: {
      exists: async () => { try { await access(opencodeDbPath()); return true } catch { return false } },
      search: async query => searchOpencodeDb(opencodeDbPath(), query),
    },

    dirExists: async path => {
      try { await access(path); return true } catch { return false }
    },

    grep: async (query, root, include) => {
      const p = Bun.spawn(grepArgv(query, root, include), { stdout: 'pipe', stderr: 'ignore' })
      const out = await new Response(p.stdout).text()
      const code = await p.exited
      if (code > 1) throw new Error(`grep exited ${code}`)
      return out
    },
  }
}
