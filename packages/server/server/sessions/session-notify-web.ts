/**
 * session-notify-web.ts — `/api/session-notify`, the door the MCP tool and the CLI use to switch a
 * session's notifications on or off, or to read the switch.
 *
 * It holds no rule of its own: `planMute` (`@agentistics/core`) is the set arithmetic the web store
 * also uses, and the text an assistant holds is resolved with `resolveSessionForGroup` against the
 * same fleet rows the aside draws — a ref that resolves to nothing is REFUSED, never stored as a
 * key no row can ever match. The write goes through the preferences write chain so a browser write
 * and this one cannot erase each other.
 *
 * A mute removes the INTERRUPTION only. The session's `waiting` state is untouched.
 */

import { planMute, resolveSessionForGroup, sessionIdentityKey } from '@agentistics/core'
import type { GroupsDeps, FleetRowForGroups } from './session-groups-web'
import { readPreferences, updatePreferences } from '../preferences'
import { readFleet } from './fleet-web'

const defaultDeps: GroupsDeps = {
  rows: async () => (await readFleet('en')).rows,
  read: readPreferences,
  update: updatePreferences,
}

export interface NotifyRequest {
  /** A session: managed id, conversation id, exact title or a unique id prefix. */
  ref: string
  /** Set it. Absent = just read it. */
  notify?: 'on' | 'off'
}

export type NotifyReply =
  | { ok: true; key: string; id?: string; title?: string; notify: 'on' | 'off'; message: string }
  | { ok: false; code: string; message: string; matches?: string[] }

const MESSAGES: Record<string, string> = {
  missing_argument: 'A session reference is required.',
  bad_value: 'notify must be "on" or "off".',
  no_such_session: 'No session on this machine matches that reference.',
  ambiguous_session: 'More than one session matches that reference; use its id.',
}

const fail = (code: string, matches?: string[]): NotifyReply => ({
  ok: false, code, message: MESSAGES[code] ?? code, ...(matches && matches.length > 0 ? { matches } : {}),
})

export async function notifyOp(req: NotifyRequest, deps: GroupsDeps = defaultDeps): Promise<NotifyReply> {
  if (!req.ref?.trim()) return fail('missing_argument')
  if (req.notify !== undefined && req.notify !== 'on' && req.notify !== 'off') return fail('bad_value')
  const rows = await deps.rows().catch(() => [] as FleetRowForGroups[])
  const r = resolveSessionForGroup(rows, req.ref)
  if (!r.ok) return fail(r.code, r.matches)
  const key = sessionIdentityKey(r.session)
  const base = { key, id: r.session.id, title: r.session.title }

  if (req.notify === undefined) {
    const muted = ((await deps.read()).mutedSessions ?? []).includes(key)
    return { ok: true, ...base, notify: muted ? 'off' : 'on', message: muted ? 'Notifications are off for this session.' : 'Notifications are on for this session.' }
  }
  await deps.update(cur => ({ mutedSessions: planMute(cur.mutedSessions ?? [], key, req.notify === 'off') }))
  return {
    ok: true, ...base, notify: req.notify,
    message: req.notify === 'off'
      ? 'Notifications muted for this session. It still shows as waiting; only the interruption is gone.'
      : 'Notifications are back on for this session.',
  }
}

export function notifyStatus(out: NotifyReply): number {
  if (out.ok) return 200
  if (out.code === 'no_such_session') return 404
  if (out.code === 'ambiguous_session') return 409
  return 400
}

/**
 * Mute a session at SPAWN (`agentop session … --notify off`). The key is the conversation when the
 * CLI was handed one (`assignId`), and the managed id otherwise — `rekeyMutedSession` moves it to
 * the conversation once the poller learns it, so the mute is the same key the dashboard reads.
 */
export async function muteAtSpawn(key: string): Promise<void> {
  await updatePreferences(cur => ({ mutedSessions: planMute(cur.mutedSessions ?? [], key, true) }))
}

/**
 * A managed id was just linked to its conversation: if that id carried a mute, carry it over to the
 * conversation key (`sessionIdentityKey` switches from id to conversationId at this moment, and a
 * mute left under the old key would silently come undone). Best effort and a no-op for the common
 * case of a session that was never muted.
 */
export async function rekeyMutedSession(managedId: string, conversationId: string): Promise<void> {
  if (managedId === conversationId) return
  await updatePreferences(cur => {
    const muted = cur.mutedSessions ?? []
    if (!muted.includes(managedId)) return undefined
    return { mutedSessions: planMute(planMute(muted, managedId, false), conversationId, true) }
  })
}
