/**
 * tags-handlers.ts — /api/tags routes for B5.
 *
 * Two invariants from the spec, enforced here and nowhere else:
 *   Rule 1 — a principal may create/edit a tag only if it can see EVERY source (canWriteTagSources).
 *   Rule 2 — responses carry AGGREGATES ONLY. The session rows behind a tag are never returned,
 *            which is what lets a grantee see full numbers for sources outside their team scope
 *            without that becoming a way to read those sessions.
 *
 * Aggregation runs against the UNSCOPED session set on purpose: /api/data is team-scoped, so a
 * browser-side computation could not produce a grantee's full numbers without being sent rows it
 * must not see.
 *
 * Rule 2 covers the KEYS as well as the numbers. `visibleRepos` / `visibleProjects` are inferred
 * from sessions the caller can see, but resolution then matches that value across the unscoped set
 * — so a single own session on a shared remote yields org-wide totals for it. That is intended for
 * the numbers and unacceptable for the names, since a project path routinely encodes a client. So
 * every breakdown leaving here runs through redactBuckets/redactTopValue: unseeable keys merge into
 * one anonymous "other" bucket that keeps the totals whole.
 */
import { localTagStore, type TagDoc, type TagStore } from './tags-local-store'
import { resolveTagSessions, type TagSource, type TagSourceType, type TagLookups, type TagWindow } from './tags-resolve'
import { aggregateSessions, type TagAggregate } from './tags-aggregate'
import { aggregateTagDetail, type TagDetailStats, type TagBucket } from './tags-detail'
import type { SessionMeta } from '@agentistics/core'
type Principal = { accountId: string; role: 'owner'; memberships: never[] }
type AccountDoc = { _id: string; memberships: never[] }
type MachineInfo = { id: string; machineName: string; user: string; accountIds?: string[]; teamIds?: string[]; effectiveTeamIds?: string[]; inheritedTeamIds?: string[]; excludedTeamIds?: string[]; createdAt?: string; lastSeenAt?: string | null }
type TagVisibilityBucket = TagBucket
type TagAuthorityContext = { visibleProjects: Set<string>; visibleRepos: Set<string>; visibleMachineIds: Set<string> }
const can = (_p: Principal, capability: string) => capability === 'tags:write'
const canReadTag = (_p: Principal, _tag: TagDoc, _ctx: TagAuthorityContext) => true
const canWriteTagSources = (_p: Principal, _sources: TagSource[], _ctx: TagAuthorityContext) => true
const redactTopValue = (_p: Principal, value: string | null, _visible: Set<string>) => value
const redactSources = (_p: Principal, sources: TagSource[], _ctx: TagAuthorityContext) => sources
const redactBuckets = (_p: Principal, buckets: TagVisibilityBucket[], _visible: Set<string>) => buckets

// Everything Mongo- or IAM-backed is imported LAZILY, inside the central-only paths. A solo
// instance serves the same routes from local files and must never load — let alone reach — the
// Mongo driver or the accounts collection.
// ---------------------------------------------------------------------------
// Solo / member mode
//
// There is no IAM here: one person, one machine, nothing to hide from. So the handler runs with a
// synthetic OWNER principal, which short-circuits canSeeSource / canWriteTagSources / canReadTag
// and makes every redaction a no-op — the correct outcome, since redaction exists to keep one
// account from reading another's identifying strings and there is only one account.
//
// `machine` sources: local sessions usually carry no memberId (that id is minted by a central when
// a machine is enrolled), so a machine source would match nothing. Rather than let the category
// silently produce an empty tag, a solo instance exposes exactly ONE machine — this one — under
// the id below, and every local session is REwritten to belong to it. The stamp is unconditional
// precisely because some sessions do carry an id: ones revived from ~/.agentistics/sessions after
// this machine was enrolled and then reverted to solo keep the central-minted value, and honouring
// it would drop them from `machine:local` — the only machine source solo mode offers. `team` and `account` have
// no local meaning at all and are rejected outright (400) instead of resolving to nothing.
// ---------------------------------------------------------------------------

/** The single machine a non-central instance knows about. */
export const LOCAL_MACHINE_ID = 'local'
const SOLO_PRINCIPAL: Principal = { accountId: LOCAL_MACHINE_ID, role: 'owner', memberships: [] }
/** Source types that mean nothing without IAM. Refused with a 400 on a non-central instance. */
const CENTRAL_ONLY_SOURCE_TYPES = new Set<TagSourceType>(['team', 'account'])

const JSON_CT = { 'Content-Type': 'application/json' } as const
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_CT })
}

const SOURCE_TYPES = new Set<TagSourceType>(['repo', 'project', 'machine', 'team', 'account', 'harness', 'model', 'user'])

/** A machine bucket carries its display name alongside the opaque memberId the key stays. */
type LabelledBucket = TagVisibilityBucket & { label?: string }

/** The detail payload: tags-detail's stats with the identifying buckets redacted, plus labels. */
type TagDetailPayload = Omit<TagDetailStats, 'projects' | 'repos' | 'members'> & {
  projects: TagVisibilityBucket[]
  repos: TagVisibilityBucket[]
  members: LabelledBucket[]
}

interface TagContext {
  lookups: TagLookups
  authority: TagAuthorityContext
  machines: MachineInfo[]
  accounts: AccountDoc[]
}

/** Build the account→machines map the resolver needs, plus the visibility context Rule 1 uses.
 *  `sessions` is the unscoped set; repo/project visibility is derived from the subset the caller
 *  can already see, so a manager may tag their own repos and folders but not someone else's. */
async function buildContext(p: Principal, sessions: SessionMeta[]): Promise<TagContext> {
  return soloContext(sessions)
}

/** The solo counterpart of buildContext: no IAM lookups, one synthetic machine, and visibility
 *  sets covering everything the machine has (the owner short-circuit already grants it, but the
 *  context stays truthful on its own so nothing depends on that short-circuit). */
function soloContext(sessions: SessionMeta[]): TagContext {
  const visibleRepos = new Set<string>()
  const visibleProjects = new Set<string>()
  const visibleUsers = new Set<string>()
  for (const s of sessions) {
    if (s.git_remote) visibleRepos.add(s.git_remote)
    if (s.project_path) visibleProjects.add(s.project_path)
    if (s.user) visibleUsers.add(s.user)
  }
  const machine: MachineInfo = {
    id: LOCAL_MACHINE_ID,
    accountIds: [LOCAL_MACHINE_ID],
    machineName: 'This machine',
    user: '',
    teamIds: [],
    // Solo mode has no teams and no accounts, so there is nothing to inherit or exclude.
    effectiveTeamIds: [],
    inheritedTeamIds: [],
    excludedTeamIds: [],
    createdAt: '',
    lastSeenAt: null,
  }
  return {
    lookups: { machinesByAccount: {} },
    machines: [machine],
    accounts: [],
    authority: {
      visibleMachineIds: new Set([LOCAL_MACHINE_ID]),
      visibleRepos,
      visibleProjects,
    },
  }
}

// ---------------------------------------------------------------------------
// Session cache — stale-while-revalidate, same shape and TTL as the /api/data cache in data.ts.
//
// Every tags route needs the whole unscoped session set (Rule 2: aggregates are computed here,
// never in the browser), and reading it is a full-collection round trip. Without a cache each
// request paid it, which is what made a tag list — and worse, saving a tag — take tens of seconds.
//
// The set is served from memory and refreshed in the BACKGROUND once older than the TTL, so a
// newly ingested session shows up within a request or two of the TTL elapsing, but no caller ever
// waits for the read. Tag numbers are historical aggregates; they do not need to be sub-second
// fresh. The very first request after a boot is the only one that blocks.
// ---------------------------------------------------------------------------

const SESSIONS_TTL_MS = 30_000

let _sessions: Promise<SessionMeta[]> | null = null
let _sessionsAt = 0
let _refreshing = false

/** Solo: the machine's own sessions, straight from the /api/data build — which already has its own
 *  stale-while-revalidate cache, so this adds no second scan of ~/.claude. Sessions are shallow-
 *  copied with the synthetic `local` memberId so a `machine` source resolves; copying (rather than
 *  stamping in place) keeps the cached objects /api/data serves untouched.
 *
 *  The stamp is UNCONDITIONAL: off a central there is by definition exactly one machine, so every
 *  session visible here belongs to it. Preserving a memberId that is already set would silently drop
 *  sessions from `machine:local` — the only machine source the solo UI offers — because tags-resolve
 *  matches a machine source by exact memberId equality. Sessions revived from ~/.agentistics/sessions
 *  after this machine was enrolled to a central and then reverted to solo still carry the
 *  central-minted id, and those are exactly the sessions the tag would under-report. */
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

/** All sessions this instance knows about, unscoped. Aggregates are computed here and only numbers
 *  leave. On a central that is the whole team collection; otherwise it is the local machine. */
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

/** `topProject` is a raw project_path picked from the unscoped set — an identifying string, so it
 *  obeys the same rule as the buckets. topModel/topHarness are closed vocabularies and stay. */
function redactAggregate(p: Principal, agg: TagAggregate, ctx: TagAuthorityContext): TagAggregate {
  return { ...agg, topProject: redactTopValue(p, agg.topProject, ctx.visibleProjects) }
}

function withAggregate(p: Principal, tag: TagDoc, sessions: SessionMeta[], ctx: TagContext): TagDoc & { aggregate: TagAggregate } {
  // Resolve against the STORED sources (the real values) but ship the REDACTED list — otherwise the
  // response hands back the same identifying strings the bucket redaction just collapsed.
  const resolved = resolveTagSessions(sessions, tag.sources, ctx.lookups, tag.filters ?? [], tag.window)
  return {
    ...tag,
    sources: redactSources(p, tag.sources, ctx.authority),
    // Filters carry the same kind of identifying strings as sources (a machine id, a project path),
    // so they obey the same rule. Resolution above already used the STORED values.
    ...(tag.filters?.length ? { filters: redactSources(p, tag.filters, ctx.authority) } : {}),
    aggregate: redactAggregate(p, aggregateSessions(resolved), ctx.authority),
  }
}

/** The deep breakdown, redacted key-by-key and with machine hashes given a readable name. */
function detailStats(p: Principal, sessions: SessionMeta[], ctx: TagContext): TagDetailPayload {
  const raw = aggregateTagDetail(sessions)
  const names = new Map(ctx.machines.map(m => [m.id, m.machineName]))
  return {
    ...raw,
    projects: redactBuckets(p, raw.projects, ctx.authority.visibleProjects),
    repos: redactBuckets(p, raw.repos, ctx.authority.visibleRepos),
    // The key stays the memberId so the client can key React rows on a stable id; `label` is what
    // it renders. A collapsed "other" bucket has no machine and therefore no label.
    members: redactBuckets(p, raw.members, ctx.authority.visibleMachineIds).map(b => {
      const label = names.get(b.key)
      return label ? { ...b, label } : { ...b }
    }),
    // People are keyed by the session's `user`, which is a display name — identifying, so it obeys
    // the same rule as the other keys. "Visible" = the person drives a machine this caller can see.
    users: redactBuckets(p, raw.users, visibleUserNames(ctx)),
  }
}

/** Display names of the people behind the machines this caller can see. */
function visibleUserNames(ctx: TagContext): Set<string> {
  const out = new Set<string>()
  for (const m of ctx.machines) {
    if (ctx.authority.visibleMachineIds.has(m.id) && m.user) out.add(m.user)
  }
  return out
}

function parseSources(raw: unknown): TagSource[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is { type: string; value: string } =>
      !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string'
      && typeof (x as { value?: unknown }).value === 'string')
    .filter(x => SOURCE_TYPES.has(x.type as TagSourceType) && x.value.length > 0)
    .map(x => ({ type: x.type as TagSourceType, value: x.value }))
}

/** `team` and `account` are IAM concepts. A non-central instance has neither, so accepting one
 *  would store a source that can only ever resolve to zero sessions — a tag that looks broken.
 *  Refuse it loudly instead. */
function checkSourceTypes(sources: TagSource[]): Response | null {
  const bad = sources.find(s => CENTRAL_ONLY_SOURCE_TYPES.has(s.type))
  if (!bad) return null
  return json({ error: `source type "${bad.type}" is only available on a central instance` }, 400)
}

function parseStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
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

/** Every grantee must be a real account the caller can already see — otherwise `sharedWith` is a
 *  blind account-id oracle, and a manager could grant a tag to someone outside their scope. */
function checkSharedWith(p: Principal, ids: string[], accounts: AccountDoc[]): Response | null {
  const byId = new Map(accounts.map(a => [a._id, a]))
  for (const id of ids) {
    // Granting to YOURSELF would convert the deliberately-expiring creator access into a permanent
    // one: canReadTag short-circuits on sharedWith before it re-checks the sources, so a manager
    // could self-grant, lose the team, and keep reading it forever. An owner is exempt — they read
    // everything regardless, so a self-grant changes nothing for them.
    if (id === p.accountId && p.role !== 'owner') {
      return json({ error: 'cannot grant a tag to yourself' }, 400)
    }
    const account = byId.get(id)
    if (!account) return json({ error: 'unknown account in sharedWith' }, 400)
    if (account._id !== p.accountId) return json({ error: 'forbidden' }, 403)
  }
  return null
}

export async function handleTags(req: Request): Promise<Response> {
  // Central: the cookie-authenticated principal, exactly as before. Solo/member: nobody signs in,
  // so the synthetic single-user owner stands in — see SOLO_PRINCIPAL above.
  const principal = SOLO_PRINCIPAL
  const isOwner = principal.role === 'owner'
  const store: TagStore = localTagStore
  const { getTag, createTag, updateTag, deleteTag, visibleTagsFor } = store

  const url = new URL(req.url)
  const idFromPath = url.pathname.startsWith('/api/tags/')
    ? decodeURIComponent(url.pathname.slice('/api/tags/'.length))
    : ''

  // GET /api/tags/:id — one tag with its aggregate, a per-source breakdown AND the deep stats
  // (projects / models / harnesses / repos / members, daily series, activity window). Still
  // aggregate-only (Rule 2): counts and sums, with unseeable keys collapsed into "other".
  if (req.method === 'GET' && idFromPath) {
    const tag = await getTag(idFromPath)
    // 404 rather than 403 for a non-viewer: a stranger must not learn the tag exists.
    if (!tag) return json({ error: 'tag not found' }, 404)
    const sessions = await loadAllSessions()
    const ctx = await buildContext(principal, sessions)
    if (!canReadTag(principal, tag, ctx.authority)) return json({ error: 'tag not found' }, 404)
    // The period applies to the per-source breakdown too — otherwise the parts of a windowed tag
    // add up to more than the whole it is shown next to.
    const resolved = resolveTagSessions(sessions, tag.sources, ctx.lookups, tag.filters ?? [], tag.window)
    // Same rule as withAggregate: resolve on the real source, report the redacted one.
    const breakdown = tag.sources.map(src => ({
      source: redactSources(principal, [src], ctx.authority)[0]!,
      aggregate: redactAggregate(principal, aggregateSessions(
        resolveTagSessions(sessions, [src], ctx.lookups, tag.filters ?? [], tag.window)), ctx.authority),
    }))
    return json({
      // `resolved` is exactly what withAggregate would re-derive — reuse it rather than walking
      // the unscoped set a second time.
      tag: {
        ...tag,
        sources: redactSources(principal, tag.sources, ctx.authority),
        ...(tag.filters?.length ? { filters: redactSources(principal, tag.filters, ctx.authority) } : {}),
        aggregate: redactAggregate(principal, aggregateSessions(resolved), ctx.authority),
      },
      breakdown,
      stats: detailStats(principal, resolved, ctx),
    })
  }

  if (req.method === 'GET') {
    const sessions = await loadAllSessions()
    const ctx = await buildContext(principal, sessions)
    const tags = await visibleTagsFor(t => canReadTag(principal, t, ctx.authority))
    return json({ tags: tags.map(t => withAggregate(principal, t, sessions, ctx)) })
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return json({ error: 'invalid body' }, 400)

  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
    return json({ error: 'method not allowed' }, 405)
  }
  // Every write needs the capability, not just POST — otherwise a demoted manager keeps editing
  // and deleting the tags they made while they still had it.
  if (!can(principal, 'tags:write')) return json({ error: 'forbidden' }, 403)

  if (req.method === 'POST') {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: 'name is required' }, 400)
    const color = parseColor(body.color)
    if (!color.ok) return json({ error: 'color must be a hex colour (#rgb or #rrggbb)' }, 400)
    const sources = parseSources(body.sources)
    const filters = parseSources(body.filters)
    const badType = checkSourceTypes(sources) ?? checkSourceTypes(filters)
    if (badType) return badType
    // The period only ever narrows, so it is NOT part of the Rule 1 source check below: it cannot
    // reach anything the sources do not already cover, and it names nothing identifying.
    const window = parseWindow(body.window)
    if (!window.ok) return json({ error: window.error }, 400)
    // Sharing needs accounts to share WITH; a non-central instance has none, so the field is
    // ignored rather than validated (the UI does not offer it either).
    const sharedWith: string[] = []
    const sessions = await loadAllSessions()
    const ctx = await buildContext(principal, sessions)
    // Filters obey Rule 1 too. They only ever narrow, but a filter the caller cannot see would let
    // them probe for it: add it, watch the total move, and learn that the machine or project exists.
    if (!canWriteTagSources(principal, [...sources, ...filters], ctx.authority)) {
      return json({ error: 'forbidden' }, 403)
    }
    const bad = checkSharedWith(principal, sharedWith, ctx.accounts)
    if (bad) return bad
    const doc = await createTag({
      name,
      color: color.value,
      sources,
      filters,
      window: window.value ?? undefined,
      sharedWith,
      createdBy: principal.accountId,
    })
    // The stored document, with no aggregate: a write must not pay for aggregation. The client
    // reloads the list right after saving, and that is where the numbers come from.
    return json({ tag: doc })
  }

  if (req.method === 'PATCH') {
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return json({ error: 'id is required' }, 400)
    const existing = await getTag(id)
    // 404 for "not yours" as well as "not there": a 403 would confirm the id exists, turning an
    // authed stranger's guesses into a tag-id enumeration oracle.
    if (!existing) return json({ error: 'tag not found' }, 404)
    if (!isOwner && existing.createdBy !== principal.accountId) return json({ error: 'tag not found' }, 404)
    // POST rejects an empty name; so must PATCH, or a tag can be blanked after the fact.
    let name: string | undefined
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return json({ error: 'name is required' }, 400)
      name = body.name.trim()
    }
    const color = parseColor(body.color)
    if (!color.ok) return json({ error: 'color must be a hex colour (#rgb or #rrggbb)' }, 400)
    const ctx = await buildContext(principal, await loadAllSessions())
    // Re-validate on edit: the source list may be changing to something out of scope — and an
    // unchanged list may have drifted out of scope since it was written.
    const nextSources = body.sources !== undefined ? parseSources(body.sources) : existing.sources
    const nextFilters = body.filters !== undefined ? parseSources(body.filters) : (existing.filters ?? [])
    const badType = checkSourceTypes(nextSources) ?? checkSourceTypes(nextFilters)
    if (badType) return badType
    const window = parseWindow(body.window)
    if (!window.ok) return json({ error: window.error }, 400)
    if (!canWriteTagSources(principal, [...nextSources, ...nextFilters], ctx.authority)) {
      return json({ error: 'forbidden' }, 403)
    }
    const sharedWith = body.sharedWith !== undefined ? parseStringList(body.sharedWith) : undefined
    if (sharedWith) {
      const bad = checkSharedWith(principal, sharedWith, ctx.accounts)
      if (bad) return bad
    }
    await updateTag(id, {
      name,
      color: color.value,
      sources: body.sources !== undefined ? nextSources : undefined,
      filters: body.filters !== undefined ? nextFilters : undefined,
      window: window.value,
      sharedWith,
    })
    return json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return json({ error: 'id is required' }, 400)
    const existing = await getTag(id)
    if (!existing) return json({ error: 'tag not found' }, 404)
    if (!isOwner && existing.createdBy !== principal.accountId) return json({ error: 'tag not found' }, 404)
    await deleteTag(id)
    return json({ ok: true })
  }

  return json({ error: 'method not allowed' }, 405)
}
