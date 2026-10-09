import type { SessionMeta, SurfaceHarnessId } from './types'
import { SURFACE_HARNESS_ORDER } from './types'

export const NO_REPO_KEY = '__no_repo__'

export function tagUser(session: SessionMeta, user: string): SessionMeta {
  return { ...session, user }
}

export function distinctUsers(sessions: SessionMeta[]): string[] {
  const set = new Set<string>()
  for (const s of sessions) if (s.user) set.add(s.user)
  return Array.from(set).sort()
}

export function distinctHarnesses(sessions: { harness?: SurfaceHarnessId }[]): SurfaceHarnessId[] {
  const set = new Set<SurfaceHarnessId>()
  for (const s of sessions) set.add(s.harness ?? 'claude')
  return SURFACE_HARNESS_ORDER.filter(h => set.has(h))
}

export function filterByUsers<T extends { user?: string }>(sessions: T[], users: string[]): T[] {
  if (!users || users.length === 0) return sessions
  const set = new Set(users)
  return sessions.filter(s => !!s.user && set.has(s.user))
}

export function filterByHarnesses<T extends { harness?: SurfaceHarnessId }>(sessions: T[], harnesses: SurfaceHarnessId[]): T[] {
  if (!harnesses || harnesses.length === 0) return sessions
  const set = new Set(harnesses)
  return sessions.filter(s => set.has(s.harness ?? 'claude'))
}

export function filterByTeams<T extends { teamId?: string; teamIds?: string[] }>(sessions: T[], teams: string[]): T[] {
  if (!teams || teams.length === 0) return sessions
  const set = new Set(teams)
  return sessions.filter(s => (s.teamIds?.length ? s.teamIds : s.teamId ? [s.teamId] : []).some(t => set.has(t)))
}

export function filterByMachines<T extends { memberId?: string }>(sessions: T[], machines: string[]): T[] {
  if (!machines || machines.length === 0) return sessions
  const set = new Set(machines)
  return sessions.filter(s => !!s.memberId && set.has(s.memberId))
}

export function resolveMachineCacheScope(_input?: unknown): string[] | null {
  return null
}

export const PUSH_INTERVAL = { MIN_SEC: 15, MAX_SEC: 3600, DEFAULT_SEC: 30, EXPRESS_MIN_SEC: 5 } as const
export function clampPushInterval(sec: number, minSec = PUSH_INTERVAL.MIN_SEC): number {
  if (!Number.isFinite(sec) || sec <= 0) return PUSH_INTERVAL.DEFAULT_SEC
  return Math.min(PUSH_INTERVAL.MAX_SEC, Math.max(minSec, Math.round(sec)))
}

export function packConnectToken(secret: string, endpoint?: string): string {
  const url = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!url) return secret
  return `act1_${btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${secret}`
}

export function unpackConnectToken(token: string): { endpoint?: string; secret: string } {
  const t = (token ?? '').trim()
  if (t.startsWith('act1_') && t.includes('.')) {
    const rest = t.slice(5); const dot = rest.indexOf('.')
    try { const endpoint = atob(rest.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/')); const secret = rest.slice(dot + 1); if (endpoint && secret) return { endpoint, secret } } catch { /* raw */ }
  }
  return { secret: t }
}
