/**
 * tags-handlers.ts — /api/tags routes.
 *
 * Responses carry AGGREGATES ONLY: counts and sums per tag, never the session rows behind it.
 *
 * Aggregation runs against the machine's own full session set (`/api/data`'s build, which has its
 * own stale-while-revalidate cache), server-side, so the browser never needs the rows.
 *
 * One person, one machine: `machine` sources need an id local sessions do not carry, so the
 * instance exposes exactly ONE machine — this one — under the id below, and every local session is
 * rewritten to belong to it.
 */
import { localTagStore, type TagDoc } from './tags-local-store'
import { resolveTagSessions, TAG_SOURCE_TYPES, type TagSource, type TagSourceType, type TagWindow } from './tags-resolve'
import { aggregateSessions, type TagAggregate } from './tags-aggregate'
import { aggregateTagDetail } from './tags-detail'
import type { SessionMeta } from '@agentistics/core'

/** The single machine this instance knows about. */
export const LOCAL_MACHINE_ID = 'local'

const JSON_CT = { 'Content-Type': 'application/json' } as const
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_CT })
}

const SOURCE_TYPES = new Set<string>(TAG_SOURCE_TYPES)

// ---------------------------------------------------------------------------
// Session cache — stale-while-revalidate, same shape and TTL as the /api/data cache in data.ts.
//
// Every tags route needs the whole session set (aggregates are computed here, never in the
// browser). The set is served from memory and refreshed in the BACKGROUND once older than the TTL,
// so a newly written session shows up within a request or two of the TTL elapsing, but no caller
// ever waits for the read. Tag numbers are historical aggregates; they do not need to be
// sub-second fresh. The very first request after a boot is the only one that blocks.
// ---------------------------------------------------------------------------

const SESSIONS_TTL_MS = 30_000

let _sessions: Promise<SessionMeta[]> | null = null
let _sessionsAt = 0
let _refreshing = false

/** The machine's own sessions, straight from the /api/data build — which already has its own
 *  stale-while-revalidate cache, so this adds no second scan of ~/.claude. Sessions are shallow-
 *  copied with the synthetic `local` memberId so a `machine` source resolves; copying (rather than
 *  stamping in place) keeps the cached objects /api/data serves untouched.
 *
 *  The stamp is UNCONDITIONAL: there is by definition exactly one machine, so every session visible
 *  here belongs to it. Preserving a memberId that is already set would silently drop sessions from
 *  `machine:local`, because tags-resolve matches a machine source by exact memberId equality. */
export function stampLocalMachine(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.map(s => ({ ...s, memberId: LOCAL_MACHINE_ID }))
}

async function loadLocalSessions(): Promise<SessionMeta[]> {
  const { buildApiResponse } = await import('./data')
  const res = await buildApiResponse()
  return stampLocalMachine(res.sessions)
}

function loadSessionSet(): Promise<SessionMeta[]> { return loadLocalSessions() }

/** Swap in a fresh set when it arrives; on failure keep serving the previous good one. */
function refreshSessionsInBackground(): void {
  if (_refreshing) return
  _refreshing = true
  void loadSessionSet()
    .then(fresh => { _sessions = Promise.resolve(fresh); _sessionsAt = Date.now() })
    .catch(() => { /* keep the previous result */ })
    .finally(() => { _refreshing = false })
}

/** All sessions this instance knows about. Aggregates are computed here and only numbers leave. */
async function loadAllSessions(): Promise<SessionMeta[]> {
  if (_sessions) {
    if (Date.now() - _sessionsAt >= SESSIONS_TTL_MS) refreshSessionsInBackground()
    return _sessions
  }
  // First load — the only path that blocks. Concurrent callers join the same promise; a failed
  // load is dropped so the next request retries instead of caching the error forever.
  const pending = loadSessionSet()
  _sessions = pending
  pending.then(
    () => { _sessionsAt = Date.now() },
    () => { if (_sessions === pending) _sessions = null },
  )
  return pending
}

function withAggregate(tag: TagDoc, sessions: SessionMeta[]): TagDoc & { aggregate: TagAggregate } {
  const resolved = resolveTagSessions(sessions, tag.sources, tag.filters ?? [], tag.window)
  return { ...tag, aggregate: aggregateSessions(resolved) }
}

function parseSources(raw: unknown): TagSource[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is { type: string; value: string } =>
      !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string'
      && typeof (x as { value?: unknown }).value === 'string')
    .filter(x => SOURCE_TYPES.has(x.type) && x.value.length > 0)
    .map(x => ({ type: x.type as TagSourceType, value: x.value }))
}

/** A source of a type this instance does not offer (`team`, `account`, `user`) would store a source
 *  that can only ever resolve to zero sessions — a tag that looks broken. Refuse it loudly. */
function badSourceType(raw: unknown): Response | null {
  if (!Array.isArray(raw)) return null
  for (const x of raw) {
    const t = x && typeof x === 'object' ? (x as { type?: unknown }).type : undefined
    if (typeof t === 'string' && !SOURCE_TYPES.has(t)) return json({ error: `source type "${t}" is not available on this instance` }, 400)
  }
  return null
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** The client injects `color` straight into an inline CSS background. An unvalidated string there
 *  is an outbound-request primitive — `url(https://attacker/x)` would beacon every viewer of the
 *  tag. Accept a literal hex colour and nothing else. `undefined` means "not provided". */
function parseColor(raw: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false }
  const v = raw.trim()
  if (!v) return { ok: true, value: undefined }
  return HEX_COLOR.test(v) ? { ok: true, value: v } : { ok: false }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** `yyyy-MM-dd` AND a real calendar day. The regex alone accepts 2026-02-31, which `Date` then
 *  rolls forward to 3 March — a window silently one to three days wider than the one written. */
function isCalendarDay(v: string): boolean {
  if (!DAY_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/**
 * Parse the optional period. `undefined` = field absent (leave alone); `null` = explicitly cleared.
 *
 * An empty string on either end clears THAT end, so the UI can drop one side without having to
 * send a differently-shaped body, and a window that ends up with neither end set collapses to
 * `null` rather than being stored as a `{}` that reads as "has a window" everywhere downstream.
 */
export function parseWindow(raw: unknown):
  { ok: true; value: TagWindow | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'window must be an object' }
  const w = raw as Record<string, unknown>
  const read = (k: 'start' | 'end'): string | undefined | false => {
    const v = w[k]
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string' || !isCalendarDay(v.trim())) return false
    return v.trim()
  }
  const start = read('start')
  const end = read('end')
  if (start === false || end === false) {
    return { ok: false, error: 'window dates must be calendar days in YYYY-MM-DD' }
  }
  if (!start && !end) return { ok: true, value: null }
  if (start && end && start > end) return { ok: false, error: 'window start must not be after end' }
  return { ok: true, value: { ...(start ? { start } : {}), ...(end ? { end } : {}) } }
}

export async function handleTags(req: Request): Promise<Response> {
  const { getTag, createTag, updateTag, deleteTag, listAllTags } = localTagStore

  const url = new URL(req.url)
  const idFromPath = url.pathname.startsWith('/api/tags/')
    ? decodeURIComponent(url.pathname.slice('/api/tags/'.length))
    : ''

  // GET /api/tags/:id — one tag with its aggregate, a per-source breakdown AND the deep stats
  // (projects / models / harnesses / repos / machines, daily series, activity window).
  if (req.method === 'GET' && idFromPath) {
    const tag = await getTag(idFromPath)
    if (!tag) return json({ error: 'tag not found' }, 404)
    const sessions = await loadAllSessions()
    // The period applies to the per-source breakdown too — otherwise the parts of a windowed tag
    // add up to more than the whole it is shown next to.
    const resolved = resolveTagSessions(sessions, tag.sources, tag.filters ?? [], tag.window)
    const breakdown = tag.sources.map(src => ({
      source: src,
      aggregate: aggregateSessions(resolveTagSessions(sessions, [src], tag.filters ?? [], tag.window)),
    }))
    return json({
      tag: { ...tag, aggregate: aggregateSessions(resolved) },
      breakdown,
      stats: aggregateTagDetail(resolved),
    })
  }

  if (req.method === 'GET') {
    const sessions = await loadAllSessions()
    const tags = await listAllTags()
    return json({ tags: tags.map(t => withAggregate(t, sessions)) })
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return json({ error: 'invalid body' }, 400)

  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
    return json({ error: 'method not allowed' }, 405)
  }

  if (req.method === 'POST') {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: 'name is required' }, 400)
    const color = parseColor(body.color)
    if (!color.ok) return json({ error: 'color must be a hex colour (#rgb or #rrggbb)' }, 400)
    const badType = badSourceType(body.sources) ?? badSourceType(body.filters)
    if (badType) return badType
    const sources = parseSources(body.sources)
    const filters = parseSources(body.filters)
    const window = parseWindow(body.window)
    if (!window.ok) return json({ error: window.error }, 400)
    const doc = await createTag({
      name,
      color: color.value,
      sources,
      filters,
      window: window.value ?? undefined,
    })
    // The stored document, with no aggregate: a write must not pay for aggregation. The client
    // reloads the list right after saving, and that is where the numbers come from.
    return json({ tag: doc })
  }

  if (req.method === 'PATCH') {
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return json({ error: 'id is required' }, 400)
    const existing = await getTag(id)
    if (!existing) return json({ error: 'tag not found' }, 404)
    // POST rejects an empty name; so must PATCH, or a tag can be blanked after the fact.
    let name: string | undefined
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return json({ error: 'name is required' }, 400)
      name = body.name.trim()
    }
    const color = parseColor(body.color)
    if (!color.ok) return json({ error: 'color must be a hex colour (#rgb or #rrggbb)' }, 400)
    const badType = (body.sources !== undefined ? badSourceType(body.sources) : null)
      ?? (body.filters !== undefined ? badSourceType(body.filters) : null)
    if (badType) return badType
    const window = parseWindow(body.window)
    if (!window.ok) return json({ error: window.error }, 400)
    await updateTag(id, {
      name,
      color: color.value,
      sources: body.sources !== undefined ? parseSources(body.sources) : undefined,
      filters: body.filters !== undefined ? parseSources(body.filters) : undefined,
      window: window.value,
    })
    return json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return json({ error: 'id is required' }, 400)
    const existing = await getTag(id)
    if (!existing) return json({ error: 'tag not found' }, 404)
    await deleteTag(id)
    return json({ ok: true })
  }

  return json({ error: 'method not allowed' }, 405)
}
