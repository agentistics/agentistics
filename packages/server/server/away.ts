/**
 * away.ts — AWAY MODE on this machine: the owner is out, and every session started meanwhile is told
 * so in its briefing (`awayBriefingLines`, @agentistics/core). Stored in `preferences.json` (key
 * `away`) because it is a fact about this machine's fleet, not about a browser.
 *
 * Who may write it: the person (a browser/CLI call, no `session` field) or a VERIFIED session whose
 * stored role is `leader` (the MCP door). A worker is refused — it would be switching off the very
 * instruction that tells it not to ask the owner. Spec: agentistics-workspace/leader/specs/away-mode-spec.md
 */
import { AWAY_OFF, awayActive, normalizeAwayInput, normalizeAwayNotice, parseAwayState, redactSecrets, type AwayInputError, type AwayState } from '@agentistics/core'

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
