import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'

export type SessionRole = 'leader' | 'worker'
export type SessionRoles = Record<string, SessionRole>
/** Who set a role — mirrors the core `RoleOrigin`; an entry with none was the person's. */
export type RoleOrigin = 'manual' | 'auto' | { leader: string }
export type RoleOrigins = Record<string, RoleOrigin>

/** The title to print for a leader origin: only the current parent can be named, and only when it IS that leader. */
export function leaderTitleFor(origin: RoleOrigin | undefined, parent: { id: string; title?: string } | null | undefined): string | undefined {
  return origin && typeof origin === 'object' && parent && parent.id === origin.leader ? parent.title : undefined
}

/** The ⓘ's wording for who set the role. */
export function roleOriginLabel(origin: RoleOrigin | undefined, pt: boolean, leaderTitle?: string): string {
  if (origin === 'auto') return pt ? 'definido pela própria sessão' : 'set by the session itself'
  if (origin && typeof origin === 'object') {
    if (leaderTitle) return pt ? `definido pelo líder ${leaderTitle}` : `set by leader ${leaderTitle}`
    return pt ? 'definido por um líder' : 'set by a leader'
  }
  return pt ? 'definido por você' : 'set by you'
}
const roleAliases = new Map<string, string>()

// The roles live on the SERVER (`/api/session-roles`): it renames the session, tells it and stores the
// role. This module is a cache of that map — optimistic on a change, refreshed while someone watches
// (a session can set its own role through the MCP tool).
const parseRoles = (raw: unknown): SessionRoles => {
  const out: SessionRoles = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, role] of Object.entries(raw)) if (role === 'leader' || role === 'worker') out[id] = role
  return out
}

let cache: SessionRoles = {}
let rolesReady = false
let originCache: RoleOrigins = {}
const parseOrigins = (raw: unknown): RoleOrigins => {
  const out: RoleOrigins = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, o] of Object.entries(raw as Record<string, unknown>)) {
    if (o === 'manual' || o === 'auto') out[id] = o
    else if (o && typeof o === 'object' && typeof (o as { leader?: unknown }).leader === 'string') out[id] = { leader: (o as { leader: string }).leader }
  }
  return out
}
let pendingWrites = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

export async function refreshRoles(): Promise<void> {
  if (pendingWrites > 0) return
  try {
    const res = await fetch('/api/session-roles')
    if (!res.ok) return
    const body = (await res.json()) as { roles?: unknown; origins?: unknown }
    const next = parseRoles(body.roles)
    const nextOrigins = parseOrigins(body.origins)
    if (pendingWrites > 0) return
    const firstAnswer = !rolesReady
    rolesReady = true
    if (firstAnswer || JSON.stringify(next) !== JSON.stringify(cache) || JSON.stringify(nextOrigins) !== JSON.stringify(originCache)) { cache = next; originCache = nextOrigins; emit() }
  } catch { /* offline or no host power: keep what we have */ }
}

/**
 * Ask the server for the roles NOW, whatever is being written: the pre-notify check must see a
 * fresh answer, which `refreshRoles` (skipped while a write is pending) cannot promise. One GET is
 * shared by every caller in flight; a pending local write keeps its optimistic entry, the server's
 * answer fills in the rest. A session checked within `CHECKED_TTL_MS` is not asked about again.
 */
const CHECKED_TTL_MS = 10_000
const checkedAt = new Map<string, number>()
let freshInflight: Promise<boolean> | null = null
/** Bumped by every role write / refresh; a GET started before the bump cannot answer a later need. */
let roleGen = 0
let freshInflightGen = 0
/** When the shared GET was sent: a role written by ANOTHER process (spawn, CLI, MCP) bumps no local
 *  counter, so a caller may only join a GET sent after its need arose (`needSince`). */
let freshInflightAt = 0
let warnedFailOpen = false
async function fetchRolesFresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/session-roles')
    if (!res.ok) return false
    const body = (await res.json()) as { roles?: unknown; origins?: unknown }
    const next = parseRoles(body.roles)
    const nextOrigins = parseOrigins(body.origins)
    const merged = pendingWrites > 0 ? { ...next, ...cache } : next
    const mergedOrigins = pendingWrites > 0 ? { ...nextOrigins, ...originCache } : nextOrigins
    const firstAnswer = !rolesReady
    rolesReady = true
    if (firstAnswer || JSON.stringify(merged) !== JSON.stringify(cache) || JSON.stringify(mergedOrigins) !== JSON.stringify(originCache)) { cache = merged; originCache = mergedOrigins; emit() }
    return true
  } catch { return false }
}
export async function ensureRoleFresh(id: string, now: number = Date.now(), needSince: number = now): Promise<void> {
  const last = checkedAt.get(id)
  if (last !== undefined && now - last < CHECKED_TTL_MS) return
  const gen = roleGen
  // Join only a GET that started at or after this need; otherwise it may predate our write.
  if (!freshInflight || freshInflightGen < gen || freshInflightAt < needSince) {
    freshInflightGen = gen
    freshInflightAt = Date.now()
    const p: Promise<boolean> = fetchRolesFresh().finally(() => { if (freshInflight === p) freshInflight = null })
    freshInflight = p
  }
  const ok = await freshInflight
  if (ok) { if (gen === roleGen) checkedAt.set(id, now) }
  else if (!warnedFailOpen) { warnedFailOpen = true; console.warn('[roles] pre-notify role check failed; delivering without it') }
}
/** Test seam: forget which sessions were already checked. */
export function __resetRoleChecksForTest(): void { checkedAt.clear(); freshInflight = null; roleGen = 0; freshInflightGen = 0; freshInflightAt = 0; warnedFailOpen = false }

let timer: ReturnType<typeof setInterval> | null = null
const rolesStore = {
  get: (): SessionRoles => cache,
  serverSnapshot: (): SessionRoles => ({}),
  subscribe(l: () => void): () => void {
    listeners.add(l)
    if (!timer) { void refreshRoles(); timer = setInterval(() => void refreshRoles(), 10_000) }
    return () => {
      listeners.delete(l)
      if (listeners.size === 0 && timer) { clearInterval(timer); timer = null }
    }
  },
}
const roles = rolesStore
const muted = createSharedPref<boolean>({
  key: 'agentistics-mute-workers', prefKey: 'muteWorkers', fallback: false,
  parse: raw => typeof raw === 'boolean' ? raw : null,
})

export function getSessionRole(id: string): SessionRole | undefined {
  return roles.get()[id] ?? (roleAliases.get(id) ? roles.get()[roleAliases.get(id)!] : undefined)
}
export function getSessionRoleOrigin(id: string): RoleOrigin | undefined {
  const key = originCache[id] !== undefined || cache[id] ? id : roleAliases.get(id)
  return key ? originCache[key] : undefined
}
export function setSessionRole(id: string, role: SessionRole | null): void {
  const next = { ...cache }
  const nextOrigins = { ...originCache }
  // A choice made in the UI is the person's.
  if (role) { next[id] = role; nextOrigins[id] = 'manual' }
  else { delete next[id]; delete nextOrigins[id] }
  cache = next
  originCache = nextOrigins
  roleGen++
  checkedAt.clear()
  emit()
  pendingWrites++
  void (async () => {
    try {
      await fetch('/api/session-roles', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: id, role: role ?? 'auto' }),
      })
    } catch { /* the cache keeps the choice until the next refresh reconciles it */ }
    finally { pendingWrites--; roleGen++; checkedAt.clear(); void refreshRoles() }
  })()
}
/** Test seam: replace the cache the way a server answer would. */
export function __setRolesForTest(next: SessionRoles): void { cache = next }
export function getMuteWorkers(): boolean { return muted.get() }
export function setMuteWorkers(value: boolean): void { muted.set(value) }
export function isWorkerMuted(id: string, state?: string): boolean {
  // Notification callers use both fleet state names and event names. Keep the ended-session
  // exception explicit: an exited worker may still announce that it closed, while turn completion,
  // approval and stale/working events all belong to an active worker.
  const active = state === undefined || ['working', 'waiting', 'waiting-approval', 'stale', 'unknown', 'turn-done', 'responded', 'needs-approval'].includes(state)
  return active && muted.get() && getSessionRole(id) === 'worker'
}
/** Associate a managed id with the stable conversation key, so a role stored under either is found. */
export function registerSessionRoleAlias(id: string, stableKey: string): void {
  if (!id || !stableKey || id === stableKey) return
  roleAliases.set(id, stableKey)
  // Notifications may be called with either identity, before the sidebar has rendered. Register
  // the reverse lookup too so a role stored under the managed id is found from the conversation key.
  roleAliases.set(stableKey, id)
}
export function useSessionRole(id: string): SessionRole | undefined {
  return useSyncExternalStore(roles.subscribe, () => getSessionRole(id), () => undefined)
}
export function useSessionRoleOrigin(id: string): RoleOrigin | undefined {
  return useSyncExternalStore(roles.subscribe, () => getSessionRoleOrigin(id), () => undefined)
}
export function useSessionRoles(): SessionRoles { return useSyncExternalStore(roles.subscribe, roles.get, roles.serverSnapshot) }
export function useMuteWorkers(): boolean { return useSyncExternalStore(muted.subscribe, muted.get, muted.serverSnapshot) }

/** Whether the role store has answered at least once; an unanswered map is not zero leaders. */
export function useSessionRolesReady(): boolean { return useSyncExternalStore(roles.subscribe, () => rolesReady, () => false) }
