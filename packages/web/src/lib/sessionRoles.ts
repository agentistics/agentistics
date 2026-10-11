import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'

export type SessionRole = 'leader' | 'worker'
export type SessionRoles = Record<string, SessionRole>

const parseRoles = (raw: unknown): SessionRoles | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: SessionRoles = {}
  for (const [id, role] of Object.entries(raw)) {
    if (role === 'leader' || role === 'worker') out[id] = role
  }
  return out
}

const roles = createSharedPref<SessionRoles>({
  key: 'agentistics-session-roles', prefKey: 'sessionRoles', fallback: {}, parse: parseRoles,
})
const muted = createSharedPref<boolean>({
  key: 'agentistics-mute-workers', prefKey: 'muteWorkers', fallback: false,
  parse: raw => typeof raw === 'boolean' ? raw : null,
})

export function getSessionRole(id: string): SessionRole | undefined { return roles.get()[id] }
export function setSessionRole(id: string, role: SessionRole | null): void {
  const next = { ...roles.get() }
  if (role) next[id] = role
  else delete next[id]
  roles.set(next)
}
export function getMuteWorkers(): boolean { return muted.get() }
export function setMuteWorkers(value: boolean): void { muted.set(value) }
export function isWorkerMuted(id: string): boolean { return muted.get() && roles.get()[id] === 'worker' }
export function useSessionRole(id: string): SessionRole | undefined {
  return useSyncExternalStore(roles.subscribe, () => getSessionRole(id), () => undefined)
}
export function useSessionRoles(): SessionRoles { return useSyncExternalStore(roles.subscribe, roles.get, roles.serverSnapshot) }
export function useMuteWorkers(): boolean { return useSyncExternalStore(muted.subscribe, muted.get, muted.serverSnapshot) }

