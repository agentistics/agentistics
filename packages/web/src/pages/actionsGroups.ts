import type { SessionMeta } from '@agentistics/core'

/** CI runs only; newest repository first, with unlinked runs always last. */
export function groupCiSessions(sessions: SessionMeta[]): { remote: string; sessions: SessionMeta[] }[] {
  const groups = new Map<string, SessionMeta[]>()
  for (const session of sessions) {
    if (session.ci !== true) continue
    const remote = session.git_remote ?? ''
    const group = groups.get(remote) ?? []
    group.push(session)
    groups.set(remote, group)
  }
  const startedAt = (session: SessionMeta) => {
    const at = Date.parse(session.start_time)
    return Number.isFinite(at) ? at : -Infinity
  }
  return [...groups].map(([remote, runs]) => ({
    remote,
    sessions: runs.sort((a, b) => startedAt(b) - startedAt(a)),
  })).sort((a, b) => {
    if (a.remote === '') return 1
    if (b.remote === '') return -1
    return startedAt(b.sessions[0]!) - startedAt(a.sessions[0]!) || a.remote.localeCompare(b.remote)
  })
}
