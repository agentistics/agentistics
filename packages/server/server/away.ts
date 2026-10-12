/**
 * away.ts — AWAY MODE on this machine: the owner is out, and every session started meanwhile is told
 * so in its briefing (`awayBriefingLines`, @agentistics/core). Stored in `preferences.json` (key
 * `away`) because it is a fact about this machine's fleet, not about a browser.
 *
 * Who may write it: the person (a browser/CLI call, no `session` field) or a VERIFIED session whose
 * stored role is `leader` (the MCP door). A worker is refused — it would be switching off the very
 * instruction that tells it not to ask the owner. Spec: agentistics-workspace/leader/specs/away-mode-spec.md
 */
import { AWAY_OFF, awayActive, normalizeAwayInput, parseAwayState, type AwayInputError, type AwayState } from '@agentistics/core'

export interface AwayView { state: AwayState; active: boolean }

export type AwayReply =
  | ({ ok: true } & AwayView)
  | { ok: false; error: AwayInputError | 'unverified_sender' | 'leader_only'; detail?: string }

export interface AwayDeps {
  read: () => Promise<unknown>
  write: (state: AwayState) => Promise<void>
  /** Resolves a `session` proof to the managed id it proves, or null. */
  verify: (id: unknown, token: unknown) => Promise<string | null>
  roleOf: (managedId: string) => Promise<'leader' | 'worker' | undefined>
  now: () => number
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

export function awayStatus(r: AwayReply): number {
  if (r.ok) return 200
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
  }
}
