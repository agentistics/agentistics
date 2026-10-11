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
  isSessionRole, isSessionRoleRequest, parseRoleOrigin, resolveSessionForGroup, roleChangeNote, roleLine, sessionIdentityKey, titleForRole,
  type HarnessId, type RoleLang, type RoleOrigin, type SessionRole,
} from '@agentistics/core'
import type { FleetRowForGroups } from './session-groups-web'

export const SESSION_ROLES_FILE = 'session-roles.json'

export interface RolesDoc {
  version: 1
  /** The legacy web preference (`ui.sessionRoles`) was folded in. Done once, never again. */
  migrated: boolean
  roles: Record<string, SessionRole>
  /** Who set each role (same keys as `roles`). Absent = set by the person (back-compat). */
  origins?: Record<string, RoleOrigin>
  /** Last role note delivered to a session. Prevents reopen/takeover from typing it repeatedly. */
  lastDeliveredRole?: Record<string, SessionRole>
}

const emptyDoc = (): RolesDoc => ({ version: 1, migrated: false, roles: {}, lastDeliveredRole: {} })

export function parseRoles(raw: unknown): Record<string, SessionRole> {
  const out: Record<string, SessionRole> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isSessionRole(v)) out[k] = v
  return out
}

export function parseOrigins(raw: unknown): Record<string, RoleOrigin> {
  const out: Record<string, RoleOrigin> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) { const o = parseRoleOrigin(v); if (o) out[k] = o }
  return out
}

export async function readRolesDoc(dataDir: string): Promise<RolesDoc> {
  try {
    const p = JSON.parse(await readFile(join(dataDir, SESSION_ROLES_FILE), 'utf-8')) as Partial<RolesDoc>
    return {
      version: 1,
      migrated: p.migrated === true,
      roles: parseRoles(p.roles),
      origins: parseOrigins(p.origins),
      lastDeliveredRole: parseRoles(p.lastDeliveredRole),
    }
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
  return { ...doc, version: 1, migrated: true, roles: { ...parseRoles(legacy), ...doc.roles } }
}

/** The stored role of a row: by conversation key first, then by managed id. */
export function roleOfRow(roles: Record<string, SessionRole>, row: { id: string; conversationId?: string | undefined }): SessionRole | undefined {
  return roles[sessionIdentityKey(row)] ?? roles[row.id]
}

/** Who set the stored role of a row; an entry written before origins existed was the person's. */
export function originOfRow(doc: Pick<RolesDoc, 'roles' | 'origins'>, row: { id: string; conversationId?: string | undefined }): RoleOrigin {
  const key = sessionIdentityKey(row)
  const k = doc.roles[key] ? key : row.id
  return doc.origins?.[k] ?? 'manual'
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
  /** Wait until the harness has an input surface; spawn delivery must not race startup. */
  waitForInput?: (rowId: string) => Promise<boolean>
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
  | { ok: true; key: string; id?: string; title?: string; role: SessionRole | 'auto'; changed: boolean; renamed: boolean; notified: boolean; origin?: RoleOrigin; line: string; message: string }
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
  // Fleet resolution and parent verification can join the in-flight poll. Keep them outside the
  // role-store queue: a poll that discovers a conversation may itself be waiting for that queue.
  return (async () => {
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
    const resolved = target
    const key = sessionIdentityKey(resolved)
    // Who is asking decides the origin: no verified sender = the person (browser/CLI), the session
    // itself = auto, a verified other session = that leader.
    const origin: RoleOrigin = senderId === null ? 'manual' : own ? 'auto' : { leader: senderId }
    const state = await serial(async () => {
      const doc = await loadRoles(deps)
      const current = roleOfRow(doc.roles, resolved)
      const base = { key, id: resolved.id, title: resolved.title }
      if (req.role === undefined) {
        return { kind: 'read' as const, reply: { ok: true, ...base, role: current ?? 'auto', changed: false, renamed: false, notified: false, line: roleLine(current), message: `Role: ${current ?? 'auto'}.` } satisfies RoleReply }
      }
      if (!isSessionRoleRequest(req.role)) return { kind: 'fail' as const, reply: fail('bad_role') }
      const next: SessionRole | null = req.role === 'auto' ? null : req.role
      const changed = next !== (current ?? null)
      const roles = { ...doc.roles }
      const origins = { ...(doc.origins ?? {}) }
      delete roles[resolved.id]
      delete origins[resolved.id]
      if (next) { roles[key] = next; origins[key] = origin }
      else { delete roles[key]; delete origins[key] }
      await writeRolesDoc(deps.dataDir, { ...doc, roles, origins })
      return { kind: 'change' as const, doc, roles, base, current, next, changed }
    })
    if (state.kind !== 'change') return state.reply

    const { base, next, changed } = state
    const lang: RoleLang = req.lang === 'pt' || req.lang === 'en' ? req.lang : await deps.uiLang().catch(() => 'en' as RoleLang)
    // External title/note I/O stays outside `serial`; either can wait for the fleet poll.
    const wanted = titleForRole(resolved.title, next, lang)
    const renamed = wanted !== resolved.title && wanted !== '' ? (await deps.rename(resolved.id, wanted).catch(() => ({ ok: false }))).ok : false
    const notified = changed && !own ? (await deps.prompt(resolved.id, roleChangeNote(next)).catch(() => ({ ok: false }))).ok : false
    if (notified || own) {
      await serial(async () => {
        const latest = await loadRoles(deps)
        const delivered = { ...(latest.lastDeliveredRole ?? {}) }
        if (next) delivered[key] = next
        else delete delivered[key]
        await writeRolesDoc(deps.dataDir, { ...latest, lastDeliveredRole: delivered }).catch(() => {})
      })
    }
    return {
      ok: true, ...base, role: next ?? 'auto', changed, renamed, notified, ...(next ? { origin } : {}), line: roleLine(next),
      message: changed
        ? `Role set to ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}${notified ? '; the session was told' : ''}.`
        : `Role is already ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}.`,
    }
  })()
}

export function roleStatus(out: RoleReply): number {
  if (out.ok) return 200
  if (out.code === 'no_such_session') return 404
  if (out.code === 'ambiguous_session') return 409
  if (out.code === 'not_your_child') return 403
  return 400
}

/** Who set each stored role, for the browser (`GET /api/session-roles` → `origins`). */
export async function listRoleOrigins(deps: Pick<RoleDeps, 'dataDir' | 'legacyPref'>): Promise<Record<string, RoleOrigin>> {
  const doc = await loadRoles(deps)
  const out: Record<string, RoleOrigin> = {}
  for (const k of Object.keys(doc.roles)) out[k] = doc.origins?.[k] ?? 'manual'
  return out
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
    waitForInput: async rowId => {
      const row = (await (await import('./fleet-web')).readFleet('en')).rows.find(r => r.id === rowId)
      if (!row) return false
      const backend = await (await import('./index')).resolveBackend()
      const { rulesFor } = await import('./attention-rules')
      const { promptSurfaceReady } = await import('./initial-prompt')
      const rules = rulesFor(row.harness as HarnessId)
      for (let i = 0; i < 40; i++) {
        if (promptSurfaceReady(await backend.capture(rowId, 80), rules)) return true
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      return false
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

/**
 * Assign the role implied by the spawn relationship, but only when no explicit role exists yet.
 * `leader` is reserved for a declared hand-off; every other child is a worker. Existing entries
 * always win, including an explicit role that was set before the conversation was linked.
 */
export async function ensureSpawnRole(
  keys: readonly (string | undefined)[],
  desired: SessionRole,
  providedDeps?: RoleDeps,
  origin: RoleOrigin = 'manual',
): Promise<SessionRole> {
  return serial(async () => {
    const deps = providedDeps ?? await defaultRoleDeps()
    const doc = await loadRoles(deps)
    const existing = keys.map(k => k ? doc.roles[k] : undefined).find((r): r is SessionRole => !!r)
    if (existing) return existing
    const nonEmpty = keys.filter((k): k is string => !!k)
    if (nonEmpty.length === 0) return desired
    // Some harnesses reject the offered conversation id. Keep the role under the managed id too,
    // which is the stable key until the poller can discover the real conversation id.
    const roles = { ...doc.roles }
    const origins = { ...(doc.origins ?? {}) }
    for (const key of nonEmpty) { roles[key] = desired; origins[key] = origin }
    await writeRolesDoc(deps.dataDir, { ...doc, roles, origins })
    return desired
  })
}

/** The spawn context already carried this role, so a later reopen must not type it again. */
export async function markRoleDelivered(
  keys: readonly (string | undefined)[],
  role: SessionRole,
  providedDeps?: Pick<RoleDeps, 'dataDir' | 'legacyPref'>,
): Promise<void> {
  return serial(async () => {
    const deps = providedDeps ?? await defaultRoleDeps()
    const doc = await loadRoles(deps)
    const delivered = { ...(doc.lastDeliveredRole ?? {}) }
    for (const key of keys) if (key) delivered[key] = role
    await writeRolesDoc(deps.dataDir, { ...doc, lastDeliveredRole: delivered }).catch(() => {})
  })
}

/** Move role state when a managed row is replaced or its conversation is discovered. */
export async function rekeyStoredRole(
  fromKeys: readonly (string | undefined)[],
  toKeys: readonly (string | undefined)[],
  providedDeps?: Pick<RoleDeps, 'dataDir' | 'legacyPref'>,
): Promise<void> {
  return serial(async () => {
    const deps = providedDeps ?? await defaultRoleDeps()
    const doc = await loadRoles(deps)
    const from = [...new Set(fromKeys.filter((k): k is string => !!k))]
    const to = [...new Set(toKeys.filter((k): k is string => !!k))]
    if (from.length === 0 || to.length === 0) return

    const role = from.map(k => doc.roles[k]).find((r): r is SessionRole => !!r)
    const delivered = from.map(k => doc.lastDeliveredRole?.[k]).find((r): r is SessionRole => !!r)
    if (!role && !delivered) return

    const roles = { ...doc.roles }
    const origins = { ...(doc.origins ?? {}) }
    const fromOrigin = from.map(k => doc.origins?.[k]).find(o => !!o)
    const lastDeliveredRole = { ...(doc.lastDeliveredRole ?? {}) }
    for (const key of to) {
      if (role && !roles[key]) { roles[key] = role; if (fromOrigin) origins[key] = fromOrigin }
      if (delivered && !lastDeliveredRole[key]) lastDeliveredRole[key] = delivered
    }
    for (const key of from) {
      if (!to.includes(key)) {
        delete roles[key]
        delete origins[key]
        delete lastDeliveredRole[key]
      }
    }
    await writeRolesDoc(deps.dataDir, { ...doc, roles, origins, lastDeliveredRole }).catch(() => {})
  })
}

/** Apply the leader title convention through the same rename dependency used by role changes. */
export async function applyRoleTitle(
  rowId: string,
  title: string,
  role: SessionRole,
  lang: RoleLang,
  providedDeps?: RoleDeps,
): Promise<boolean> {
  if (role !== 'leader') return false
  const deps = providedDeps ?? await defaultRoleDeps()
  const wanted = titleForRole(title, role, lang)
  if (wanted === '' || wanted === title) return false
  return (await deps.rename(rowId, wanted).catch(() => ({ ok: false }))).ok
}

/** Deliver a stored role to a reopened/taken-over session once per role value. */
export async function deliverStoredRole(
  rowId: string,
  conversationId?: string,
  providedDeps?: RoleDeps,
): Promise<boolean> {
  const initial = await serial(async () => {
    const deps = providedDeps ?? await defaultRoleDeps()
    const doc = await loadRoles(deps)
    const key = conversationId ?? rowId
    const role = doc.roles[key] ?? doc.roles[rowId]
    if (!role || doc.lastDeliveredRole?.[key] === role || doc.lastDeliveredRole?.[rowId] === role) return null
    return { deps, key, role }
  })
  if (!initial) return false

  // Input readiness and prompt delivery can join the fleet poll. Never hold the role-store queue
  // across either await: that poll may be waiting to rekey this very session.
  if (initial.deps.waitForInput && !(await initial.deps.waitForInput(rowId).catch(() => false))) return false
  const sent = (await initial.deps.prompt(rowId, roleChangeNote(initial.role)).catch(() => ({ ok: false }))).ok
  if (!sent) return false

  return serial(async () => {
    const latest = await loadRoles(initial.deps)
    const current = latest.roles[initial.key] ?? latest.roles[rowId]
    const delivered = latest.lastDeliveredRole?.[initial.key] ?? latest.lastDeliveredRole?.[rowId]
    if (current !== initial.role || delivered === initial.role) return false
    await writeRolesDoc(initial.deps.dataDir, {
      ...latest,
      lastDeliveredRole: { ...latest.lastDeliveredRole, [initial.key]: initial.role },
    }).catch(() => {})
    return true
  })
}
