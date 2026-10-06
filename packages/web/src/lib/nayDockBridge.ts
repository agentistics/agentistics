/** The small cross-component bridge used by session menus to ask NayDock to undock a session. */
export const NAY_UNDOCK_SESSION = 'agentistics:nay-undock-session'

export function requestUndockSession(id: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(NAY_UNDOCK_SESSION, { detail: { id } }))
}

export function undockMenuEntry(pt: boolean) {
  return { action: NAY_UNDOCK_SESSION, label: pt ? 'Abrir desacoplada' : 'Open undocked', enabled: true }
}

export function withUndockEntry(entries: readonly { action: string; label: string; enabled: boolean; reason?: string }[], pt: boolean, include = true) {
  if (!include) return [...entries]
  const out = [...entries]
  const rename = out.findIndex(entry => entry.action === 'rename')
  if (rename >= 0) out.splice(rename + 1, 0, undockMenuEntry(pt))
  return out
}
