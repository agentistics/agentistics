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

import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isSessionRole, isSessionRoleRequest, parseRoleOrigin, resolveSessionForGroup, roleChangeNote, roleLine, sessionIdentityKey, stripRolePrefix, titleForRole,
  type HarnessId, type RoleLang, type RoleOrigin, type SessionRole,
} from '@agentistics/core'
import type { FleetRowForGroups } from './session-groups-web'
import { withFileLock } from './file-lock'

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

/**
 * Atomic and durable: a temp file unique to this write, fsync'd, renamed over the document, then the
 * directory fsync'd. A failed write removes its own temp file — a crash cannot leave a half document,
 * and no `<pid>.tmp` is left behind by an error (`cleanStaleRoleTmps` sweeps what a kill leaves).
 */
export async function writeRolesDoc(dataDir: string, doc: RolesDoc): Promise<void> {
  const file = join(dataDir, SESSION_ROLES_FILE)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const fh = await open(tmp, 'w', 0o600)
    try { await fh.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf-8'); await fh.sync() } finally { await fh.close() }
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  try { const d = await open(dirname(file), 'r'); try { await d.sync() } finally { await d.close() } } catch { /* no directory fsync here */ }
}

/** `session-roles.json.<pid>[.<rand>].tmp` left by a process killed mid-write. */
const ROLE_TMP = /^session-roles\.json\.\d+(?:\.[0-9a-f]+)?\.tmp$/

/** Server start: remove role-document temp files older than `maxAgeMs` (a live write is milliseconds). Never throws. */
export async function cleanStaleRoleTmps(dataDir: string, maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<number> {
  let removed = 0
  const names = await readdir(dataDir).catch(() => [] as string[])
  for (const name of names) {
    if (!ROLE_TMP.test(name)) continue
    const path = join(dataDir, name)
    const st = await stat(path).catch(() => null)
    if (!st?.isFile() || now - st.mtimeMs < maxAgeMs) continue
    if (await rm(path, { force: true }).then(() => true, () => false)) removed++
  }
  return removed
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
  /** Write a retire request on the predecessor (`retire-runner.ts` carries it out). Absent = not wired. */
  requestRetire?: (predecessorId: string, successorId: string) => Promise<boolean>
  /**
   * ORQ.H3 `passagem-sem-sujo`: may the task's leadership change hands, given its worktrees? Absent, or
   * flows off, = passes. A refusal names each dirty worktree and how to release it.
   */
  handoffGate?: (taskId: string) => Promise<{ ok: true } | { ok: false; reason: string; blocking: string[]; runId?: string }>
}

export interface RoleRequest {
  /** The target: managed id, conversation id, exact title or unique id prefix. Absent = the caller itself. */
  ref?: string
  /** Absent = just read. `auto` clears. */
  role?: string
  lang?: string
  /** A leader taking over: the previous leader on the same task, to be closed once it goes quiet. */
  retirePredecessor?: string
}

export type RetireOutcome =
  | { ok: true; id: string; title: string }
  | { ok: false; code: 'not_own' | 'not_leader_target' | 'different_task' | 'not_live' | 'no_task' | 'self' | 'no_such_session' | 'not_wired' }
  | { ok: false; code: 'dirty_worktrees'; reason: string; blocking: string[]; runId?: string }

export type RoleReply =
  | { ok: true; key: string; id?: string; title?: string; role: SessionRole | 'auto'; changed: boolean; renamed: boolean; notified: boolean; origin?: RoleOrigin; warning?: string; retire?: RetireOutcome; line: string; message: string }
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
/**
 * Every read-modify-write of the role document, serialised in this process AND across processes. The
 * spawning CLI (`ensureSpawnRole`) and the server (`roleOp`, `markRoleDelivered`, `rekeyStoredRole`, …)
 * all write this file; a promise chain alone is per process, so two of them overlapping erased the
 * role one had just written (measured 30/10: a worker spawned 1 min after its leader's promotion had no
 * stored role at all). The cross-process half is the registry's own `withFileLock`; each `fn` re-reads
 * the document INSIDE the lock. NOT reentrant: never call `serial` from inside a `serial` body.
 */
let chain: Promise<unknown> = Promise.resolve()
const serial = <T>(dataDir: string | Promise<string>, fn: () => Promise<T>): Promise<T> => {
  const locked = async () => withFileLock(join(await dataDir, SESSION_ROLES_FILE), () => fn())
  const run = chain.then(locked, locked)
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
    const state = await serial(deps.dataDir, async () => {
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
    let retire: RetireOutcome | undefined
    const wantRetire = req.retirePredecessor?.trim()
    if (next === 'leader' && wantRetire) retire = await planPredecessorRetire(wantRetire, { own, senderId, resolved, rows, roles: state.roles, deps })
    // The retired predecessor is no longer "another live leader"; a third one still is.
    const retiredId = retire?.ok ? retire.id : undefined
    let warning: string | undefined
    if (next === 'leader' && deps.taskOf) {
      const taskId = await deps.taskOf(resolved.id)
      if (taskId) {
        const other = (await Promise.all(rows.filter(r => r.id !== resolved.id && r.id !== retiredId && ['working', 'waiting', 'waiting-approval'].includes(r.state ?? '') && roleOfRow(state.roles, r) === 'leader').map(async r =>
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
      await serial(deps.dataDir, async () => {
        const latest = await loadRoles(deps)
        const delivered = { ...(latest.lastDeliveredRole ?? {}) }
        if (next) delivered[key] = next
        else delete delivered[key]
        await writeRolesDoc(deps.dataDir, { ...latest, lastDeliveredRole: delivered }).catch(() => {})
      })
    }
    return {
      ...(warning ? { warning } : {}),
      ...(retire ? { retire } : {}),
      ok: true, ...base, role: next ?? 'auto', changed, renamed, notified, ...(next ? { origin } : {}), line: roleLine(next),
      message: (changed
        ? `Role set to ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}${notified ? '; the session was told' : ''}.`
        : `Role is already ${next ?? 'auto'}${renamed ? '; the title was updated' : ''}.`) + (retire?.ok ? ` ${retire.title} will be closed when it goes quiet.` : '')
        + (retire && !retire.ok && retire.code === 'dirty_worktrees' ? ` The predecessor was NOT retired — ${retire.reason}: ${retire.blocking.join('; ')}.` : '')
        + (warning ? ` ${warning}` : ''),
    }
  })()
}

/** Honour `retirePredecessor`: only the caller's own session, declared leader, retiring a DIFFERENT live leader of the same task. */
async function planPredecessorRetire(
  ref: string,
  c: { own: boolean; senderId: string | null; resolved: FleetRowForGroups; rows: readonly FleetRowForGroups[]; roles: Record<string, SessionRole>; deps: RoleDeps },
): Promise<RetireOutcome> {
  if (!c.own || c.senderId === null) return { ok: false, code: 'not_own' }
  const r = resolveSessionForGroup(c.rows, ref)
  if (!r.ok) return { ok: false, code: 'no_such_session' }
  const pred = r.session
  if (pred.id === c.resolved.id) return { ok: false, code: 'self' }
  if (!['working', 'waiting', 'waiting-approval'].includes(pred.state ?? '')) return { ok: false, code: 'not_live' }
  if (roleOfRow(c.roles, pred) !== 'leader') return { ok: false, code: 'not_leader_target' }
  const mine = await c.deps.taskOf?.(c.resolved.id).catch(() => undefined)
  if (!mine) return { ok: false, code: 'no_task' }
  if ((await c.deps.taskOf?.(pred.id).catch(() => undefined)) !== mine) return { ok: false, code: 'different_task' }
  // FAIL CLOSED: a gate that throws keeps the predecessor (its work could not be shown saved).
  const gate: HandoffGateAnswer = c.deps.handoffGate
    ? await c.deps.handoffGate(mine).catch((e: unknown): HandoffGateAnswer => ({ ok: false, reason: `the hand-off gate failed: ${e instanceof Error ? e.message : String(e)}`, blocking: [] }))
    : { ok: true }
  if (!gate.ok) return { ok: false, code: 'dirty_worktrees', reason: gate.reason, blocking: gate.blocking, ...(gate.runId ? { runId: gate.runId } : {}) }
  if (!c.deps.requestRetire || !(await c.deps.requestRetire(pred.id, c.resolved.id).catch(() => false))) return { ok: false, code: 'not_wired' }
  return { ok: true, id: pred.id, title: pred.title }
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
    requestRetire: async (predecessorId, successorId) => (await import('./team-links-io')).requestRetire(predecessorId, successorId),
    handoffGate: handoffGateFor,
  }
}

/** The hand-off gate through the engine's `passagem-sem-sujo` flow; flows off or absent = passes. */
export async function handoffGateFor(taskId: string): Promise<HandoffGateAnswer> {
  const { flowsExperimentalOn } = await import('../native-gate')
  if (!flowsExperimentalOn()) return { ok: true }
  const load = await import('../engine/load')
  await load.loadEngine({ log: () => {} })
  const flows = load.engine()?.flows
  if (!flows || !flows.list().includes('passagem-sem-sujo')) return { ok: true }
  return gateAnswerOf(await flows.run('passagem-sem-sujo', { taskId }))
}

/** PURE. Only a `success` run passes: `refused` lists the blockers; `failed`, `interrupted` or anything unreadable REFUSES. */
export function gateAnswerOf(raw: unknown): HandoffGateAnswer {
  const run = (raw && typeof raw === 'object' ? raw : {}) as { runId?: string; status?: string; output?: unknown; refusal?: { reason?: string; missing?: string[] } }
  const id = run.runId ? { runId: run.runId } : {}
  if (run.status === 'success') return { ok: true }
  if (run.status === 'refused') return { ok: false, reason: run.refusal?.reason ?? 'hand-off refused', blocking: run.refusal?.missing ?? [], ...id }
  return { ok: false, reason: `the hand-off gate did not finish (${run.status ?? 'no status'}), so uncommitted work could not be ruled out`, blocking: [], ...id }
}

export type HandoffGateAnswer = { ok: true } | { ok: false; reason: string; blocking: string[]; runId?: string }

/**
 * The same gate for a CLI `--handoff`, asked of the SERVER (`POST /api/flows/run`): the server's flag and
 * engine decide, never this process's environment (`AGENTISTICS_FLOWS=0 agentop …` must not skip it).
 * The server saying flows are off, or that it has no engine/gate, passes; a server that cannot be asked,
 * or an answer that cannot be read, REFUSES.
 */
export async function handoffGateViaServer(taskId: string, o: { fetch?: typeof fetch; port?: number } = {}): Promise<HandoffGateAnswer> {
  const port = o.port ?? (await import('../config')).PORT
  const cannot = (why: string): HandoffGateAnswer => ({ ok: false, reason: `could not check the task's uncommitted work with the agentistics server (${why}); start it, or ask the owner to force the hand-off`, blocking: [] })
  let res: Response
  try {
    res = await (o.fetch ?? fetch)(`http://127.0.0.1:${port}/api/flows/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'passagem-sem-sujo', inputs: { taskId } }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) { return cannot(e instanceof Error ? e.message : String(e)) }
  const body = await res.json().catch(() => null) as { error?: string; sentence?: string; status?: string; runId?: string; refusal?: { reason?: string; missing?: string[] } } | null
  if (res.status === 403 && body?.error === 'experimental') return { ok: true }
  if (res.status === 501 && body?.error === 'official_build') return { ok: true }
  if (res.status === 400 && body?.error === 'flow_failed' && /fluxo desconhecido/.test(body.sentence ?? '')) return { ok: true }
  if (!res.ok || !body || typeof body.status !== 'string') return cannot(`HTTP ${res.status}`)
  return gateAnswerOf(body)
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
  const depsP = providedDeps ? Promise.resolve(providedDeps) : defaultRoleDeps()
  return serial(depsP.then(d => d.dataDir), async () => {
    const deps = await depsP
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

/** The spawn context already carried this role, so a later reopen must not type it again. */
export async function markRoleDelivered(
  keys: readonly (string | undefined)[],
  role: SessionRole,
  providedDeps?: Pick<RoleDeps, 'dataDir' | 'legacyPref'>,
): Promise<void> {
  const depsP = providedDeps ? Promise.resolve(providedDeps) : defaultRoleDeps()
  return serial(depsP.then(d => d.dataDir), async () => {
    const deps = await depsP
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
  const depsP = providedDeps ? Promise.resolve(providedDeps) : defaultRoleDeps()
  return serial(depsP.then(d => d.dataDir), async () => {
    const deps = await depsP
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
  const depsP = providedDeps ? Promise.resolve(providedDeps) : defaultRoleDeps()
  const initial = await serial(depsP.then(d => d.dataDir), async () => {
    const deps = await depsP
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

  return serial(initial.deps.dataDir, async () => {
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
