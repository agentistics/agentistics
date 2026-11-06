/**
 * opencode-v2-api.ts — OpenCode 2.x TUIs opened OUTSIDE agentistics, linked and read through opencode's own
 * background service (its OFFICIAL interface). OPENCODE.V2 F5, measured on 2.2.5 (2026-11-05, throwaway HOME).
 *
 * Why not the 1.x routes: 2.x writes no `creating instance` / `loop session.id` log lines (the turn runs in the
 * service process, not the TUI), and its tables are `session_v2` / `session_message` (the 1.x ones stay frozen
 * after migration, so reading them would answer a stale conversation). The service answers both questions:
 * - `GET /api/session` lists every session of every project, each with `location.directory` and `time`;
 * - `GET /api/session/active` is `{data:{"ses_…":{type:"running"}}}` while a turn runs and `{data:{}}` when idle.
 * The service is discovered from `<state>/opencode/service.json` (`{url, password, …}`, HTTP Basic user
 * `opencode`). This code NEVER starts the service: it only reads one that is already there.
 *
 * Refusals mirror the 1.x link: a session is a candidate for a process only when it sits in the process's cwd and
 * was created or updated at/after the process's start (within `START_SKEW_MS`); two candidates, or one session that
 * is the candidate of two processes, or none yet → no answer. Everything is bounded (≈3 s) and never throws.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { START_SKEW_MS, type OpencodeProcessRef } from './opencode-run-link'

export interface OpencodeV2Service { url: string; password: string }
export interface OpencodeV2Session { id: string; directory: string; created: number; updated: number; parentId?: string }

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ ok: boolean; json(): Promise<unknown> }>

export const V2_TIMEOUT_MS = 3_000
export const V2_CACHE_TTL_MS = 2_500

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** PURE. Where the 2.x service writes `service.json`: `XDG_STATE_HOME`, else the `$HOME` the data dir implies. */
export function opencodeStateDir(dataDir: string, env: Readonly<Record<string, string | undefined>> = process.env, home: string = env.HOME ?? ''): string {
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'opencode')
  const m = /^(.*)\/\.local\/share\/opencode$/.exec(dataDir.replaceAll('\\', '/'))
  return join(m?.[1] ?? home, '.local', 'state', 'opencode')
}

/** PURE. A `service.json` body → the service, or null. */
export function parseServiceRecord(raw: string): OpencodeV2Service | null {
  try {
    const j: unknown = JSON.parse(raw)
    if (!isObj(j) || typeof j.url !== 'string' || j.url === '' || typeof j.password !== 'string') return null
    return { url: j.url.replace(/\/+$/, ''), password: j.password }
  } catch { return null }
}

/** PURE. `GET /api/session` pages → sessions (tolerant: anything without an id and a directory is skipped). */
export function parseSessions(body: unknown): OpencodeV2Session[] {
  const rows = isObj(body) && Array.isArray(body.data) ? body.data : []
  const out: OpencodeV2Session[] = []
  for (const r of rows) {
    if (!isObj(r) || typeof r.id !== 'string') continue
    const loc = isObj(r.location) ? r.location : {}
    const time = isObj(r.time) ? r.time : {}
    if (typeof loc.directory !== 'string' || loc.directory === '') continue
    const created = num(time.created)
    out.push({
      id: r.id, directory: loc.directory, created, updated: num(time.updated) || created,
      ...(typeof r.parentID === 'string' ? { parentId: r.parentID } : {}),
    })
  }
  return out
}

/** PURE. `GET /api/session/active` → the ids with a running turn. */
export function parseActive(body: unknown): Set<string> {
  const d = isObj(body) && isObj(body.data) ? body.data : {}
  return new Set(Object.entries(d).filter(([, v]) => isObj(v) && v.type === 'running').map(([k]) => k))
}

/** PURE. The session each process drives, by pid; every ambiguity is absence (see the header). */
export function linkOpencodeV2Processes(
  procs: readonly OpencodeProcessRef[],
  sessions: readonly OpencodeV2Session[],
  taken: ReadonlySet<string> = new Set(),
  skewMs: number = START_SKEW_MS,
): Map<number, string> {
  const top = sessions.filter(s => !s.parentId) // a subagent is the parent's work, never the row's conversation
  const candidateOf = new Map<number, string>()
  const claimants = new Map<string, number>()
  for (const p of procs) {
    if (p.startedMs === undefined) continue
    const floor = p.startedMs - skewMs
    const hits = top.filter(s => s.directory === p.cwd && (s.created >= floor || s.updated >= floor)
      && !(p.tty !== false && taken.has(s.id)))
    if (hits.length !== 1) continue
    candidateOf.set(p.pid, hits[0]!.id)
    claimants.set(hits[0]!.id, (claimants.get(hits[0]!.id) ?? 0) + 1)
  }
  const out = new Map<number, string>()
  for (const [pid, id] of candidateOf) if (claimants.get(id) === 1) out.set(pid, id)
  return out
}

// ── IO ──────────────────────────────────────────────────────────────────────────────────────

/** Is the store at `dbPath` a 2.x one (has `session_v2`), or is a 2.x service record live? */
export function isOpencodeV2(dbPath: string, stateDir: string): boolean {
  if (existsSync(join(stateDir, 'service.json'))) return true
  if (!existsSync(dbPath)) return false
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    return db.query("SELECT 1 FROM sqlite_master WHERE name = 'session_v2'").get() !== null
  } catch { return false } finally { db?.close() }
}

/** What the last read of the service said, for the health check. `null` until a read was attempted. */
export interface OpencodeV2Status { reachable: boolean; at: number; reason?: string }
let lastStatus: OpencodeV2Status | null = null
export const opencodeV2Status = (): OpencodeV2Status | null => lastStatus
export function resetOpencodeV2(): void { lastStatus = null; caches.clear() }

const caches = new Map<string, { at: number; value: unknown }>()

async function getJson(service: OpencodeV2Service, path: string, f: FetchLike): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), V2_TIMEOUT_MS)
  ;(timer as { unref?: () => void }).unref?.()
  try {
    const res = await f(`${service.url}${path}`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}`, accept: 'application/json' },
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`HTTP error on ${path}`)
    return await res.json()
  } finally { clearTimeout(timer) }
}

async function cached<T>(key: string, ttl: number, now: number, load: () => Promise<T>): Promise<T> {
  const hit = caches.get(key)
  if (hit && now - hit.at < ttl) return hit.value as T
  const value = await load()
  caches.set(key, { at: now, value })
  return value
}

export interface V2Io { stateDir: string; fetch?: FetchLike; now?: () => number }

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>

function fail(reason: string, now: number): null { lastStatus = { reachable: false, at: now, reason }; return null }

async function withService<T>(io: V2Io, key: string, load: (s: OpencodeV2Service, f: FetchLike) => Promise<T>): Promise<T | null> {
  const now = (io.now ?? Date.now)()
  // A service that just failed is not asked again for one TTL: a hung one must not cost 3 s on every fleet poll.
  if (lastStatus && !lastStatus.reachable && now - lastStatus.at < V2_CACHE_TTL_MS) return null
  let service: OpencodeV2Service | null = null
  try { service = parseServiceRecord(readFileSync(join(io.stateDir, 'service.json'), 'utf8')) } catch { /* absent */ }
  if (!service) return fail('service.json absent', now)
  try {
    const value = await cached(`${service.url}|${key}`, V2_CACHE_TTL_MS, now, () => load(service!, io.fetch ?? defaultFetch))
    lastStatus = { reachable: true, at: now }
    return value
  } catch (e) { return fail(e instanceof Error ? e.message : 'unreachable', now) }
}

/** Every session of every project (newest first, paged until a short page). null: service unreachable. */
export function readOpencodeV2Sessions(io: V2Io): Promise<OpencodeV2Session[] | null> {
  const PAGE = 200
  return withService(io, 'sessions', async (svc, f) => {
    const all: OpencodeV2Session[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 50; guard++) {
      const q = new URLSearchParams({ order: 'desc', limit: String(PAGE), ...(cursor ? { cursor } : {}) })
      const body = await getJson(svc, `/api/session?${q}`, f)
      const page = parseSessions(body)
      all.push(...page)
      const rawLen = isObj(body) && Array.isArray(body.data) ? body.data.length : 0
      const next = isObj(body) && isObj(body.cursor) && typeof body.cursor.next === 'string' ? body.cursor.next : undefined
      if (rawLen < PAGE || !next || next === cursor) break
      cursor = next
    }
    return all
  })
}

/** Ids with a running turn. null: service unreachable. */
export function readOpencodeV2Active(io: V2Io): Promise<Set<string> | null> {
  return withService(io, 'active', async (svc, f) => parseActive(await getJson(svc, '/api/session/active', f)))
}

/** `working` for a running turn, `waiting` otherwise, null when the service cannot say. */
export async function opencodeV2Activity(sessionId: string, io: V2Io): Promise<'working' | 'waiting' | null> {
  const active = await readOpencodeV2Active(io)
  return active ? (active.has(sessionId) ? 'working' : 'waiting') : null
}

/** The session each process drives through the service. Empty when it cannot be read. */
export async function readOpencodeV2ProcessSessions(procs: readonly OpencodeProcessRef[], io: V2Io, taken: ReadonlySet<string> = new Set()): Promise<Map<number, string>> {
  if (procs.length === 0) return new Map()
  const sessions = await readOpencodeV2Sessions(io)
  return sessions ? linkOpencodeV2Processes(procs, sessions, taken) : new Map()
}
