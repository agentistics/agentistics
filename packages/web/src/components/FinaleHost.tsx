/**
 * FinaleHost.tsx — owns the update finale from the FIRST render of the bundle that arrived.
 *
 * The finale used to live inside `App`, which returns `LoadingScreen` until /api/data has been
 * fetched and derived. After the reload that ends an upgrade the person therefore saw the default
 * boot loader for the whole data load (tens of seconds on a big history) and only then the finale —
 * and by then the main thread had been busy, so its wall-clock timeline had already run past the
 * suction. Mounted next to the router instead, it paints on the first frame, releases the boot
 * splash straight into it (dark to dark: `boot/preboot.ts` hides the logo while an upgrade restore
 * is pending), and survives `App`'s boot states because it is not part of them.
 *
 * `App` still consumes the snapshot later, to put the route and the scroll back.
 *
 * While it is up the app beneath it holds its heavy first work (`finaleGate.ts`); leaving ENDS that
 * hold, and so does a wall-clock ceiling — a finale that never got its frames (a canvas that failed,
 * a tab hidden through it) must not keep the app waiting behind it.
 */
import { useEffect, useState } from 'react'
import type { Lang } from '@agentistics/core'
import { BUNDLE_VERSION } from '../lib/bundleVersion'
import { releaseBoot } from '../lib/bootSplash'
import { peekRestore } from '../lib/upgradeFlow'
import { endFinale } from '../lib/finaleGate'
import { useIsMobile } from '../hooks/useIsMobile'
import { FINALE_MS, UpdateFinale } from './UpdateFinale'

/** The latest the app beneath is held, whatever happened to the finale's own clock. */
export const FINALE_CEILING_MS = FINALE_MS + 6000

function storedLang(): Lang {
  let stored: string | null = null
  try { stored = localStorage.getItem('agentistics-lang') } catch { /* private mode */ }
  if (stored === 'pt' || stored === 'en') return stored
  return (navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

export function FinaleHost() {
  const [pending, setPending] = useState(() => {
    const back = BUNDLE_VERSION ? peekRestore(BUNDLE_VERSION) : null
    return back ? { from: back.from ?? '' } : null
  })
  const isMobile = useIsMobile()
  useEffect(() => { if (pending) releaseBoot() }, [pending])
  useEffect(() => {
    if (!pending || !BUNDLE_VERSION) { endFinale(); return }
    const ceiling = window.setTimeout(endFinale, FINALE_CEILING_MS)
    return () => window.clearTimeout(ceiling)
  }, [pending])
  if (!pending || !BUNDLE_VERSION) return null
  return <UpdateFinale lang={storedLang()} isMobile={isMobile} version={BUNDLE_VERSION} from={pending.from} onDone={() => { endFinale(); setPending(null) }} />
}
