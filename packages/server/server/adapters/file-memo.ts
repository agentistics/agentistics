/**
 * file-memo.ts — a harness reader parses a file ONCE per version of it (PERF.1 step 1).
 *
 * Every `/api/data` build used to re-read and re-parse every Codex rollout, Gemini chat, Copilot
 * session and Kimi wire, whether or not it had changed: measured on a synthetic home with 300 Codex
 * rollouts (111 MB), the codex step alone was ~600 ms of every build — and a build runs whenever ANY
 * transcript on the machine is appended to. A finished session never changes again, so almost all of
 * that was work repeated to arrive at the answer already held.
 *
 * The VERSION is the (mtime, size) of every file the session is read from — several for Copilot
 * (events + workspace) and Kimi (state + one wire per agent) — taken BEFORE the read. A file that
 * grows between the stat and the read stores newer content under an older version, which only ever
 * costs one extra parse on the next build; it can never serve stale content as current.
 *
 * Callers stamp fields onto the sessions they are handed (git remotes, session labels, the central's
 * user), so the remembered value is never handed out: a hit returns a COPY, and a miss stores one.
 * A SHALLOW copy: every such stamp assigns a top-level field and none writes into a nested one
 * (a deep copy of 300 sessions per build was most of what this memo still cost).
 * One entry per file key (`FileVersionCache`), so a live file being appended to replaces its own
 * entry instead of accumulating versions.
 */
import { stat } from 'fs/promises'
import { FileVersionCache } from '../file-version-cache'

/** `mtime:size` of each path in order; a missing file reads as `-` (it may appear later). */
export async function versionOf(paths: readonly string[]): Promise<string> {
  const parts = await Promise.all(paths.map(async p => {
    const st = await stat(p).catch(() => null)
    return st ? `${st.mtimeMs}:${st.size}` : '-'
  }))
  return parts.join('|')
}

export interface FileMemo<V> {
  /** The parsed value for `key` at `version`, parsing only when that version has not been seen. */
  get(key: string, version: string, parse: () => Promise<V>): Promise<V>
  readonly size: number
  clear(): void
}

function shallow<V>(v: V): V {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...(v as object) } as V : v
}

export function createFileMemo<V>(capacity = 50_000): FileMemo<V> {
  let cache = new FileVersionCache<V>(capacity)
  return {
    async get(key, version, parse) {
      const hit = cache.get(key, version)
      if (hit !== undefined) return shallow(hit)
      const value = await parse()
      cache.set(key, version, shallow(value))
      return value
    },
    get size() { return cache.size },
    clear() { cache = new FileVersionCache<V>(capacity) },
  }
}

/** Every memo the harness readers hold, so a test can start each case cold. */
const ALL: FileMemo<unknown>[] = []
export function registerMemo<V>(m: FileMemo<V>): FileMemo<V> { ALL.push(m as FileMemo<unknown>); return m }
export function clearAdapterMemos(): void { for (const m of ALL) m.clear() }
