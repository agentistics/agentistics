/**
 * opencode-v2.ts: OpenCode 2.x read through its OFFICIAL interface, the background service's HTTP API.
 *
 * 2.x renamed every table (`session` → `session_v2`, `message` → `session_message`, parts folded into the
 * message) and copied the 1.x rows into the new tables, leaving the old ones frozen. Internals change between
 * versions; the API is what opencode's own CLI and TUI use. MEASURED on 2.2.5 (private HOME, stub provider):
 * - discovery: `$XDG_STATE_HOME/opencode/service.json` = `{id, version, url, pid, password}`; HTTP Basic, user `opencode`;
 * - `GET /api/session?order=desc&limit&cursor` lists EVERY session of every project; `cursor.next` is present even
 *   on the last page, so a page shorter than `limit` ends the walk;
 * - `GET /api/session/{id}/message?order=asc` returns typed messages (user / assistant with tokens, cost, model).
 * The service is never started from here (the engine does that); a missing or silent service is reported.
 *
 * `rowsOfV2Messages` turns 2.x messages into the 1.x row shape, so ONE `parseOpencodeSession` computes tokens, cost
 * route, active time and context for both generations. OpenCode's own `cost` is never read.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '@agentistics/core'
import { createFileMemo, registerMemo } from './file-memo'
import { parseOpencodeSession, type OpencodeMessageRow, type OpencodeModels, type OpencodePartRow, type OpencodeSessionRow } from './opencode-parse'

export interface OpencodeService { url: string; password: string; pid?: number; version?: string }

const set = (v: string | undefined): string | undefined => (v !== undefined && v !== '' ? v : undefined)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Where the 2.x service writes its live record for the account whose store is `dbPath`. */
export function opencodeStateDirFor(dbPath: string | undefined, env: Readonly<Record<string, string | undefined>> = {}, home: string = homedir()): string {
  const xdg = set(env.XDG_STATE_HOME)
  if (xdg) return join(xdg, 'opencode')
  const m = dbPath ? /^(.*)\/\.local\/share\/opencode\/[^/]+$/.exec(dbPath) : null
  if (m && m[1]) return join(m[1], '.local', 'state', 'opencode')
  return join(set(env.HOME) ?? home, '.local', 'state', 'opencode')
}

export function parseServiceRecord(raw: string): OpencodeService | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    if (typeof j.url !== 'string' || typeof j.password !== 'string' || j.url === '') return null
    return {
      url: j.url.replace(/\/+$/, ''), password: j.password,
      ...(typeof j.pid === 'number' ? { pid: j.pid } : {}),
      ...(typeof j.version === 'string' ? { version: j.version } : {}),
    }
  } catch { return null }
}

export function readServiceRecord(stateDir: string): OpencodeService | null {
  try { return parseServiceRecord(readFileSync(join(stateDir, 'service.json'), 'utf8')) } catch { return null }
}

export type OpencodeGeneration = 'v1' | 'v2' | 'unknown'

/** The tables of the store, read read-only. `null` when the file cannot be opened as SQLite. */
export function opencodeTables(path: string): Set<string> | null {
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    return new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name))
  } catch { return null } finally { db?.close() }
}

/** `session_v2` wins even when the frozen 1.x tables are still there: they only hold pre-upgrade sessions. */
export function generationOfTables(tables: ReadonlySet<string>): OpencodeGeneration {
  if (tables.has('session_v2')) return 'v2'
  if (tables.has('session') && tables.has('message') && tables.has('part')) return 'v1'
  return 'unknown'
}

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>

export class OpencodeServiceError extends Error {}

export interface V2Session { id: string; directory: string; title: string; created: number; updated: number }
export type V2Message = Record<string, unknown> & { id: string; type: string }

export function parseV2Session(v: unknown): V2Session | null {
  if (!isObj(v) || typeof v.id !== 'string') return null
  const time = isObj(v.time) ? v.time : {}, loc = isObj(v.location) ? v.location : {}
  const created = numOr(time.created, 0)
  return {
    id: v.id, directory: typeof loc.directory === 'string' ? loc.directory : '',
    title: typeof v.title === 'string' ? v.title : '', created, updated: numOr(time.updated, created),
  }
}

export interface OpencodeV2Client {
  info(): Promise<unknown>
  sessions(): Promise<V2Session[]>
  messages(id: string): Promise<V2Message[]>
}

const PAGE = 200

export function createOpencodeV2Client(service: OpencodeService, o: { fetch?: Fetch; timeoutMs?: number } = {}): OpencodeV2Client {
  const f: Fetch = o.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<Fetch>)
  const auth = `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}`
  async function get(path: string): Promise<unknown> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8_000)
    try {
      const res = await f(`${service.url}${path}`, { headers: { authorization: auth, accept: 'application/json' }, signal: ctl.signal })
      if (!res.ok) throw new OpencodeServiceError(`HTTP ${res.status} from ${path.split('?')[0]}`)
      return await res.json()
    } catch (err) {
      if (err instanceof OpencodeServiceError) throw err
      throw new OpencodeServiceError(`${(err as Error).message || 'no answer'} (${service.url})`)
    } finally { clearTimeout(timer) }
  }
  async function paged(path: string): Promise<unknown[]> {
    const out: unknown[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 500; guard++) {
      const q = new URLSearchParams({ order: path.includes('/message') ? 'asc' : 'desc', limit: String(PAGE), ...(cursor ? { cursor } : {}) })
      const j = await get(`${path}?${q}`) as { data?: unknown; cursor?: { next?: unknown } } | null
      const page = Array.isArray(j?.data) ? j!.data as unknown[] : []
      out.push(...page)
      const next = typeof j?.cursor?.next === 'string' ? j.cursor.next : undefined
      if (page.length < PAGE || !next || next === cursor) break // `next` is present even on the last page
      cursor = next
    }
    return out
  }
  return {
    info: () => get('/api/info'),
    async sessions() { return (await paged('/api/session')).map(parseV2Session).filter((s): s is V2Session => s !== null) },
    async messages(id) { return (await paged(`/api/session/${encodeURIComponent(id)}/message`)).filter(isObj).filter((m): m is V2Message => typeof m.id === 'string' && typeof m.type === 'string') },
  }
}

/** 2.x messages → the 1.x message/part rows `parseOpencodeSession` reads. Unknown types are skipped, never thrown on. */
export function rowsOfV2Messages(sessionId: string, msgs: readonly V2Message[]): { messages: OpencodeMessageRow[]; parts: OpencodePartRow[] } {
  const messages: OpencodeMessageRow[] = [], parts: OpencodePartRow[] = []
  for (const m of msgs) {
    const time = isObj(m.time) ? m.time : {}
    const created = numOr(time.created, 0)
    if (m.type === 'user') {
      messages.push({ id: m.id, session_id: sessionId, time_created: created, time_updated: created, data: JSON.stringify({ role: 'user', time: { created } }) })
      if (typeof m.text === 'string' && m.text !== '') {
        parts.push({ id: `${m.id}:0`, message_id: m.id, session_id: sessionId, time_created: created, data: JSON.stringify({ type: 'text', text: m.text }) })
      }
      continue
    }
    if (m.type !== 'assistant') continue
    const completed = typeof time.completed === 'number' ? time.completed : undefined
    const model = isObj(m.model) ? m.model : {}
    const err = isObj(m.error) ? m.error : null
    messages.push({
      id: m.id, session_id: sessionId, time_created: created, time_updated: completed ?? created,
      data: JSON.stringify({
        role: 'assistant', time: { created, ...(completed !== undefined ? { completed } : {}) },
        ...(typeof model.id === 'string' ? { modelID: model.id } : {}),
        ...(typeof model.providerID === 'string' ? { providerID: model.providerID } : {}),
        ...(isObj(m.tokens) ? { tokens: m.tokens } : {}),
        ...(typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost >= 0 ? { cost: m.cost } : {}),
        ...(typeof m.finish === 'string' && m.finish !== 'error' ? { finish: m.finish } : {}),
        ...(err || m.finish === 'error' ? { error: { name: 'error' } } : {}),
      }),
    })
  }
  return { messages, parts }
}

const sessionMemo = registerMemo(createFileMemo<SessionMeta | null>(20_000))

/** Runs `fn` over `items` with at most `n` in flight. */
async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!) }
  }))
  return out
}

/**
 * 2.x sessions through the API. Throws `OpencodeServiceError` when the service does not answer. A session
 * is re-fetched only when its `time.updated` (or the models cache) changed.
 */
export async function loadOpencodeV2(service: OpencodeService, models: OpencodeModels = {}, modelsVersion = '', client = createOpencodeV2Client(service)): Promise<SessionMeta[]> {
  await client.info()
  const list = await client.sessions()
  const metas = await pool(list, 6, s => sessionMemo.get(`${service.url}#${s.id}`, `${s.updated}|${modelsVersion}`, async () => {
    const { messages, parts } = rowsOfV2Messages(s.id, await client.messages(s.id))
    const row: OpencodeSessionRow = { id: s.id, directory: s.directory, title: s.title, time_created: s.created, time_updated: s.updated }
    return parseOpencodeSession(row, messages, parts, models)
  }))
  return metas.filter((m): m is SessionMeta => m !== null)
}

export function hasOpencodeDb(path: string): boolean { return existsSync(path) }
