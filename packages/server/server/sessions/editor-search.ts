/**
 * editor-search.ts — PURE: shaping the tree search's two kinds of hit, and capping the result.
 *
 * Mirrors `PR_LIMIT`'s pattern (`fleet-web.ts`) — a bounded response that SAYS when it is a
 * partial window, never a silent cutoff a caller could mistake for "that's everything".
 */

/** Mirrors PR_LIMIT's own bound — capped so a huge match set never becomes a huge response. */
export const SEARCH_LIMIT = 200

export interface NameHit { kind: 'name'; path: string }
export interface ContentHit { kind: 'content'; path: string; line: number; text: string }
export type SearchHit = NameHit | ContentHit

export interface SearchResult {
  hits: SearchHit[]
  truncated: boolean
}

export function capHits(hits: readonly SearchHit[], limit: number = SEARCH_LIMIT): SearchResult {
  return { hits: hits.slice(0, limit), truncated: hits.length > limit }
}

/**
 * Parses `git grep -n`'s own line shape: `<path>:<line>:<text>`. The path group stops at the
 * FIRST colon (POSIX paths do not contain one), the line group is digits only, and everything
 * after the second colon — colons included — is the matched text verbatim.
 */
export function parseGrepOutput(stdout: string): ContentHit[] {
  const out: ContentHit[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const m = /^([^:]+):(\d+):(.*)$/.exec(line)
    if (!m) continue
    out.push({ kind: 'content', path: m[1]!, line: Number(m[2]), text: m[3]! })
  }
  return out
}

/** Filename matches: every relative path whose BASENAME contains `q`, case-insensitively. */
export function matchNames(relativePaths: readonly string[], q: string): NameHit[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return relativePaths
    .filter(p => (p.split('/').pop() ?? p).toLowerCase().includes(needle))
    .map(path => ({ kind: 'name' as const, path }))
}

export type GitGrepOutcome = 'parse' | 'none' | 'fallback'

/**
 * `git grep`'s own exit code is overloaded: 0 means it ran and found matches, 1 means it ran
 * fine and found nothing at all — that is not a failure to recover from — and anything else
 * (including the sentinel `-1` the caller uses when the process could not even be spawned) is a
 * genuine failure. A genuine failure must fall back to a plain read rather than being reported as
 * a confident empty result — the same shape `gitListRecursive` returning `null` already uses in
 * this module for "not a git repo at all".
 */
export function decideGitGrepOutcome(code: number): GitGrepOutcome {
  if (code === 0) return 'parse'
  if (code === 1) return 'none'
  return 'fallback'
}
