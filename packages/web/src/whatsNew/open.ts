/** The hand-off from a notification (toast or bell row) to the modal App.tsx mounts. */
export const OPEN_WHATS_NEW_EVENT = 'agentistics:open-whats-new'

export interface WhatsNewRequest { version: string; from: string; /** Opened by itself after an update (shows "Don't show again"). */ auto?: boolean }

export function openWhatsNew(meta: Record<string, unknown> | undefined, auto = false): void {
  const version = String(meta?.version ?? '').trim()
  if (!version) return
  window.dispatchEvent(new CustomEvent<WhatsNewRequest>(OPEN_WHATS_NEW_EVENT, { detail: { version, from: String(meta?.from ?? ''), ...(auto ? { auto: true } : {}) } }))
}
