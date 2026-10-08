import { join } from 'path'
import { mkdir, writeFile, readFile, stat } from 'fs/promises'
import type { SessionMeta, HarnessId } from '@agentistics/core'
import { CONSOLIDATED_DIR } from './config'
import { createLimiter, safeReadDir, safeReadJson } from './utils'
import { HARNESS_ORDER, migrateAgentMetrics, normalizeSessionTimes, coerceSessionLists } from '@agentistics/core'

const writeLimit = createLimiter(20)
const readyDirs = new Set<string>()

/**
 * The rebuild storm (v2.103.1): every `/api/data` build READ every stored file twice — once to
 * compare before writing, once to load — ~180 ms a build on a real store, every ~2 s. Both halves
 * now remember what they last saw, keyed on the file's own (mtime, size), so an unchanged store
 * costs a `stat` per file and nothing else. Anything that changes the file (another process, a hand
 * edit, a restore) changes the stamp and is read again.
 */
const lastWritten = new Map<string, { stamp: string; text: string; remote: string | undefined }>()
const lastLoaded = new Map<string, { stamp: string; value: SessionMeta | null }>()
const stampOf = async (p: string): Promise<string | null> => {
  const st = await stat(p).catch(() => null)
  return st ? `${st.mtimeMs}:${st.size}` : null
}
/** For tests: forget both memos. */
export function clearConsolidateMemo(): void { lastWritten.clear(); lastLoaded.clear() }

export function consolidatedPath(harness: HarnessId, sessionId: string): string {
  // Some harnesses (e.g. Gemini) embed a path segment in the session id
  // ("project/session-..."), so the raw id cannot be a flat filename — the
  // intermediate dir would not exist (ENOENT). Flatten path separators; the real
  // session id is read back from the file CONTENT, not the filename, so this is safe.
  const safeId = sessionId.replace(/[/\\]/g, '_')
  return join(CONSOLIDATED_DIR, harness, `${safeId}.json`)
}

async function ensureDir(harness: HarnessId): Promise<void> {
  if (readyDirs.has(harness)) return
  await mkdir(join(CONSOLIDATED_DIR, harness), { recursive: true })
  readyDirs.add(harness)
}

/**
 * A session written WITHOUT `git_remote` keeps the one its stored record already had. The remote is
 * read from git on every build and a read can fail or be late; the stored copy is what the team
 * uploader pushes, and a record that lost its remote is classified as the `none` bucket by
 * `sessionShared` — so a repository the user withheld would be pushed. "Not read this time" is not
 * "not a repository": absence never overwrites a remote already recorded.
 */
export function keepStoredRemote(next: SessionMeta, storedJson: string | null): SessionMeta {
  return withRemote(next, storedRemoteOf(storedJson))
}

/** The `git_remote` a stored record carries, or undefined. */
function storedRemoteOf(storedJson: string | null): string | undefined {
  if (!storedJson) return undefined
  try {
    const prev = JSON.parse(storedJson) as { git_remote?: unknown }
    return typeof prev.git_remote === 'string' && prev.git_remote ? prev.git_remote : undefined
  } catch { return undefined }
}

function withRemote(next: SessionMeta, storedRemote: string | undefined): SessionMeta {
  return next.git_remote || !storedRemote ? next : { ...next, git_remote: storedRemote }
}


/** Persist computed per-session metrics to ~/.agentistics/sessions/<harness>/<id>.json.
 *  Skips writes when the stored copy is byte-identical to avoid churn. Entries
 *  are never deleted, so sessions removed by Claude's cleanup survive here. */
export async function writeConsolidated(sessions: SessionMeta[]): Promise<number> {
  if (sessions.length === 0) return 0
  // PERF.1: an unchanged session costs a `stat` and a stringify, nothing else — the remembered record's
  // remote is kept beside its text rather than re-parsed out of it, and only a session that needs a
  // read or a write queues behind the I/O limiter (queueing every one cost ~3x the work itself).
  // `stat` holds no descriptor, so the stamps are taken all at once; only reads and writes are limited.
  const counts = await Promise.all(sessions.map(async s => {
    if (!s.session_id) return 0
    // A native session is SYNTHESIZED from the journal on every read (`native-sessions.ts`): a stored copy
    // would go stale the moment a run ends, and has no adapter directory to live in.
    if (s.harness === 'agentistics') return 0
    const harness = s.harness ?? 'claude'
    const dest = consolidatedPath(harness, s.session_id)
    const stamp = await stampOf(dest)
    const mem = lastWritten.get(dest)
    if (stamp !== null && mem && mem.stamp === stamp && JSON.stringify(withRemote(s, mem.remote)) === mem.text) return 0
    return writeLimit(async () => {
      await ensureDir(harness)
      const prev = await readFile(dest, 'utf-8').catch(() => null)
      const remote = storedRemoteOf(prev)
      const next = JSON.stringify(withRemote(s, remote))
      if (prev === next) {
        if (stamp) lastWritten.set(dest, { stamp, text: next, remote })
        return 0
      }
      await writeFile(dest, next)
      const after = await stampOf(dest)
      if (after) lastWritten.set(dest, { stamp: after, text: next, remote: withRemote(s, remote).git_remote || undefined })
      return 1
    })
  }))
  return counts.reduce<number>((a, b) => a + b, 0)
}

/** One stored record, read and repaired — or the one remembered under the file's stamp. It is the
 *  REMEMBERED object: `loadConsolidated` copies only the records it hands out (PERF.1 — a build in
 *  consolidate mode used to deep-copy every stored record and then discard every one still live). */
async function readRecord(path: string, limit: <T>(f: () => Promise<T>) => Promise<T>): Promise<SessionMeta | null> {
  const stamp = await stampOf(path)
  const mem = stamp ? lastLoaded.get(path) : undefined
  if (mem && mem.stamp === stamp) return mem.value
  return limit(() => readRecordFile(path, stamp))
}

async function readRecordFile(path: string, stamp: string | null): Promise<SessionMeta | null> {
  const read = await safeReadJson<SessionMeta>(path)
  if (!read?.session_id) { if (stamp) lastLoaded.set(path, { stamp, value: null }); return null }
  // Same reasoning for the list fields: a record holding `languages: {}` crashed every
  // dashboard that rendered it, here and on the central it was pushed to. See sessionShape.ts.
  const s = coerceSessionLists(read)
  if (!s.harness) s.harness = 'claude'
  // The store holds whatever an adapter wrote, including shapes it should not have written —
  // Kimi persisted `start_time` as an epoch number, and every consumer that calls a string
  // method on it threw. Repaired HERE, on the way in, because the file on disk is already
  // wrong and fixing the adapter cannot reach it. See normalizeSessionTimes.
  normalizeSessionTimes(s)
  // …and for the same reason, a record written before `AgentInvocation.unmeasured` existed is
  // read honestly rather than at face value. #373 stopped the READER publishing an async
  // agent priced at nothing; it does not reach what is already in this store, where such a row
  // has zeros and no mark and the new rule reads it as "measured, and it cost nothing".
  // `migrateAgentMetrics` is idempotent and recovers the shape from the content.
  if (s.agentMetrics) s.agentMetrics = migrateAgentMetrics(s.agentMetrics)
  if (stamp) lastLoaded.set(path, { stamp, value: s })
  return s
}

/** Load all consolidated sessions keyed by session_id.
 *  Reads per-harness subdirs plus legacy flat files at the root (treated as claude).
 *  De-duplicates by (harness, session_id), then collapses to an id-keyed Map.
 *  `skipIds`: ids the caller will discard anyway (the build's live sessions) — left out of the map
 *  without being copied. Every record returned is a (shallow) COPY: callers assign top-level fields
 *  onto what they are given (the git_remote backfill), and the remembered record must stay what the
 *  file says. Nothing writes into a nested field of a session. */
export async function loadConsolidated(opts: { skipIds?: ReadonlySet<string> } = {}): Promise<Map<string, SessionMeta>> {
  const map = new Map<string, SessionMeta>()
  const limit = createLimiter(40)
  // Per-harness subdirs + legacy flat files (treated as claude)
  const harnesses: HarnessId[] = HARNESS_ORDER
  const roots = [
    ...harnesses.map(h => ({ dir: join(CONSOLIDATED_DIR, h), legacy: false })),
    { dir: CONSOLIDATED_DIR, legacy: true },
  ]
  for (const { dir, legacy } of roots) {
    // Read in parallel, kept in FILE order: the map's order is the order revived sessions are listed
    // in, and completion order made two loads of the same store disagree.
    const files = (await safeReadDir(dir)).filter(f => f.endsWith('.json')).sort()
    const records = await Promise.all(files.map(f => readRecord(join(dir, f), limit)))
    for (const s of records) {
      if (!s) continue
      // (harness, id) key; first writer wins per key
      const key = `${s.harness}:${s.session_id}`
      if (!map.has(key)) map.set(key, s)
    }
    if (legacy) break
  }
  // Caller expects id-keyed map; collapse to id (live merge re-dedups by id anyway)
  const byId = new Map<string, SessionMeta>()
  for (const s of map.values()) {
    if (byId.has(s.session_id) || opts.skipIds?.has(s.session_id)) continue
    byId.set(s.session_id, { ...s })
  }
  return byId
}
