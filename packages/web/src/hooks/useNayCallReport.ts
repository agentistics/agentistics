/**
 * useNayCallReport — tells the server the state of the "call Nay" button (the mounted voice-call surface,
 * the same fact the top-bar pill reads) so agents can read it over MCP (`agentistics_nay_call`), and
 * collects an agent's start request from the reply, pressing the same button the person would.
 *
 * It reports on every change and as a heartbeat while the tab is visible; the server forgets a report
 * after 20 s, so a closed or hidden tab reads as "unknown", never as "no call". Nothing is reported on a
 * build with no voice surface.
 */
import { useEffect, useRef } from 'react'
import type { NayCallState } from '../lib/nayCall'

export const NAY_CALL_HEARTBEAT_MS = 8000

export function useNayCallReport(available: boolean, state: NayCallState, onStartRequested: () => void): void {
  const press = useRef(onStartRequested)
  press.current = onStartRequested
  const latest = useRef(state)
  latest.current = state
  const send = useRef<() => void>(() => {})
  const sentKey = useRef('')
  const keyOf = (s: NayCallState) => `${s.active}|${s.parked}|${s.sessionId}|${s.since}`

  useEffect(() => {
    if (!available || typeof fetch !== 'function') return
    let live = true
    send.current = () => {
      if (!live || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
      const s = latest.current
      sentKey.current = keyOf(s)
      void fetch('/api/nay-call/state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: s.active, parked: s.parked, sessionId: s.sessionId, since: s.since }),
      }).then(r => (r.ok ? r.json() : null)).then((out: { ok?: boolean; start?: boolean } | null) => {
        if (live && out?.ok && out.start) press.current()
      }).catch(() => { /* the next beat retries */ })
    }
    send.current()
    const timer = window.setInterval(() => send.current(), NAY_CALL_HEARTBEAT_MS)
    const onVisible = () => send.current()
    document.addEventListener('visibilitychange', onVisible)
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [available])

  // A change is reported at once, not at the next beat.
  useEffect(() => { if (available && keyOf(latest.current) !== sentKey.current) send.current() }, [available, state.active, state.parked, state.sessionId, state.since])
}
