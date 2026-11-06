/** The small cross-component bridge used by session menus to ask NayDock to undock a session. */
export const NAY_UNDOCK_SESSION = 'agentistics:nay-undock-session'

/**
 * Ask NayDock to give `id` a detached window. Returns whether a dock took the request (it cancels the
 * event): none is listening on a phone, so the caller can fall back to what it did before.
 */
export function requestUndockSession(id: string): boolean {
  if (typeof window === 'undefined') return false
  return !window.dispatchEvent(new CustomEvent(NAY_UNDOCK_SESSION, { detail: { id }, cancelable: true }))
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
