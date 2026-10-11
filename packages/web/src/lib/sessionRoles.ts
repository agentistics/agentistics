import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'

export type SessionRole = 'leader' | 'worker'
export type SessionRoles = Record<string, SessionRole>
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
let pendingWrites = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

async function refreshRoles(): Promise<void> {
  if (pendingWrites > 0) return
  try {
    const res = await fetch('/api/session-roles')
    if (!res.ok) return
    const next = parseRoles(((await res.json()) as { roles?: unknown }).roles)
    if (pendingWrites > 0) return
    if (JSON.stringify(next) !== JSON.stringify(cache)) { cache = next; emit() }
  } catch { /* offline or no host power: keep what we have */ }
}

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
export function setSessionRole(id: string, role: SessionRole | null): void {
  const next = { ...cache }
  if (role) next[id] = role
  else delete next[id]
  cache = next
  emit()
  pendingWrites++
  void (async () => {
    try {
      await fetch('/api/session-roles', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: id, role: role ?? 'auto' }),
      })
    } catch { /* the cache keeps the choice until the next refresh reconciles it */ }
    finally { pendingWrites--; void refreshRoles() }
  })()
}
export function getMuteWorkers(): boolean { return muted.get() }
export function setMuteWorkers(value: boolean): void { muted.set(value) }
export function isWorkerMuted(id: string, state?: string): boolean {
  const active = state === undefined || ['working', 'waiting', 'waiting-approval', 'unknown'].includes(state)
  return active && muted.get() && getSessionRole(id) === 'worker'
}
/** Associate a managed id with the stable conversation key, so a role stored under either is found. */
export function registerSessionRoleAlias(id: string, stableKey: string): void {
  if (!id || !stableKey || id === stableKey) return
  roleAliases.set(id, stableKey)
}
export function useSessionRole(id: string): SessionRole | undefined {
  return useSyncExternalStore(roles.subscribe, () => getSessionRole(id), () => undefined)
}
export function useSessionRoles(): SessionRoles { return useSyncExternalStore(roles.subscribe, roles.get, roles.serverSnapshot) }
export function useMuteWorkers(): boolean { return useSyncExternalStore(muted.subscribe, muted.get, muted.serverSnapshot) }
