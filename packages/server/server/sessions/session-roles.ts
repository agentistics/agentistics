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
 *   2. a background note typed into the session ("[from agentistics · role] …") through the
 *      composer's own send path — skipped when the session changes ITS OWN role (the tool answer
 *      carries the line instead of typing into the pane that is running the tool);
 *   3. nothing else. The role grants no power; it is what the briefing tells the model.
 *
 * Dependencies are injected so the rules are testable with a fake host.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isSessionRole, isSessionRoleRequest, parseRoleOrigin, resolveSessionForGroup, roleChangeNote, roleLine, sessionIdentityKey, stripRolePrefix, titleForRole,
  type HarnessId, type RoleLang, type RoleOrigin, type SessionRole,
} from '@agentistics/core'
import type { FleetRowForGroups } from './session-groups-web'

export const SESSION_ROLES_FILE = 'session-roles.json'

export interface RolesDoc {
  version: 1
  /** The legacy web preference (`ui.sessionRoles`) was folded in. Done once, never again. */
  migrated: boolean
  roles: Record<string, SessionRole>
  /** Assignment time in milliseconds, keyed like `roles`; absent on legacy entries. */
  at?: Record<string, number>
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

export function parseRoleTimes(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

export async function readRolesDoc(dataDir: string): Promise<RolesDoc> {
  try {
    const p = JSON.parse(await readFile(join(dataDir, SESSION_ROLES_FILE), 'utf-8')) as Partial<RolesDoc>
    return {
      version: 1,
      migrated: p.migrated === true,
      roles: parseRoles(p.roles),
      at: parseRoleTimes(p.at),
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
  taskOf?: (rowId: string) => Promise<string | undefined>
  parentOf: (rowId: string) => Promise<string | undefined>
  /** A session declared LEADER leaves its parent's team (`team-links.ts`, rule 2). Absent = not wired. */
  leaveTeam?: (rowId: string) => Promise<boolean>
}

export interface RoleRequest {
  /** The target: managed id, conversation id, exact title or unique id prefix. Absent = the caller itself. */
  ref?: string
  /** Absent = just read. `auto` clears. */
  role?: string
  lang?: string
}

export type RoleReply =
  | { ok: true; key: string; id?: string; title?: string; role: SessionRole | 'auto'; changed: boolean; renamed: boolean; notified: boolean; origin?: RoleOrigin; warning?: string; line: string; message: string }
  | { ok: false; code: string; message: string; matches?: string[] }

const MESSAGES: Record<string, string> = {
  unverified_sender: 'Only a session started by agentistics can set session roles; this request could not prove which session it comes from.',
  missing_argument: 'A session reference is required.',
  bad_role: 'role must be leader, worker or auto.',
  no_such_session: 'No session on this machine matches that reference.',
  ambiguous_session: 'More than one session matches that reference; use its id.',
  not_your_child: 'A session may set another session\'s role only for sessions it started itself.',
}

const UNVERIFIED_PT = 'Só uma sessão iniciada pelo agentistics pode definir papéis de sessão; esta chamada não conseguiu provar de qual sessão vem.'
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
      const at = { ...(doc.at ?? {}) }
      delete roles[resolved.id]
      delete origins[resolved.id]
      if (next) { roles[key] = next; origins[key] = origin; at[key] = Date.now() }
      else { delete roles[key]; delete origins[key]; delete at[key] }
      await writeRolesDoc(deps.dataDir, { ...doc, roles, origins, at })
      return { kind: 'change' as const, doc, roles, base, current, next, changed }
    })
    if (state.kind !== 'change') return state.reply

    const { base, next, changed } = state
    // A leader sits at the ROOT with the other leaders, never as another leader's worker.
    if (next === 'leader' && deps.leaveTeam) await deps.leaveTeam(resolved.id).catch(() => false)
    let warning: string | undefined
    if (next === 'leader' && deps.taskOf) {
      const taskId = await deps.taskOf(resolved.id)
      if (taskId) {
        const other = (await Promise.all(rows.filter(r => r.id !== resolved.id && ['working', 'waiting', 'waiting-approval'].includes(r.state ?? '') && roleOfRow(state.roles, r) === 'leader').map(async r =>
          await deps.taskOf!(r.id) === taskId ? r : undefined))).find(Boolean)
        if (other) warning = `Another live leader on task ${taskId}: ${other.title} (${other.id}).`
      }
    }
    const lang: RoleLang = req.lang === 'pt' || req.lang === 'en' ? req.lang : await deps.uiLang().catch(() => 'en' as RoleLang)
    // External title/note I/O stays outside `serial`; either can wait for the fleet poll.
    const wanted = next === 'leader' && isPlaceholderTitle(resolved.title) ? resolved.title : titleForRole(resolved.title, next, lang)
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
      ...(warning ? { warning } : {}),
      ok: true, ...base, role: next ?? 'auto', changed, renamed, notified, ...(next ? { origin } : {}), line: roleLine(next),
      message: (changed
        ? `Role set to ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}${notified ? '; the session was told' : ''}.`
        : `Role is already ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}.`) + (warning ? ` ${warning}` : ''),
    }
  })()
}

/**
 * The origin to record for a role assigned at spawn: a leader only when the parent id was PROVEN by the
 * request (`verified`) and is a row in the registry; anything else is the person's (`manual`).
 */
export function spawnRoleOrigin(parentId: string | undefined, verified: boolean, registryIds: Iterable<string>): RoleOrigin {
  if (!parentId || !verified) return 'manual'
  for (const id of registryIds) if (id === parentId) return { leader: parentId }
  return 'manual'
}

/** `spawnRoleOrigin` against the live registry. */
export async function spawnRoleOriginFor(parentId: string | undefined, verified: boolean): Promise<RoleOrigin> {
  if (!parentId || !verified) return 'manual'
  const { readRegistry } = await import('./registry')
  return spawnRoleOrigin(parentId, verified, (await readRegistry().catch(() => [])).map(m => m.id))
}

/**
 * Who is asking `/api/session-roles`. A body with NO `session` key is the browser/CLI (the person). A body
 * that carries the key must prove it: null, missing or invalid is `unverified_sender` — an MCP outside an
 * agentop pane must never be taken for the person.
 */
export async function roleSenderFromBody(
  body: { session?: unknown },
  verify: (id: unknown, token: unknown) => Promise<string | null>,
  lang?: string,
): Promise<{ ok: true; sender: string | null } | { ok: false; code: string; message: string }> {
  if (!('session' in body)) return { ok: true, sender: null }
  const s = body.session as { id?: unknown; token?: unknown } | null
  const sender = s && typeof s === 'object' ? await verify(s.id, s.token) : null
  if (sender) return { ok: true, sender }
  return { ok: false, code: 'unverified_sender', message: lang === 'pt' ? UNVERIFIED_PT : MESSAGES.unverified_sender! }
}

/**
 * `parentVerified` for `/api/fleet/new` is the SERVER's statement, never the wire's: whatever arrived in the
 * body is overwritten, and it is true only when the body's `session` proof is valid and names the `parent`.
 */
export async function markParentVerified(
  body: { parent?: unknown; parentVerified?: unknown; session?: unknown },
  verify: (id: unknown, token: unknown) => Promise<string | null>,
): Promise<boolean> {
  const proof = body.session as { id?: unknown; token?: unknown } | null | undefined
  const proven = proof && typeof proof === 'object' ? await verify(proof.id, proof.token) : null
  const ok = proven !== null && typeof body.parent === 'string' && body.parent.trim() === proven
  body.parentVerified = ok
  return ok
}

/**
 * PLAN.ACCOUNTS D3: `callerVerified` for `/api/fleet/new` — the request carries a VALID session proof,
 * i.e. an agent is asking (whatever `parent` it names). The SERVER's statement: whatever arrived is
 * overwritten. Only then is an account that is off for agents refused (`spawn-account.ts`).
 */
export async function markCallerVerified(
  body: { session?: unknown; callerVerified?: unknown },
  verify: (id: unknown, token: unknown) => Promise<string | null>,
): Promise<boolean> {
  const proof = body.session as { id?: unknown; token?: unknown } | null | undefined
  const ok = !!proof && typeof proof === 'object' && (await verify(proof.id, proof.token)) !== null
  body.callerVerified = ok
  return ok
}

export function roleStatus(out: RoleReply): number {
  if (!out.ok && out.code === 'unverified_sender') return 403
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
    taskOf: async rowId => (await (await import('./registry')).readRegistry()).find(m => m.id === rowId)?.taskId,
    parentOf: async rowId => (await (await import('./registry')).readRegistry()).find(m => m.id === rowId)?.parentSessionId,
    leaveTeam: async rowId => (await import('./team-links-io')).leaveTeamAsLeader(rowId),
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
    const at = { ...(doc.at ?? {}) }
    const assignedAt = Date.now()
    for (const key of nonEmpty) { roles[key] = desired; origins[key] = origin; at[key] = assignedAt }
    await writeRolesDoc(deps.dataDir, { ...doc, roles, origins, at })
    return desired
  })
}

/**
 * AUTO → LEADER. A session with NO stored role (automatic) that starts a WORKER of its own has
 * declared itself a leader by doing it: record `leader` with origin `inferred`, apply the leader title
 * and leave the parent's team, exactly as a declared leader would. Never touches a session that
 * already has a role (a declared worker that spawns stays a worker — the person or it said so), and
 * only for a VERIFIED parent that is a row of this fleet. No note is typed: the parent is the one
 * running the spawn right now, and the caller prints the line in its own answer instead.
 */
export async function promoteSpawningParent(
  parentId: string | undefined,
  verified: boolean,
  lang: RoleLang,
  providedDeps?: RoleDeps,
): Promise<{ promoted: boolean; renamed: boolean }> {
  if (!parentId || !verified) return { promoted: false, renamed: false }
  const deps = providedDeps ?? await defaultRoleDeps()
  const rows = await deps.rows().catch(() => [] as FleetRowForGroups[])
  const parent = rows.find(r => r.id === parentId || r.conversationId === parentId)
  if (!parent) return { promoted: false, renamed: false }
  const promoted = await serial(async () => {
    const doc = await loadRoles(deps)
    if (roleOfRow(doc.roles, parent)) return false
    const key = sessionIdentityKey(parent)
    const roles = { ...doc.roles, [key]: 'leader' as SessionRole }
    const origins = { ...(doc.origins ?? {}), [key]: 'inferred' as RoleOrigin }
    const at = { ...(doc.at ?? {}), [key]: Date.now() }
    // The parent is told in the spawn's own answer, so the reopen path must not type it again.
    const lastDeliveredRole = { ...(doc.lastDeliveredRole ?? {}), [key]: 'leader' as SessionRole }
    await writeRolesDoc(deps.dataDir, { ...doc, roles, origins, at, lastDeliveredRole })
    return true
  })
  if (!promoted) return { promoted: false, renamed: false }
  if (deps.leaveTeam) await deps.leaveTeam(parent.id).catch(() => false)
  const renamed = await applyRoleTitle(parent.id, parent.title, 'leader', lang, deps).catch(() => false)
  return { promoted: true, renamed }
}

/**
 * `promoteSpawningParent` against the REGISTRY rather than a fleet poll: the spawn doors run in the
 * CLI process too, where a poll of the whole fleet would cost seconds for one row the registry holds.
 */
export async function promoteSpawningParentNow(parentId: string | undefined, verified: boolean, lang: RoleLang): Promise<{ promoted: boolean; renamed: boolean }> {
  if (!parentId || !verified) return { promoted: false, renamed: false }
  const deps = await defaultRoleDeps()
  const { readRegistry } = await import('./registry')
  return promoteSpawningParent(parentId, verified, lang, {
    ...deps,
    rows: async () => (await readRegistry()).map(m => ({ id: m.id, ...(m.conversationId ? { conversationId: m.conversationId } : {}), title: m.label ?? m.harnessName ?? m.id, harness: m.harness })),
  })
}

/** The line a spawn answer carries when it just made its caller a leader. */
export const PROMOTED_PARENT_LINE = '[agentistics] you started a worker, so your role is now LEADER (it was automatic). ' + roleLine('leader')

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
    const at = { ...(doc.at ?? {}) }
    const fromOrigin = from.map(k => doc.origins?.[k]).find(o => !!o)
    const lastDeliveredRole = { ...(doc.lastDeliveredRole ?? {}) }
    // Rekeying can see assignments made independently under the managed and conversation keys. Recency,
    // rather than which side happens to be the target, determines the winner. Legacy entries have no `at`
    // and therefore lose to any timestamped entry; equal timestamps deliberately prefer the source key.
    const sourceKey = from.find(k => doc.roles[k])
    const sourceAt = sourceKey ? doc.at?.[sourceKey] : undefined
    const targetKey = to.find(k => doc.roles[k])
    const targetAt = targetKey ? doc.at?.[targetKey] : undefined
    const targetWins = targetKey && targetAt !== undefined && (sourceAt === undefined || targetAt > sourceAt)
    const heldKey = targetWins ? targetKey : sourceKey ?? targetKey
    const effective = heldKey ? doc.roles[heldKey] : role
    const effectiveOrigin = heldKey ? doc.origins?.[heldKey] : fromOrigin
    const effectiveAt = heldKey ? doc.at?.[heldKey] : undefined
    for (const key of to) {
      if (effective) {
        roles[key] = effective
        if (effectiveOrigin) origins[key] = effectiveOrigin
        if (effectiveAt !== undefined) at[key] = effectiveAt
        else delete at[key]
      }
      if (delivered && !lastDeliveredRole[key]) lastDeliveredRole[key] = delivered
    }
    for (const key of from) {
      if (!to.includes(key)) {
        delete roles[key]
        delete origins[key]
        delete at[key]
        delete lastDeliveredRole[key]
      }
    }
    await writeRolesDoc(deps.dataDir, { ...doc, roles, origins, lastDeliveredRole }).catch(() => {})
  })
}

/** Apply the leader title convention through the same rename dependency used by role changes. */
/** The placeholder a row shows before its harness reports a title (`sessUnregistered`, en + pt): never
 *  mint a leader title out of it — leave it alone until the real title arrives. */
export function isPlaceholderTitle(title: string): boolean {
  return /^(?:unregistered session|sessão sem registro) [0-9a-z-]{6,}$/i.test(stripRolePrefix(title).trim())
}

export async function applyRoleTitle(
  rowId: string,
  title: string,
  role: SessionRole,
  lang: RoleLang,
  providedDeps?: RoleDeps,
): Promise<boolean> {
  if (role === 'leader' && isPlaceholderTitle(title)) return false
  const wanted = titleForRole(title, role, lang)
  if (wanted === '' || wanted === title) return false
  const deps = providedDeps ?? await defaultRoleDeps()
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
