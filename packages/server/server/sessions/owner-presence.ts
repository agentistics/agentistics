/** Owner presence and wait episodes. No prompt is ever sent by this module. */
export const WAIT_NOTICE_MS = 5 * 60_000
export const PRESENCE_TTL_MS = 45_000
export interface PresenceReport { client: string; session: string | null; visible: boolean; focused: boolean; interacted: boolean }
export interface OwnerPresence { client: string; session: string | null; lastSeenAt: number; lastInteractionAt: number }
export interface WaitingSession { id: string; conversationId?: string; title: string; waiting: boolean; since?: number }
export interface WaitNotice { id: string; session: string; title: string }
interface Episode { since: number; announced: boolean; opened: boolean }
export function createOwnerPresence() {
  const clients = new Map<string, OwnerPresence>()
  const episodes = new Map<string, Episode>()
  return {
    current(now: number): OwnerPresence | undefined {
      for (const [id, p] of clients) if (now - p.lastSeenAt > PRESENCE_TTL_MS) clients.delete(id)
      return [...clients.values()].sort((a, b) => b.lastInteractionAt - a.lastInteractionAt || b.lastSeenAt - a.lastSeenAt)[0]
    },
    report(report: PresenceReport, rows: readonly WaitingSession[], now = Date.now()): { presence?: OwnerPresence; notices: WaitNotice[]; cleared: string[] } {
      const old = clients.get(report.client)
      if (report.visible && report.focused && report.session) {
        const row = rows.find(r => r.id === report.session || r.conversationId === report.session)
        if (row) clients.set(report.client, { client: report.client, session: row.id, lastSeenAt: now, lastInteractionAt: report.interacted ? now : old?.lastInteractionAt ?? now })
        else clients.delete(report.client)
      } else clients.delete(report.client)
      const presence = this.current(now)
      const notices: WaitNotice[] = [], cleared: string[] = []
      const waiting = new Set(rows.filter(r => r.waiting).map(r => r.id))
      for (const [id, e] of episodes) if (!waiting.has(id)) { cleared.push(`${id}:${e.since}`); episodes.delete(id) }
      for (const row of rows) {
        if (!row.waiting) continue
        const e = episodes.get(row.id) ?? { since: Math.min(now, row.since ?? now), announced: false, opened: false }
        episodes.set(row.id, e)
        const id = `${row.id}:${e.since}`
        if (presence?.session === row.id) e.opened = true
        // Every client must learn an acknowledgement, including one that was hidden at the time.
        if (e.opened) cleared.push(id)
        if (presence?.client === report.client && presence.session !== row.id && !e.opened && !e.announced && now - e.since >= WAIT_NOTICE_MS) {
          e.announced = true
          notices.push({ id, session: row.id, title: row.title })
        }
      }
      return { presence, notices, cleared }
    },
  }
}
export const ownerPresence = createOwnerPresence()
export function validPresenceReport(value: unknown): value is PresenceReport {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.client === 'string' && p.client.length > 0 && p.client.length <= 100
    && (p.session === null || (typeof p.session === 'string' && p.session.length <= 200))
    && typeof p.visible === 'boolean' && typeof p.focused === 'boolean' && typeof p.interacted === 'boolean'
}
