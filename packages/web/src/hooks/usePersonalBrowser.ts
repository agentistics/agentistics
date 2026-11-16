/**
 * usePersonalBrowser — is the person's own browser open, and the verbs to drive it (NAVEGADOR S10).
 * Liveness is read off `GET /api/browser/status` (the host's own snapshot, never guessed) while the panel
 * is open and the page visible; the picture itself comes from `useBrowserScreen('personal', …)`.
 */
import { useCallback, useEffect, useState } from 'react'
import { personalAct, personalBrowserOf, type PersonalAction, type PersonalOutcome, type PostFn } from '../lib/browserPersonal'

export const PERSONAL_STATUS_POLL_MS = 5_000

export function usePersonalBrowserLive(enabled: boolean, poll = PERSONAL_STATUS_POLL_MS): { live: boolean; refresh: () => void } {
  const [live, setLive] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (stop) return
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try {
          const r = await fetch('/api/browser/status')
          const body = r.ok ? await r.json().catch(() => null) : null
          if (!stop) setLive(personalBrowserOf(body) !== null)
        } catch { if (!stop) setLive(false) }
      }
      if (!stop) timer = setTimeout(() => void tick(), poll)
    }
    void tick()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [enabled, poll, nonce])
  const refresh = useCallback(() => setNonce(n => n + 1), [])
  return { live, refresh }
}

export function usePersonalActions(pt: boolean, post?: PostFn): { act: (a: PersonalAction, args?: Record<string, unknown>) => Promise<PersonalOutcome>; busy: boolean } {
  const [busy, setBusy] = useState(false)
  const act = useCallback(async (a: PersonalAction, args: Record<string, unknown> = {}) => {
    setBusy(true)
    try { return await personalAct(a, args, pt, post) } finally { setBusy(false) }
  }, [pt, post])
  return { act, busy }
}
