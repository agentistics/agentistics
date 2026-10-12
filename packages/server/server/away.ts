/**
 * away.ts — AWAY MODE on this machine: the owner is out, and every session started meanwhile is told
 * so in its briefing (`awayBriefingLines`, @agentistics/core). Stored in `preferences.json` (key
 * `away`) because it is a fact about this machine's fleet, not about a browser.
 *
 * Who may write it: the person (a browser/CLI call, no `session` field) or a VERIFIED session whose
 * stored role is `leader` (the MCP door). A worker is refused — it would be switching off the very
 * instruction that tells it not to ask the owner. Spec: agentistics-workspace/leader/specs/away-mode-spec.md
 */
import { AWAY_OFF, awayActive, normalizeAwayInput, normalizeAwayNotice, parseAwayState, redactSecrets, sessionAwayNotice, sessionAwayState, type AwayInputError, type AwayState } from '@agentistics/core'

export interface AwayView { state: AwayState; active: boolean }

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
}

export function awayView(raw: unknown, now: number): AwayView {
  const state = parseAwayState(raw)
  return { state, active: awayActive(state, now) }
}

export async function readAwayView(deps: Pick<AwayDeps, 'read' | 'now'>): Promise<AwayView> {
  return awayView(await deps.read().catch(() => AWAY_OFF), deps.now())
}

export async function setAway(body: unknown, deps: AwayDeps): Promise<AwayReply> {
  const o = (body && typeof body === 'object' ? body : {}) as { session?: { id?: unknown; token?: unknown } }
  if (o.session !== undefined) {
    const sender = await deps.verify(o.session?.id, o.session?.token)
    if (!sender) return { ok: false, error: 'unverified_sender' }
    if ((await deps.roleOf(sender)) !== 'leader') return { ok: false, error: 'leader_only' }
  }
  const now = deps.now()
  const n = normalizeAwayInput(body, now)
  if (!n.ok) return { ok: false, error: n.error, ...(n.detail !== undefined ? { detail: n.detail } : {}) }
  await deps.write(n.state)
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

export async function defaultAwayDeps(): Promise<AwayDeps> {
  const { readPreferences, updatePreferences } = await import('./preferences')
  return {
    read: async () => (await readPreferences()).away,
    write: async state => { await updatePreferences(() => ({ away: state })) },
    verify: async (id, token) => (await import('./sessions/session-identity')).verifySessionIdentity(id, token),
    roleOf: async managedId => {
      const { readRegistry } = await import('./sessions/registry')
      const { storedRoleFor } = await import('./sessions/session-roles')
      const row = (await readRegistry()).find(m => m.id === managedId)
      return storedRoleFor([managedId, row?.conversationId])
    },
    now: () => Date.now(),
    notify: (text, from) => {
      void import('./sse').then(m => m.broadcastNotification({ type: 'warning', code: 'away.notice', meta: { text, from } }))
      void import('./events/mobile-push').then(async m => m.sendMobileNotice('Agentistics · aviso', text, await m.readMobileSubscriptions(), m.webPushTransport)).catch(() => {})
    },
  }
}

// ─── Per-session away (`ManagedSession.away`) ──────────────────────────────────────────────────

export type SessionAwayReply =
  | { ok: true; id: string; away: boolean; effective: boolean; notified: boolean; message?: string }
  | { ok: false; error: 'unverified_sender' | 'leader_only' | 'on_required' | 'target_required' | 'no_such_session' }

export interface SessionAwayDeps {
  read: () => Promise<unknown>
  verify: AwayDeps['verify']
  roleOf: (managedIdOrConversation: string) => Promise<'leader' | 'worker' | undefined>
  /** Registry rows (id, conversation id, current flag, whether a pane is running). */
  rows: () => Promise<readonly { id: string; conversationId?: string; away?: boolean; running: boolean }[]>
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
 * session's EFFECTIVE state changed and its pane is running, the session is told — the same send
 * path `agentistics_session_message` uses — so it never keeps acting on an instruction that is gone.
 */
export async function setSessionAway(body: unknown, deps: SessionAwayDeps): Promise<SessionAwayReply> {
  const o = (body && typeof body === 'object' ? body : {}) as { target?: unknown; on?: unknown; session?: { id?: unknown; token?: unknown } }
  if (o.session !== undefined) {
    const sender = await deps.verify(o.session?.id, o.session?.token)
    if (!sender) return { ok: false, error: 'unverified_sender' }
    if ((await deps.roleOf(sender)) !== 'leader') return { ok: false, error: 'leader_only' }
  }
  if (typeof o.on !== 'boolean') return { ok: false, error: 'on_required' }
  const target = typeof o.target === 'string' ? o.target.trim() : ''
  if (!target) return { ok: false, error: 'target_required' }
  const row = (await deps.rows()).find(r => r.id === target || r.conversationId === target)
  if (!row) return { ok: false, error: 'no_such_session' }
  const now = deps.now()
  const global = parseAwayState(await deps.read().catch(() => AWAY_OFF))
  const before = row.away === true
  if (before !== o.on) await deps.patch(row.id, o.on)
  const effective = sessionAwayState(global, o.on, now) !== null
  let notified = false
  let message: string | undefined
  if (row.running && before !== o.on) {
    const role = await deps.roleOf(row.id).catch(() => undefined) ?? (row.conversationId ? await deps.roleOf(row.conversationId).catch(() => undefined) : undefined)
    const text = sessionAwayNotice(global, before, o.on, role, now, { planLimitsInBriefing: deps.planLimitsInBriefing === true })
    if (text) {
      const sent = await deps.prompt(row.id, text).catch(() => ({ ok: false, message: undefined }))
      notified = sent.ok
      if (!sent.ok && sent.message) message = sent.message
    }
  }
  return { ok: true, id: row.id, away: o.on, effective, notified, ...(message ? { message } : {}) }
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
      const { storedRoleFor } = await import('./sessions/session-roles')
      return storedRoleFor([key])
    },
    rows: async () => {
      const { readRegistry } = await import('./sessions/registry')
      // An ended row has no pane to tell; a LOST one (no `endedAt`) is tried and refuses on its own.
      return (await readRegistry()).map(r => ({ id: r.id, ...(r.conversationId ? { conversationId: r.conversationId } : {}), ...(r.away ? { away: true } : {}), running: !r.endedAt }))
    },
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
