/** The small cross-component bridge used by session menus to ask NayDock to undock a session. */
export const NAY_UNDOCK_SESSION = 'agentistics:nay-undock-session'

/**
 * Ask NayDock to give `id` a detached window. Returns whether a dock took the request (it cancels the
 * event): none is listening on a phone, so the caller can fall back to what it did before.
 *
 * `manual` says a person asked (the session menu's "Open undocked"): a minimized window then comes
 * back up. An automatic request (a call whose session view went away) leaves a minimized window
 * minimized — it already holds the session and must not pop open by itself.
 */
export function requestUndockSession(id: string, opts: { manual?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return false
  return !window.dispatchEvent(new CustomEvent(NAY_UNDOCK_SESSION, { detail: { id, manual: opts.manual === true }, cancelable: true }))
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
