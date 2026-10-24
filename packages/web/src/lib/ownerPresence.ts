import { initialLang } from './lang'
import { dismissNotification, pushLocalNotification, readNotifications } from './notifications'

let session: string | null = null
let stop: (() => void) | undefined
/** Reuses Nay's open-session signal; focus and visibility decide whether it is presence. */
export function reportOpenSession(id: string | null): void {
  session = id
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  window.dispatchEvent(new Event('agentistics:presence-session'))
  if (!stop) stop = startOwnerPresence()
}
export function presenceActive(visible: string, focused: boolean): boolean { return visible === 'visible' && focused }
export function startOwnerPresence(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const client = crypto.randomUUID()
  const shownQueue = new Set<string>()
  let interacted = true, pending = false, disposed = false, rerun = false
  const send = async () => {
    if (disposed) return
    if (pending) { rerun = true; return }
    pending = true
    const active = presenceActive(document.visibilityState, document.hasFocus())
    const interaction = interacted
    interacted = false
    const shown = [...shownQueue]
    try {
      const response = await fetch('/api/fleet/owner-presence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, session, visible: active, focused: active, interacted: interaction, lang: initialLang(localStorage, navigator.language), shown }), keepalive: true })
      if (!response.ok || disposed) return
      const result = await response.json() as { notices: { id: string; session: string; title: string }[]; cleared: string[] }
      for (const n of readNotifications()) if (n.code === 'owner.waiting' && result.cleared.includes(String(n.meta?.episode))) dismissNotification(n.id)
      if (!active || !presenceActive(document.visibilityState, document.hasFocus())) return
      for (const id of shown) shownQueue.delete(id)
      const have = new Set(readNotifications().filter(n => n.code === 'owner.waiting').map(n => String(n.meta?.episode)))
      for (const n of result.notices) {
        if (!have.has(n.id)) pushLocalNotification({ type: 'info', code: 'owner.waiting', meta: { label: n.title, sessionId: n.session, episode: n.id } })
        shownQueue.add(n.id) // acknowledged on the next heartbeat
      }
    } catch { interacted ||= interaction } finally { pending = false; if (rerun) { rerun = false; void send() } }
  }
  const interaction = () => { interacted = true }
  const refresh = () => { interacted = true; void send() }
  const activityEvents = ['pointerdown', 'keydown'] as const
  for (const event of activityEvents) window.addEventListener(event, interaction, { passive: true })
  for (const event of ['focus', 'blur', 'agentistics:presence-session']) window.addEventListener(event, refresh)
  document.addEventListener('visibilitychange', refresh)
  const timer = setInterval(() => { if (session && presenceActive(document.visibilityState, document.hasFocus())) void send() }, 15_000)
  void send()
  return () => {
    disposed = true; clearInterval(timer)
    for (const event of activityEvents) window.removeEventListener(event, interaction)
    for (const event of ['focus', 'blur', 'agentistics:presence-session']) window.removeEventListener(event, refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
}
