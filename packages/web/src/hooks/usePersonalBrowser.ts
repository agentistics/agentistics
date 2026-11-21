/**
 * usePersonalBrowser — is the person's own browser open, which tabs it has, and the verbs to drive it
 * (NAVEGADOR S10). Liveness is read off `GET /api/browser/status` (the host's own snapshot, never guessed)
 * while the panel is open and the page visible, with the owner's grant in a header — without it the server
 * leaves the personal part out, and says so (`personalAccess: false`), which also tells the page that a grant
 * it still holds is no good any more (the server restarted). The picture itself comes from the stream.
 *
 * The poll is also how the panel learns that a tab it is pinned to was closed from somewhere else: the
 * stream of a dead target never says anything again, so the status is the only voice left.
 */
import { useCallback, useEffect, useState } from 'react'
import { personalAct, personalBrowserOf, type PersonalAction, type PersonalOutcome, type PostFn } from '../lib/browserPersonal'
import { clearPersonalGrant, personalGrantHeaders } from '../lib/personalGrant'

export const PERSONAL_STATUS_POLL_MS = 2_000

export interface PersonalTabFact { id: string; active: boolean }
/** `asOf`: when the poll that produced `tabs` STARTED — a pin made after it is newer than it, and must not be undone by it. */
export interface PersonalLive { live: boolean; tabs: PersonalTabFact[]; asOf: number; refresh: () => void }

export function usePersonalBrowserLive(enabled: boolean, poll = PERSONAL_STATUS_POLL_MS): PersonalLive {
  const [state, setState] = useState<{ live: boolean; tabs: PersonalTabFact[]; asOf: number }>({ live: false, tabs: [], asOf: 0 })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!enabled) { setState(s => (s.live || s.tabs.length ? { live: false, tabs: [], asOf: 0 } : s)); return }
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (stop) return
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        const startedAt = Date.now()
        try {
          const r = await fetch('/api/browser/status', { headers: personalGrantHeaders() })
          const body = r.ok ? await r.json().catch(() => null) : null
          if (!stop) {
            if (body && typeof body === 'object' && (body as { personalAccess?: unknown }).personalAccess === false) clearPersonalGrant()
            const row = personalBrowserOf(body)
            setState({ live: row !== null, tabs: (row?.tabs ?? []).map(t => ({ id: String((t as { targetId?: unknown }).targetId ?? ''), active: (t as { active?: unknown }).active === true })).filter(t => t.id !== ''), asOf: startedAt })
          }
        } catch { if (!stop) setState({ live: false, tabs: [], asOf: startedAt }) }
      }
      if (!stop) timer = setTimeout(() => void tick(), poll)
    }
    void tick()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [enabled, poll, nonce])
  const refresh = useCallback(() => setNonce(n => n + 1), [])
  return { live: state.live, tabs: state.tabs, asOf: state.asOf, refresh }
}

export function usePersonalActions(pt: boolean, post?: PostFn): { act: (a: PersonalAction, args?: Record<string, unknown>) => Promise<PersonalOutcome>; busy: boolean } {
  const [busy, setBusy] = useState(false)
  const act = useCallback(async (a: PersonalAction, args: Record<string, unknown> = {}) => {
    setBusy(true)
    try { return await personalAct(a, args, pt, post) } finally { setBusy(false) }
  }, [pt, post])
  return { act, busy }
}
