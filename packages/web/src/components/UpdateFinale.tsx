/**
 * UpdateFinale.tsx — the moment after: the new bundle has booted on the version the upgrade was
 * for, and says so.
 *
 * THE LOGO IS NEVER REDRAWN (owner rule). It is the brand's own raster (`brandAsset`), and the only
 * things animated are SCALE, OPACITY, COLOUR (a brightness/saturation filter) and GLOW (a
 * drop-shadow) — properties that cannot touch a stroke or a shape. `updateSurfaces.test.ts` holds
 * the keyframes to that list.
 *
 * Shown by `App.tsx` only when `consumeRestore` returned a snapshot for THIS tab on THIS version,
 * so a plain reload never replays it. It leaves by itself; a tap or Escape leaves sooner.
 */

import { useEffect, useState } from 'react'
import type { Lang } from '@agentistics/core'
import { brandAsset } from '../lib/brand'
import { ut } from '../lib/updateI18n'
import { prefersReducedMotion } from '../lib/nayNotifyAnim'

export const FINALE_MS = 3200

export function UpdateFinale({ lang, version, onDone }: { lang: Lang; version: string; onDone: () => void }) {
  const [reduced] = useState(prefersReducedMotion)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const t1 = window.setTimeout(() => setLeaving(true), FINALE_MS - 450)
    const t2 = window.setTimeout(onDone, FINALE_MS)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone() }
    window.addEventListener('keydown', key)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); window.removeEventListener('keydown', key) }
  }, [onDone])

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-finale"
      onClick={onDone}
      className={reduced ? 'ag-upd-finale-calm' : 'ag-upd-finale'}
      style={{
        position: 'fixed', inset: 0, zIndex: 10060, cursor: 'pointer',
        background: 'radial-gradient(ellipse at 50% 42%, rgba(20,27,43,0.96) 0%, rgba(5,7,11,0.97) 70%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18,
        padding: 16, opacity: leaving ? 0 : 1, transition: 'opacity 420ms ease',
      }}
    >
      <div style={{ position: 'relative', width: 132, height: 132, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* A halo BEHIND the logo — its own element, so the glow never sits on the mark itself. */}
        <div aria-hidden className="ag-upd-halo" style={{
          position: 'absolute', inset: -28, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(249,115,22,0.42) 0%, rgba(249,115,22,0.12) 45%, rgba(249,115,22,0) 70%)',
        }} />
        <img src={brandAsset('/minimalistLogo.png')} alt="Agentistics" className="ag-upd-logo" style={{ width: 112, height: 112, borderRadius: 26, position: 'relative' }} />
      </div>
      <div className="ag-upd-finale-text" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.01em' }}>
          {ut(lang, 'finale.updated_to', { version })}
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 6 }}>{ut(lang, 'finale.sub')}</div>
      </div>
    </div>
  )
}
