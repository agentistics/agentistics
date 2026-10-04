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
const lastWritten = new Map<string, { stamp: string; text: string }>()
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

/** Persist computed per-session metrics to ~/.agentistics/sessions/<harness>/<id>.json.
 *  Skips writes when the stored copy is byte-identical to avoid churn. Entries
 *  are never deleted, so sessions removed by Claude's cleanup survive here. */
export async function writeConsolidated(sessions: SessionMeta[]): Promise<number> {
  if (sessions.length === 0) return 0
  const counts = await Promise.all(sessions.map(s => writeLimit(async () => {
    if (!s.session_id) return 0
    // A native session is SYNTHESIZED from the journal on every read (`native-sessions.ts`): a stored copy
    // would go stale the moment a run ends, and has no adapter directory to live in.
    if (s.harness === 'agentistics') return 0
    const harness = s.harness ?? 'claude'
    await ensureDir(harness)
    const dest = consolidatedPath(harness, s.session_id)
    const next = JSON.stringify(s)
    const stamp = await stampOf(dest)
    const mem = lastWritten.get(dest)
    if (stamp !== null && mem && mem.stamp === stamp) {
      if (mem.text === next) return 0
    } else {
      const prev = await readFile(dest, 'utf-8').catch(() => null)
      if (prev === next) { if (stamp) lastWritten.set(dest, { stamp, text: next }); return 0 }
    }
    await writeFile(dest, next)
    const after = await stampOf(dest)
    if (after) lastWritten.set(dest, { stamp: after, text: next })
    return 1
  })))
  return counts.reduce<number>((a, b) => a + b, 0)
}

/** One stored record, read and repaired — or the copy of it remembered under the file's stamp. */
async function readRecord(path: string): Promise<SessionMeta | null> {
  const stamp = await stampOf(path)
  const mem = stamp ? lastLoaded.get(path) : undefined
  // A COPY: callers stamp fields onto what they are given (the git_remote backfill), and the
  // remembered record must stay what the file says.
  if (mem && mem.stamp === stamp) return mem.value ? structuredClone(mem.value) : null
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
  if (stamp) lastLoaded.set(path, { stamp, value: structuredClone(s) })
  return s
}

/** Load all consolidated sessions keyed by session_id.
 *  Reads per-harness subdirs plus legacy flat files at the root (treated as claude).
 *  De-duplicates by (harness, session_id), then collapses to an id-keyed Map. */
export async function loadConsolidated(): Promise<Map<string, SessionMeta>> {
  const map = new Map<string, SessionMeta>()
  const limit = createLimiter(40)
  // Per-harness subdirs + legacy flat files (treated as claude)
  const harnesses: HarnessId[] = HARNESS_ORDER
  const roots = [
    ...harnesses.map(h => ({ dir: join(CONSOLIDATED_DIR, h), legacy: false })),
    { dir: CONSOLIDATED_DIR, legacy: true },
  ]
  for (const { dir, legacy } of roots) {
    const files = await safeReadDir(dir)
    await Promise.all(files.filter(f => f.endsWith('.json')).map(f => limit(async () => {
      const s = await readRecord(join(dir, f))
      if (!s) return
      // (harness, id) key; first writer wins per key
      const key = `${s.harness}:${s.session_id}`
      if (!map.has(key)) map.set(key, s)
    })))
    if (legacy) break
  }
  // Caller expects id-keyed map; collapse to id (live merge re-dedups by id anyway)
  const byId = new Map<string, SessionMeta>()
  for (const s of map.values()) if (!byId.has(s.session_id)) byId.set(s.session_id, s)
  return byId
}
