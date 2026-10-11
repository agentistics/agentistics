/**
 * session-roles.ts — the SERVER-owned store of each session's role (leader | worker), and the one
 * operation that changes it: `/api/session-roles`, the door the web chips and `agentistics_session_role` share.
 *
 * Keyed by the stable CONVERSATION key (`sessionIdentityKey`), falling back to the managed id for a row
 * that has no conversation yet; a lookup tries both, so a role set before the link existed is found
 * after it. `auto` is the absence of an entry.
 *
 * Changing a role has THREE effects, in this order, and the store write is the one that always happens:
 *   1. the title prefix — "[ LEADER ] - <title>" / "[ LÍDER ] - <title>" for a leader, stripped otherwise —
 *      through the same `rename` fleet action `agentop session rename` uses (idempotent: the title is
 *      computed from the prefix-free base, so a second call changes nothing);
 *   2. a background note typed into the session ("[agentistics] your role is now …") through the
 *      composer's own send path — skipped when the session changes ITS OWN role (the tool answer
 *      carries the line instead of typing into the pane that is running the tool);
 *   3. nothing else. The role grants no power; it is what the briefing tells the model.
 *
 * Dependencies are injected so the rules are testable with a fake host.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isSessionRole, isSessionRoleRequest, resolveSessionForGroup, roleChangeNote, roleLine, sessionIdentityKey, titleForRole,
  type RoleLang, type SessionRole,
} from '@agentistics/core'
import type { FleetRowForGroups } from './session-groups-web'

export const SESSION_ROLES_FILE = 'session-roles.json'

export interface RolesDoc {
  version: 1
  /** The legacy web preference (`ui.sessionRoles`) was folded in. Done once, never again. */
  migrated: boolean
  roles: Record<string, SessionRole>
}

const emptyDoc = (): RolesDoc => ({ version: 1, migrated: false, roles: {} })

export function parseRoles(raw: unknown): Record<string, SessionRole> {
  const out: Record<string, SessionRole> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isSessionRole(v)) out[k] = v
  return out
}

export async function readRolesDoc(dataDir: string): Promise<RolesDoc> {
  try {
    const p = JSON.parse(await readFile(join(dataDir, SESSION_ROLES_FILE), 'utf-8')) as Partial<RolesDoc>
    return { version: 1, migrated: p.migrated === true, roles: parseRoles(p.roles) }
  } catch {
    return emptyDoc()
  }
}

export async function writeRolesDoc(dataDir: string, doc: RolesDoc): Promise<void> {
  const file = join(dataDir, SESSION_ROLES_FILE)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, file)
}

/**
 * Fold the legacy web preference into the store, ONCE. Entries already in the store win (the server is
 * newer than the browser's copy); the flag is set whether or not there was anything to fold.
 */
export function migrateLegacyRoles(doc: RolesDoc, legacy: unknown): RolesDoc {
  if (doc.migrated) return doc
  return { version: 1, migrated: true, roles: { ...parseRoles(legacy), ...doc.roles } }
}

/** The stored role of a row: by conversation key first, then by managed id. */
export function roleOfRow(roles: Record<string, SessionRole>, row: { id: string; conversationId?: string | undefined }): SessionRole | undefined {
  return roles[sessionIdentityKey(row)] ?? roles[row.id]
}

// ---------------------------------------------------------------------------------------------

export interface RoleDeps {
  dataDir: string
  rows: () => Promise<readonly FleetRowForGroups[]>
  /** The legacy `ui.sessionRoles` preference, read once for the migration. */
  legacyPref: () => Promise<unknown>
  uiLang: () => Promise<RoleLang>
  /** Rename through the shared fleet `rename` action (registry label + the harness's own rename). */
  rename: (rowId: string, title: string) => Promise<{ ok: boolean }>
  /** Type a note into the session through the composer path. */
  prompt: (rowId: string, text: string) => Promise<{ ok: boolean }>
  /** Who started this managed session (the registry's parentSessionId), if anyone. */
  parentOf: (rowId: string) => Promise<string | undefined>
}

export interface RoleRequest {
  /** The target: managed id, conversation id, exact title or unique id prefix. Absent = the caller itself. */
  ref?: string
  /** Absent = just read. `auto` clears. */
  role?: string
  lang?: string
}

export type RoleReply =
  | { ok: true; key: string; id?: string; title?: string; role: SessionRole | 'auto'; changed: boolean; renamed: boolean; notified: boolean; line: string; message: string }
  | { ok: false; code: string; message: string; matches?: string[] }

const MESSAGES: Record<string, string> = {
  unverified_sender: 'Only a session started by agentistics can use this without naming a session reference.',
  missing_argument: 'A session reference is required.',
  bad_role: 'role must be leader, worker or auto.',
  no_such_session: 'No session on this machine matches that reference.',
  ambiguous_session: 'More than one session matches that reference; use its id.',
  not_your_child: 'A session may set another session\'s role only for sessions it started itself.',
}

const fail = (code: string, matches?: string[]): RoleReply => ({
  ok: false, code, message: MESSAGES[code] ?? code, ...(matches && matches.length > 0 ? { matches } : {}),
})

/** Load the store, running the one-time migration (and persisting it) when it has not run. */
export async function loadRoles(deps: Pick<RoleDeps, 'dataDir' | 'legacyPref'>): Promise<RolesDoc> {
  const doc = await readRolesDoc(deps.dataDir)
  if (doc.migrated) return doc
  const next = migrateLegacyRoles(doc, await deps.legacyPref().catch(() => undefined))
  await writeRolesDoc(deps.dataDir, next).catch(() => {})
  return next
}

/** Serialise writes inside this process: read-modify-write of one small file. */
let chain: Promise<unknown> = Promise.resolve()
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/**
 * Read or change a role. `senderId` is the VERIFIED calling session (or null for the browser/CLI, which
 * may address any session). A session addressing nobody changes its OWN role; addressing another is
 * allowed only for a session it started.
 */
export function roleOp(senderId: string | null, req: RoleRequest, deps: RoleDeps): Promise<RoleReply> {
  return serial(async () => {
    const rows = await deps.rows().catch(() => [] as FleetRowForGroups[])
    const ref = req.ref?.trim() ?? ''
    let own = false
    let target: FleetRowForGroups | undefined
    if (ref === '') {
      if (!senderId) return fail('missing_argument')
      const mine = rows.find(r => r.id === senderId)
      if (!mine) return fail('no_such_session')
      target = mine
      own = true
    } else {
      const r = resolveSessionForGroup(rows, ref)
      if (!r.ok) return fail(r.code, r.matches)
      target = r.session
      own = senderId !== null && (target.id === senderId || target.conversationId === senderId)
      if (senderId !== null && !own && (await deps.parentOf(target.id).catch(() => undefined)) !== senderId) return fail('not_your_child')
    }
    const key = sessionIdentityKey(target)
    const doc = await loadRoles(deps)
    const current = roleOfRow(doc.roles, target)
    const base = { key, id: target.id, title: target.title }

    if (req.role === undefined) {
      return { ok: true, ...base, role: current ?? 'auto', changed: false, renamed: false, notified: false, line: roleLine(current), message: `Role: ${current ?? 'auto'}.` }
    }
    if (!isSessionRoleRequest(req.role)) return fail('bad_role')
    const next: SessionRole | null = req.role === 'auto' ? null : req.role
    const changed = next !== (current ?? null)

    const roles = { ...doc.roles }
    delete roles[target.id]
    if (next) roles[key] = next
    else delete roles[key]
    await writeRolesDoc(deps.dataDir, { ...doc, roles })

    const lang: RoleLang = req.lang === 'pt' || req.lang === 'en' ? req.lang : await deps.uiLang().catch(() => 'en' as RoleLang)
    // The prefix is brought in line even when the stored role did not change: setting `leader` on a
    // session whose title lost its prefix repairs it, and a second identical call changes nothing.
    const wanted = titleForRole(target.title, next, lang)
    const renamed = wanted !== target.title && wanted !== '' ? (await deps.rename(target.id, wanted).catch(() => ({ ok: false }))).ok : false
    const notified = changed && !own ? (await deps.prompt(target.id, roleChangeNote(next)).catch(() => ({ ok: false }))).ok : false
    return {
      ok: true, ...base, role: next ?? 'auto', changed, renamed, notified, line: roleLine(next),
      message: changed
        ? `Role set to ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}${notified ? '; the session was told' : ''}.`
        : `Role is already ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}.`,
    }
  })
}

export function roleStatus(out: RoleReply): number {
  if (out.ok) return 200
  if (out.code === 'no_such_session') return 404
  if (out.code === 'ambiguous_session') return 409
  if (out.code === 'not_your_child') return 403
  return 400
}

/** The stored roles, for the browser (`GET /api/session-roles`). */
export async function listRoles(deps: Pick<RoleDeps, 'dataDir' | 'legacyPref'>): Promise<Record<string, SessionRole>> {
  return (await loadRoles(deps)).roles
}

export async function defaultRoleDeps(): Promise<RoleDeps> {
  const { AGENTISTICS_DATA_DIR } = await import('../config')
  const { readPreferences } = await import('../preferences')
  return {
    dataDir: AGENTISTICS_DATA_DIR,
    rows: async () => (await (await import('./fleet-web')).readFleet('en')).rows,
    legacyPref: async () => ((await readPreferences()).ui ?? {}).sessionRoles,
    uiLang: async () => ((await readPreferences()).lang === 'pt' ? 'pt' : 'en'),
    rename: async (rowId, title) => {
      const out = await (await import('./fleet-web')).runFleetAction('en', { action: 'rename', id: rowId, text: title })
      return { ok: out.ok }
    },
    prompt: async (rowId, text) => {
      const out = await (await import('./fleet-web')).runFleetAction('en', { action: 'prompt', id: rowId, text })
      return { ok: out.ok }
    },
    parentOf: async rowId => (await (await import('./registry')).readRegistry()).find(m => m.id === rowId)?.parentSessionId,
  }
}

/** The stored role for a managed id/conversation id at spawn time — undefined when none. */
export async function storedRoleFor(keys: readonly (string | undefined)[]): Promise<SessionRole | undefined> {
  const deps = await defaultRoleDeps()
  const roles = (await loadRoles(deps)).roles
  for (const k of keys) if (k && roles[k]) return roles[k]
  return undefined
}
