/**
 * BrowserDrawer — the person's browser on a phone (NAVEGADOR S10, spec §3.3): the same `BrowserPanel`, on the
 * whole screen with no radius, opened by the globe+search button in the session header or the "Navegador"
 * entry of the `MobileAreaBar` sheet. There is no right rail on a phone. Mounted once at the app root; it
 * draws nothing while closed (so no browser stream is open) and `Esc` / the panel's own close leave it.
 */
import { BrowserPanel } from './BrowserPanel'
import { useIsMobile } from '../../hooks/useIsMobile'
import { setBrowserDrawerOpen, useBrowserDrawerOpen } from '../../lib/browserDrawer'
import { useEscapeOwner } from '../../lib/overlayStack'

export function BrowserDrawer({ lang }: { lang: 'pt' | 'en' }) {
  const mobile = useIsMobile()
  const open = useBrowserDrawerOpen() && mobile
  useEscapeOwner(open, () => setBrowserDrawerOpen(false))
  if (!open) return null
  return (
    <div data-browser-drawer role="dialog" aria-modal="true" aria-label={lang === 'pt' ? 'Navegador' : 'Browser'} style={{
      position: 'fixed', inset: 0, zIndex: 660, display: 'flex', flexDirection: 'column', background: 'var(--bg-card)',
      paddingTop: 'var(--safe-top, 0px)', paddingBottom: 'var(--safe-bottom, 0px)', boxSizing: 'border-box',
    }}>
      <BrowserPanel lang={lang} onClose={() => setBrowserDrawerOpen(false)} onOpenVault={() => { setBrowserDrawerOpen(false); window.history.pushState({}, '', '/vault'); window.dispatchEvent(new PopStateEvent('popstate')) }} />
    </div>
  )
}
