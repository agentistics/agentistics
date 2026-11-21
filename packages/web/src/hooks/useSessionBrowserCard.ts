/**
 * useSessionBrowserCard — everything a session's browser shows, whichever frame draws it (NAVEGADOR S11).
 *
 * The card in the conversation (`BrowserSessionCard`, A1) and the floating window (`BrowserWindows`,
 * `a1-floating`) are the same browser in two frames: the same stream, the same padlock (the person's VAULT
 * grant, `setBrowserLock`, never a second proof path), the same tab the person watches, the same caption.
 * Only one of them is ever mounted for a session (`browserWindows.placeOf`), so this runs once per browser
 * and there is one screencast per owner/tab.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBrowserInput, useBrowserScreen, type BrowserInput, type OpenStream, type ViewerSize } from './useBrowserScreen'
import type { BrowserScreenState as ScreenModel } from '../lib/browserStream'
import { browserWatching } from '../lib/browserStream'
import { browserCaption, setBrowserLock, type BrowserCaption, type LockOutcome } from '../lib/browserCard'

export type SetLock = (managedId: string, lock: 'locked' | 'unlocked', pt: boolean) => Promise<LockOutcome>

export interface SessionBrowserCardModel {
  screen: ScreenModel
  lock: 'locked' | 'unlocked'
  unlocked: boolean
  busy: boolean
  refusal: { sentence: string; openVault: boolean } | null
  toggleLock: () => Promise<void>
  input: BrowserInput
  /** The tab this frame watches (null = follow the model's tab). */
  tab: string | null
  setTab: (tab: string | null) => void
  setSize: (size: ViewerSize | undefined) => void
  url: string
  caption: BrowserCaption
  /** Attach to the frame's root: watching = on screen and the page visible (spec §1.5). */
  watchRef: (el: HTMLDivElement | null) => void
}

/** Is this element on screen while the page is visible? (the frame's "watching" — spec §1.5). */
export function useWatching(): [(el: HTMLDivElement | null) => void, boolean] {
  const [inView, setInView] = useState(true)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const obs = useRef<IntersectionObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect()
    obs.current = null
    if (!el || typeof IntersectionObserver === 'undefined') return
    const o = new IntersectionObserver(entries => { for (const e of entries) setInView(e.isIntersecting) })
    o.observe(el)
    obs.current = o
  }, [])
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => { document.removeEventListener('visibilitychange', on); obs.current?.disconnect() }
  }, [])
  return [ref, browserWatching({ inViewport: inView, documentVisible: visible, panelOpen: true })]
}

export function useSessionBrowserCard(managedId: string, lang: 'pt' | 'en', setLock: SetLock = setBrowserLock, openStream?: OpenStream): SessionBrowserCardModel {
  const pt = lang === 'pt'
  const [watchRef, watching] = useWatching()
  const [tab, setTab] = useState<string | null>(null)
  const [size, setSize] = useState<ViewerSize>()
  const screen = useBrowserScreen(managedId, tab, watching && (size !== undefined || typeof ResizeObserver === 'undefined'), openStream, size)
  const serverLock = screen.state?.lock === 'unlocked' ? 'unlocked' : 'locked'
  const [mine, setMine] = useState<'locked' | 'unlocked' | null>(null)
  useEffect(() => { if (mine !== null && serverLock === mine) setMine(null) }, [serverLock, mine])
  const lock = mine ?? serverLock
  const unlocked = lock === 'unlocked'
  const input = useBrowserInput(managedId, tab, unlocked)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ sentence: string; openVault: boolean } | null>(null)

  const toggleLock = async () => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const want = unlocked ? 'locked' : 'unlocked'
    try {
      const r = await setLock(managedId, want, pt)
      if (r.ok) setMine(r.lock)
      else setRefusal({ sentence: r.sentence, openVault: r.openVault })
    } catch {
      setRefusal({ sentence: pt ? 'Não foi possível mudar o cadeado.' : 'Could not change the padlock.', openVault: false })
    } finally {
      setBusy(false)
    }
  }

  const url = screen.state?.url || screen.frame?.url || ''
  const caption = browserCaption(screen.state ? lock : null, screen.state?.lastAction ?? null, lang)
  return { screen, lock, unlocked, busy, refusal, toggleLock, input, tab, setTab, setSize, url, caption, watchRef }
}
