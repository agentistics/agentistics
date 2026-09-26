/**
 * session-groups-web.ts — `/api/session-groups`, the door the MCP tools use to organise sessions.
 *
 * A group is a named set of sessions a person curates ("Saved to later"). It lives in the shared
 * preferences (`sessionGroups`, with the pins beside it) so every device reads the same, and the web
 * writes it through `/api/preferences`. THIS door exists so an assistant can file the sessions it
 * starts: it creates a group, and puts a session in it, without going through a browser.
 *
 * It holds NO rule of its own. `planGroupOp` (`@agentistics/core`) is the one place the rules
 * combine — the same planners the web calls — and this module only (1) resolves the text an
 * assistant has (a title, an id prefix) to the identity key the groups store, against the SAME fleet
 * rows the web aside draws, and (2) applies the plan atomically, inside the preferences write chain,
 * so a browser write and an MCP write racing each other cannot resurrect what the other removed.
 */

import {
  planGroupOp, resolveSessionForGroup, sessionIdentityKey,
  type GroupOp, type SessionUserGroup, type SessionUserGroupsValue,
} from '@agentistics/core'
import { readPreferences, updatePreferences, type PreferencesMutator } from '../preferences'
import type { Preferences } from '../preferences'
import { readFleet } from './fleet-web'

/** A row as far as group filing goes — `ControlSession` satisfies it. */
export interface FleetRowForGroups {
  id: string
  conversationId?: string | undefined
  title: string
  state?: string
  harness?: string
}

export interface GroupsDeps {
  rows: () => Promise<readonly FleetRowForGroups[]>
  read: () => Promise<Preferences>
  update: (mutate: PreferencesMutator) => Promise<Preferences>
}

const defaultDeps: GroupsDeps = {
  rows: async () => (await readFleet('en')).rows,
  read: readPreferences,
  update: updatePreferences,
}

const groupsOf = (p: Preferences): SessionUserGroupsValue => ({ groups: (p.sessionGroups?.groups ?? []).map(g => ({ ...g, sessionKeys: [...g.sessionKeys] })) })

export interface GroupMember {
  /** The identity key stored in the group. */
  key: string
  /** Present when the session is on this machine's fleet right now. Absent for one that is gone. */
  id?: string
  title?: string
  state?: string
  harness?: string
}

export interface GroupView { id: string; name: string; sessions: GroupMember[] }

export type GroupsReply =
  | { ok: true; groups: GroupView[] }
export type GroupOpReply =
  | { ok: true; group?: GroupView; deleted?: boolean; message: string }
  | { ok: false; code: string; message: string; matches?: string[] }

function viewOf(g: SessionUserGroup, rows: readonly FleetRowForGroups[]): GroupView {
  const byKey = new Map(rows.map(r => [sessionIdentityKey(r), r]))
  return {
    id: g.id,
    name: g.name,
    sessions: g.sessionKeys.map(key => {
      const r = byKey.get(key)
      return r
        ? { key, id: r.id, title: r.title, ...(r.state ? { state: r.state } : {}), ...(r.harness ? { harness: r.harness } : {}) }
        : { key }
    }),
  }
}

export async function listGroups(deps: GroupsDeps = defaultDeps): Promise<GroupsReply> {
  const [prefs, rows] = await Promise.all([deps.read(), deps.rows().catch(() => [] as FleetRowForGroups[])])
  return { ok: true, groups: groupsOf(prefs).groups.map(g => viewOf(g, rows)) }
}

export interface GroupOpRequest {
  op: 'create' | 'rename' | 'delete' | 'add' | 'remove'
  /** A group id, or its name. */
  group?: string
  /** The new name (create, rename). */
  name?: string
  /** A session: managed id, conversation id, exact title or a unique id prefix. */
  session?: string
  /** Sessions to file into a NEW group as it is created. */
  sessions?: readonly string[]
}

const MESSAGES: Record<string, string> = {
  blank_name: 'A group needs a non-blank name.',
  no_such_group: 'No group has that id or name. List the groups first.',
  ambiguous_group: 'More than one group has that name; use the id.',
  no_such_session: 'No session on this machine matches that reference.',
  ambiguous_session: 'More than one session matches that reference; use its id.',
  missing_argument: 'A required argument is missing.',
}

const fail = (code: string, matches?: string[]): GroupOpReply => ({
  ok: false, code, message: MESSAGES[code] ?? code, ...(matches && matches.length > 0 ? { matches } : {}),
})

export async function groupOp(req: GroupOpRequest, deps: GroupsDeps = defaultDeps): Promise<GroupOpReply> {
  const rows = await deps.rows().catch(() => [] as FleetRowForGroups[])

  // Text an assistant holds -> the key the groups store. A ref that resolves to nothing is REFUSED:
  // filing "whatever it typed" would create a member no row can ever resolve.
  const keyOf = (ref: string): { ok: true; key: string } | { ok: false; reply: GroupOpReply } => {
    const r = resolveSessionForGroup(rows, ref)
    if (r.ok) return { ok: true, key: sessionIdentityKey(r.session) }
    return { ok: false, reply: fail(r.code, r.matches) }
  }

  let op: GroupOp
  switch (req.op) {
    case 'create': {
      const keys: string[] = []
      for (const ref of req.sessions ?? []) {
        const k = keyOf(ref)
        if (!k.ok) return k.reply
        keys.push(k.key)
      }
      op = { type: 'create', name: req.name ?? '', keys }
      break
    }
    case 'rename':
      if (!req.group) return fail('missing_argument')
      op = { type: 'rename', group: req.group, name: req.name ?? '' }
      break
    case 'delete':
      if (!req.group) return fail('missing_argument')
      op = { type: 'delete', group: req.group }
      break
    case 'add': {
      if (!req.group || !req.session) return fail('missing_argument')
      const k = keyOf(req.session)
      if (!k.ok) return k.reply
      op = { type: 'add', group: req.group, key: k.key }
      break
    }
    case 'remove': {
      if (!req.session) return fail('missing_argument')
      // A session that is gone from the fleet can still be taken out: fall back to the reference as
      // a KEY, so a group is never stuck holding a member nobody can name any more.
      const k = keyOf(req.session)
      op = { type: 'remove', key: k.ok ? k.key : req.session.trim() }
      break
    }
    default:
      return fail('missing_argument')
  }

  let refused: GroupOpReply | null = null
  let touched: { id?: string; deleted: boolean } = { deleted: false }
  const next = await deps.update(cur => {
    const plan = planGroupOp(groupsOf(cur), cur.pinnedSessions ?? [], op)
    if (!plan.ok) { refused = fail(plan.code, plan.matches ? [...plan.matches] : undefined); return undefined }
    touched = { ...(plan.id ? { id: plan.id } : {}), deleted: op.type === 'delete' }
    return { sessionGroups: { groups: plan.groups.groups }, pinnedSessions: plan.pins }
  })
  if (refused) return refused

  const groups = groupsOf(next).groups
  const group = touched.id ? groups.find(g => g.id === touched.id) : undefined
  const message = {
    create: 'Group created.', rename: 'Group renamed.', delete: 'Group deleted; its sessions are untouched.',
    add: 'Session filed under the group.', remove: 'Session taken out of its group.',
  }[req.op]
  return {
    ok: true, message,
    ...(group ? { group: viewOf(group, rows) } : {}),
    ...(touched.deleted ? { deleted: true } : {}),
  }
}

/** The HTTP status for a reply: an id that names nothing is 404, a reference that could mean two things
 *  is 409, and anything else that was refused is 400. */
export function groupStatus(out: GroupOpReply): number {
  if (out.ok) return 200
  if (out.code === 'no_such_group' || out.code === 'no_such_session') return 404
  if (out.code === 'ambiguous_group' || out.code === 'ambiguous_session') return 409
  return 400
}
