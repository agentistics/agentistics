/**
 * away.ts — AWAY MODE on this machine: the owner is out, and every session started meanwhile is told
 * so in its briefing (`awayBriefingLines`, @agentistics/core). Stored in `preferences.json` (key
 * `away`) because it is a fact about this machine's fleet, not about a browser.
 *
 * Who may write it: the person (a browser/CLI call, no `session` field) or a VERIFIED session whose
 * stored role is `leader` (the MCP door). A worker is refused — it would be switching off the very
 * instruction that tells it not to ask the owner. Spec: agentistics-workspace/leader/specs/away-mode-spec.md
 */
import { AWAY_OFF, awayActive, awayLiveNotice, normalizeAwayInput, normalizeAwayNotice, parseAwayState, redactSecrets, sessionAwayState, type AwayInputError, type AwayState } from '@agentistics/core'
import { sessionRunning } from '@agentistics/tui/control/session-dimensions'

export interface AwayView { state: AwayState; active: boolean; activeSessions?: number; cooldownMs?: number }

export type AwayReply =
  | ({ ok: true } & AwayView)
  | { ok: false; error: AwayInputError | 'unverified_sender' | 'leader_only'; detail?: string }

export type AwayNoticeReply =
  | { ok: true }
  | { ok: false; error: 'unverified_sender' | 'leader_only' | 'bad_notice' | 'not_away' }

export interface AwayDeps {
  read: () => Promise<unknown>
  write: (state: AwayState) => Promise<void>
  /** Resolves a `session` proof to the managed id it proves, or null. */
  verify: (id: unknown, token: unknown) => Promise<string | null>
  roleOf: (managedId: string) => Promise<'leader' | 'worker' | undefined>
  now: () => number
  /** Raises the owner-facing notification (bell + Nay toast, persisted). */
  notify?: (text: string, from: string) => void
  /** Reaches the sessions already running (see `notifyLiveSessions`). */
  live?: LiveAwayDeps
}

export interface AwaySessionRow {
  id: string
  conversationId?: string
  away?: boolean
  state: string
  running: boolean
}

/** The same active predicate as the fleet/aside, with delivery liveness rechecked. */
export function awaySessionRunning(row: AwaySessionRow): boolean {
  return row.running && sessionRunning(row)
}

export interface LiveAwayDeps {
  rows: () => Promise<readonly AwaySessionRow[]>
  roleOf: (managedId: string, conversationId?: string) => Promise<'leader' | 'worker' | undefined>
  /** Type the text into a running session through the composer's send path. */
  prompt: (id: string, text: string) => Promise<{ ok: boolean }>
  planLimitsInBriefing?: boolean
  patch?: (id: string, away: boolean) => Promise<void>
  /** Clears/sets many flags in ONE registry write; preferred over `patch` in a loop. */
  patchMany?: (ids: readonly string[], away: boolean) => Promise<void>
}

/** State changes are immediate; only prompts wait for quiet and a per-session cooldown. */
export const AWAY_QUIET_MS = 45_000
export const AWAY_COOLDOWN_MS = 5 * 60_000
interface PendingAway {
  before: AwayState | null; after: AwayState | null; role: 'leader' | 'worker' | undefined
  send: (text: string) => Promise<{ ok: boolean; gone?: boolean }>; quietAt: number; planLimits: boolean
  /** Only this session's own flag changed: the notice says "for this session". */
  perSession?: boolean
}
const pendingAway = new Map<string, PendingAway>()
const lastTold = new Map<string, { state: AwayState | null; at: number }>()
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let flushing: Promise<number> | undefined
export function resetAwayLiveDedupe(): void {
  pendingAway.clear(); lastTold.clear()
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = undefined
}
function armAwayNotices(): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  if (!pendingAway.size) { noticeTimer = undefined; return }
  const at = Math.min(...[...pendingAway].map(([id, job]) => Math.max(job.quietAt, (lastTold.get(id)?.at ?? -Infinity) + AWAY_COOLDOWN_MS)))
  noticeTimer = setTimeout(() => { noticeTimer = undefined; void flushAwayNotices(Date.now()) }, Math.max(0, at - Date.now()))
  noticeTimer.unref?.()
}
/**
 * Bounds ONE session's delivery inside a flush. Above `PROMPT_ACK_MS` (4 s) so a slow-but-alive pane
 * is never cut off; a send that outlives it (a dead relay, a hung fleet read) is retried after quiet.
 */
export const AWAY_SEND_TIMEOUT_MS = 8_000
type AwaySent = { ok: boolean; gone?: boolean }
function sendBounded(job: PendingAway, text: string, timeoutMs: number): Promise<AwaySent> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<AwaySent>(resolve => { timer = setTimeout(() => resolve({ ok: false }), timeoutMs) })
  return Promise.race([job.send(text).catch((): AwaySent => ({ ok: false })), timeout]).finally(() => clearTimeout(timer))
}
/**
 * Delivers every due notice IN PARALLEL, each under its own deadline: one dead session must not
 * delay — or, with an unbounded send, block forever — the notices of every session queued after it.
 */
export async function flushAwayNotices(now: number, timeoutMs = AWAY_SEND_TIMEOUT_MS): Promise<number> {
  if (flushing) { await flushing; return flushAwayNotices(now, timeoutMs) }
  flushing = (async () => {
    const due: [string, PendingAway, string][] = []
    for (const [id, job] of pendingAway) {
      const told = lastTold.get(id)
      if (now < job.quietAt || (told && now - told.at < AWAY_COOLDOWN_MS)) continue
      pendingAway.delete(id)
      const notice = awayLiveNotice(told ? told.state : job.before, job.after, false, job.role, now, { planLimitsInBriefing: job.planLimits })
      if (!notice) continue
      due.push([id, job, job.perSession ? forThisSession(notice) : notice])
    }
    const results = await Promise.all(due.map(([, job, text]) => sendBounded(job, text, timeoutMs)))
    let sentCount = 0
    results.forEach((sent, i) => {
      const [id, job] = due[i]!
      if (sent.ok) { lastTold.set(id, { state: job.after, at: now }); sentCount++ }
      else if (!sent.gone && !pendingAway.has(id)) pendingAway.set(id, { ...job, quietAt: now + AWAY_QUIET_MS })
    })
    return sentCount
  })()
  try { return await flushing } finally { flushing = undefined; armAwayNotices() }
}
function forThisSession(text: string): string {
  return text
    .replace(/^\[agentistics · away mode is now (ON|OFF)\]/, '[agentistics · away mode is now $1 for this session]')
    .replace('The owner is back:', 'The owner is back for this session:')
}
function queueAwayNotice(id: string, before: AwayState | null, after: AwayState | null, role: PendingAway['role'], send: PendingAway['send'], now: number, planLimits = false, perSession = false): void {
  const previous = pendingAway.get(id)
  // A global change queued after a per-session one wins the wording: the session hears the global notice.
  pendingAway.set(id, { before: previous ? previous.before : before, after, role, send, quietAt: now + AWAY_QUIET_MS, planLimits, perSession })
  armAwayNotices()
}

/** Snapshot the old own flag before clearing it; global OFF means back everywhere. */
export async function notifyLiveSessions(before: AwayState, after: AwayState, deps: LiveAwayDeps, now: number, exclude?: string): Promise<number> {
  const rows = await deps.rows()
  // Global OFF clears every own flag, running or not — in ONE registry write, not a patch per row.
  const toClear = after.on ? [] : rows.filter(r => r.away).map(r => r.id)
  if (toClear.length) {
    if (deps.patchMany) await deps.patchMany(toClear, false)
    else for (const id of toClear) await deps.patch?.(id, false)
  }
  for (const row of rows) {
    const ownAfter = after.on ? row.away : false
    if (!awaySessionRunning(row)) continue
    if (exclude !== undefined && (row.id === exclude || row.conversationId === exclude)) {
      pendingAway.delete(row.id)
      lastTold.set(row.id, { state: sessionAwayState(after, ownAfter, now), at: now })
      continue
    }
    const role = await deps.roleOf(row.id, row.conversationId).catch(() => undefined)
    queueAwayNotice(row.id, sessionAwayState(before, row.away, now), sessionAwayState(after, ownAfter, now), role,
      async text => {
        const current = (await deps.rows()).find(r => r.id === row.id && awaySessionRunning(r))
        return current ? deps.prompt(row.id, text) : { ok: false, gone: true }
      }, now, deps.planLimitsInBriefing)
  }
  return 0
}

export function awayView(raw: unknown, now: number): AwayView {
  const state = parseAwayState(raw)
  return { state, active: awayActive(state, now) }
}

export async function readAwayView(deps: Pick<AwayDeps, 'read' | 'now'> & Pick<Partial<AwayDeps>, 'live'>): Promise<AwayView> {
  const view = awayView(await deps.read().catch(() => AWAY_OFF), deps.now())
  const live = deps.live
  return { ...view, ...(live ? { activeSessions: (await live.rows()).filter(awaySessionRunning).length, cooldownMs: Math.max(0, ...[...lastTold.values()].map(t => t.at + AWAY_COOLDOWN_MS - deps.now()), ...[...pendingAway.values()].map(j => j.quietAt - deps.now())) } : {}) }
}

// Serialize owner changes across both endpoints: a later explicit session ON must survive OFF.
let awayWrites: Promise<unknown> = Promise.resolve()
function mutateAway<T>(action: () => Promise<T>): Promise<T> {
  const result = awayWrites.then(action)
  awayWrites = result.catch(() => {})
  return result
}
export function setAway(body: unknown, deps: AwayDeps): Promise<AwayReply> {
  return mutateAway(() => setAwayMutation(body, deps))
}
async function setAwayMutation(body: unknown, deps: AwayDeps): Promise<AwayReply> {
  const o = (body && typeof body === 'object' ? body : {}) as { session?: { id?: unknown; token?: unknown } }
  let sender: string | undefined
  if (o.session !== undefined) {
    sender = await deps.verify(o.session?.id, o.session?.token) ?? undefined
    if (!sender) return { ok: false, error: 'unverified_sender' }
    if ((await deps.roleOf(sender)) !== 'leader') return { ok: false, error: 'leader_only' }
  }
  const now = deps.now()
  const n = normalizeAwayInput(body, now)
  if (!n.ok) return { ok: false, error: n.error, ...(n.detail !== undefined ? { detail: n.detail } : {}) }
  const before = parseAwayState(await deps.read().catch(() => AWAY_OFF))
  await deps.write(n.state)
  if (deps.live) await notifyLiveSessions(before, n.state, deps.live, now, sender)
  return { ok: true, ...awayView(n.state, now) }
}

/**
 * A LEADER's notice to the owner while away — the warning or decision that cannot wait, delivered
 * without blocking the turn on a question. Only a verified leader, only while away is active.
 */
export async function sendAwayNotice(body: unknown, deps: AwayDeps): Promise<AwayNoticeReply> {
  const o = (body && typeof body === 'object' ? body : {}) as { text?: unknown; session?: { id?: unknown; token?: unknown } }
  const sender = await deps.verify(o.session?.id, o.session?.token)
  if (!sender) return { ok: false, error: 'unverified_sender' }
  if ((await deps.roleOf(sender)) !== 'leader') return { ok: false, error: 'leader_only' }
  const text = normalizeAwayNotice(o.text)
  if (text === null) return { ok: false, error: 'bad_notice' }
  if (!awayActive(parseAwayState(await deps.read().catch(() => AWAY_OFF)), deps.now())) return { ok: false, error: 'not_away' }
  deps.notify?.(redactSecrets(text), sender)
  return { ok: true }
}

export function awayStatus(r: AwayReply | AwayNoticeReply): number {
  if (r.ok) return 200
  if (r.error === 'not_away') return 409
  return r.error === 'unverified_sender' || r.error === 'leader_only' ? 403 : 400
}

/** Keep registry-only rows for flag cleanup, but never infer liveness from a missing endedAt. */
export function awaySessionRows(
  registry: readonly { id: string; conversationId?: string; away?: boolean; endedAt?: string }[],
  fleet: readonly { id: string; conversationId?: string; away?: boolean; state: string }[],
): AwaySessionRow[] {
  const byId = new Map(fleet.map(row => [row.id, row]))
  const registered = new Set(registry.map(row => row.id))
  return [
    ...registry.map(row => {
      const current = byId.get(row.id)
      return {
        id: row.id, conversationId: row.conversationId, away: row.away,
        state: current?.state ?? 'lost',
        running: !row.endedAt && current !== undefined && sessionRunning(current),
      }
    }),
    ...fleet.filter(row => !registered.has(row.id)).map(row => ({ ...row, running: sessionRunning(row) })),
  ]
}

async function liveRows(): Promise<AwaySessionRow[]> {
  const { readRegistry } = await import('./sessions/registry')
  const { hostForFleet } = await import('./sessions/fleet-web')
  const host = await hostForFleet('en')
  if (!host.sessions) throw new Error('Fleet sessions unavailable')
  const [registry, fleet] = await Promise.all([readRegistry(), host.sessions()])
  return awaySessionRows(registry, fleet.sessions)
}
async function liveRoleOf(id: string, conversationId?: string) {
  const { storedRoleFor } = await import('./sessions/session-roles')
  return storedRoleFor([conversationId, id])
}
async function livePrompt(id: string, text: string) {
  const { runFleetAction } = await import('./sessions/fleet-web')
  const out = await runFleetAction('en', { action: 'prompt', id, text: `[from agentistics · away]\n${text}` })
  return { ok: out.ok }
}

export async function defaultAwayDeps(): Promise<AwayDeps> {
  const { readPreferences, updatePreferences } = await import('./preferences')
  return {
    read: async () => (await readPreferences()).away,
    write: async state => { await updatePreferences(() => ({ away: state })) },
    verify: async (id, token) => (await import('./sessions/session-identity')).verifySessionIdentity(id, token),
    roleOf: async managedId => {
      const { readRegistry } = await import('./sessions/registry')
      const { storedRoleFor } = await import('./sessions/session-roles')
      const row = (await readRegistry()).find(m => m.id === managedId || m.conversationId === managedId)
      return storedRoleFor([row?.conversationId, row?.id, managedId])
    },
    now: () => Date.now(),
    live: {
      patch: async (id, away) => { await (await import('./sessions/registry')).patchSession(id, { away: away ? true : null }) },
      patchMany: async (ids, away) => { await (await import('./sessions/registry')).patchSessions(ids, { away: away ? true : null }) },
      rows: liveRows,
      roleOf: liveRoleOf,
      prompt: livePrompt,
      planLimitsInBriefing: true,
    },
    notify: (text, from) => {
      void import('./sse').then(m => m.broadcastNotification({ type: 'warning', code: 'away.notice', meta: { text, from } }))
      void import('./events/mobile-push').then(async m => m.sendMobileNotice('Agentistics · aviso', text, await m.readMobileSubscriptions(), m.webPushTransport)).catch(() => {})
    },
  }
}

// ─── Per-session away (`ManagedSession.away`) ──────────────────────────────────────────────────

export type SessionAwayReply =
  | { ok: true; id: string; away: boolean; effective: boolean; queued: boolean; message?: string }
  | { ok: false; error: 'unverified_sender' | 'leader_only' | 'on_required' | 'target_required' | 'no_such_session' }

export interface SessionAwayDeps {
  read: () => Promise<unknown>
  verify: AwayDeps['verify']
  roleOf: (managedIdOrConversation: string) => Promise<'leader' | 'worker' | undefined>
  /** Registry and fleet rows, including resolved activity and delivery liveness. */
  rows: () => Promise<readonly AwaySessionRow[]>
  patch: (id: string, away: boolean) => Promise<void>
  /** Type the notice into a running session through the composer's send path. */
  prompt: (id: string, text: string) => Promise<{ ok: boolean; message?: string }>
  now: () => number
  /** True when the briefing carries the plan-limits rule (so the notice points at it). */
  planLimitsInBriefing?: boolean
}

/**
 * Switch ONE session's own away flag. The person (no `session` field) or a verified LEADER may; the
 * flag is written to the registry (it survives a restart and is carried by a reopen) and, when the
 * session's EFFECTIVE state changed and its pane is running, the final notice is queued — the same send
 * path `agentistics_session_message` uses — so it never keeps acting on an instruction that is gone.
 */
export function setSessionAway(body: unknown, deps: SessionAwayDeps): Promise<SessionAwayReply> {
  return mutateAway(() => setSessionAwayMutation(body, deps))
}
async function setSessionAwayMutation(body: unknown, deps: SessionAwayDeps): Promise<SessionAwayReply> {
  const o = (body && typeof body === 'object' ? body : {}) as { target?: unknown; scope?: unknown; on?: unknown; session?: { id?: unknown; token?: unknown } }
  if (o.session !== undefined) {
    const sender = await deps.verify(o.session?.id, o.session?.token)
    if (!sender) return { ok: false, error: 'unverified_sender' }
    const senderRow = (await deps.rows()).find(r => r.id === sender || r.conversationId === sender)
    const role = await deps.roleOf(senderRow?.conversationId ?? sender) ?? await deps.roleOf(senderRow?.id ?? sender)
    if (role !== 'leader') return { ok: false, error: 'leader_only' }
  }
  if (typeof o.on !== 'boolean') return { ok: false, error: 'on_required' }
  if (o.scope === 'active') {
    const rows = (await deps.rows()).filter(awaySessionRunning)
    let anyQueued = false
    for (const row of rows) { const r = await setSessionAwayMutation({ target: row.id, on: o.on }, deps); if (r.ok && r.queued) anyQueued = true }
    const global = parseAwayState(await deps.read())
    return { ok: true, id: '*', away: o.on, effective: sessionAwayState(global, o.on, deps.now()) !== null, queued: anyQueued }
  }
  const target = typeof o.target === 'string' ? o.target.trim() : ''
  if (!target) return { ok: false, error: 'target_required' }
  const row = (await deps.rows()).find(r => r.id === target || r.conversationId === target)
  if (!row) return { ok: false, error: 'no_such_session' }
  const now = deps.now()
  const global = parseAwayState(await deps.read().catch(() => AWAY_OFF))
  const before = row.away === true
  if (before !== o.on) await deps.patch(row.id, o.on)
  const effective = sessionAwayState(global, o.on, now) !== null
  const queued = awaySessionRunning(row) && before !== o.on
  if (queued) {
    const role = await deps.roleOf(row.conversationId ?? row.id) ?? await deps.roleOf(row.id)
    queueAwayNotice(row.id, sessionAwayState(global, before, now), sessionAwayState(global, o.on, now), role,
      async text => (await deps.rows()).some(r => r.id === row.id && awaySessionRunning(r)) ? deps.prompt(row.id, text) : { ok: false, gone: true }, now, deps.planLimitsInBriefing, true)
  }
  return { ok: true, id: row.id, away: o.on, effective, queued }
}

export function sessionAwayStatus(r: SessionAwayReply): number {
  if (r.ok) return 200
  if (r.error === 'no_such_session') return 404
  return r.error === 'unverified_sender' || r.error === 'leader_only' ? 403 : 400
}

export async function defaultSessionAwayDeps(lang: 'pt' | 'en' = 'en'): Promise<SessionAwayDeps> {
  const base = await defaultAwayDeps()
  return {
    read: base.read,
    verify: base.verify,
    roleOf: async key => {
      return base.roleOf(key)
    },
    rows: liveRows,
    patch: async (id, away) => {
      const { patchSession } = await import('./sessions/registry')
      await patchSession(id, { away: away ? true : null })
    },
    prompt: async (id, text) => {
      const { runFleetAction } = await import('./sessions/fleet-web')
      const out = await runFleetAction(lang, { action: 'prompt', id, text: `[from agentistics · away]\n${text}` })
      return { ok: out.ok, ...(out.message ? { message: out.message } : {}) }
    },
    now: () => Date.now(),
    planLimitsInBriefing: true,
  }
}
