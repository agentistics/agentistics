import { existsSync } from 'node:fs'

/**
 * The server's ONE `which`. `Bun.which` is a SYNCHRONOUS filesystem walk of every PATH directory, and
 * under WSL the unit's PATH carries ~25 `/mnt/c/...` directories (9p): looking for a tool that is not
 * installed took 6.1 s per call, on the event loop. `GET /api/vault` looked for `fido2-token` twice per
 * request with a 15 s poll per tab, and the account identity probe looked for `python`/`security` every
 * 60 s — `/api/version` had p95 6.2 s and a max of 22.9 s (docs/perf/2026-11-10-cpu-alien.md).
 *
 * So the answer is remembered, keyed on the NAME and the PATH searched:
 * - a HIT is kept until the file stops being there (verified with one `stat`, then re-searched);
 * - a MISS is kept for `negativeTtlMs` (default 10 min). A miss is a fact about the moment, so it
 *   expires — a person installs a CLI while the server runs — and callers that must notice an install
 *   sooner pass a shorter TTL.
 */
export const WHICH_NEGATIVE_TTL_MS = 10 * 60_000
const MAX_ENTRIES = 512

export interface WhichOptions {
  /** The PATH to search; defaults to the process's own. */
  PATH?: string
  /** How long a miss is believed. */
  negativeTtlMs?: number
}

type Entry = { path: string | null; at: number }
const memo = new Map<string, Entry>()
let searches = 0
let search: (name: string, path: string) => string | null = (name, path) => Bun.which(name, { PATH: path })
let exists: (p: string) => boolean = existsSync

export function hostWhich(name: string, opts: WhichOptions = {}, now: number = Date.now()): string | null {
  const path = opts.PATH ?? process.env.PATH ?? ''
  const key = `${path}\0${name}`
  const hit = memo.get(key)
  if (hit) {
    if (hit.path !== null) {
      if (exists(hit.path)) return hit.path
    } else if (now >= hit.at && now - hit.at < (opts.negativeTtlMs ?? WHICH_NEGATIVE_TTL_MS)) {
      return null
    }
    memo.delete(key)
  }
  searches++
  const found = search(name, path)
  if (memo.size >= MAX_ENTRIES) memo.clear()
  memo.set(key, { path: found, at: now })
  return found
}

/** Test seams — the memo is per process. */
export function resetHostWhich(): void { memo.clear(); searches = 0 }
export function hostWhichSearches(): number { return searches }
export function setHostWhichForTests(opts: { search?: typeof search; exists?: typeof exists }): void {
  if (opts.search) search = opts.search
  if (opts.exists) exists = opts.exists
}
export function restoreHostWhich(): void {
  search = (name, path) => Bun.which(name, { PATH: path })
  exists = existsSync
  resetHostWhich()
}
