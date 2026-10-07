/**
 * preboot.ts — starts D1 in the HTML boot splash before the app bundle has even been fetched.
 *
 * NOT part of the app bundle. `vite.config.ts` (`prebootScriptPlugin`) strips the types off
 * `lib/d1Loader.ts` + this file, drops the one import below, and serves the pair as ONE classic
 * script (`/ag-boot.js` in dev, `assets/ag-boot-<hash>.js` in a build) — external because the CSP is
 * `script-src 'self'`, classic because a module script would wait in line behind the app bundle.
 * This file may therefore import nothing but `d1Loader`, and that only as the single line the
 * plugin removes (`prebootScript.test.ts` pins it).
 *
 * The splash is THE boot screen: the app never draws a second one. React keeps it up while anything
 * is still loading (`lib/bootSplash.ts`) and fades it out once the app is usable, so the loop on
 * screen is never restarted or moved from the first frame to the last.
 */
import { animateD1, breatheD1, d1Markup, D1_DURATION } from '../lib/d1Loader'

/** sessionStorage: when the current boot's loop began (epoch ms). Cleared once the app is usable. */
const BOOT_ANCHOR_KEY = 'ag-boot-anchor'
/** A reload this soon after the previous boot began continues that loop instead of restarting it
 *  (the stale-bundle heal and the dev worker eviction both reload mid-boot). */
const ANCHOR_REUSE_MS = 60_000
/** The status line appears only when the boot takes longer than this. */
const STATUS_AFTER_MS = 4_000
const CENTRAL_ACCENT = '#06B6D4'

function bootAnchor(now: number): number {
  try {
    const prev = Number(sessionStorage.getItem(BOOT_ANCHOR_KEY))
    if (prev > 0 && now - prev >= 0 && now - prev < ANCHOR_REUSE_MS) return prev
    sessionStorage.setItem(BOOT_ANCHOR_KEY, String(now))
  } catch { /* private mode: every boot starts at frame 0 */ }
  return now
}

/** The first paint follows the theme the person chose (the same local copy App.tsx reads first),
 *  so a light-theme user never sees a dark splash flash to light. */
function stampTheme(): void {
  try {
    if (localStorage.getItem('agentistics-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light')
  } catch { /* private mode: dark, the default */ }
}

/** The app's language as last chosen here (App.tsx mirrors it), else the browser's. */
function bootLang(): 'pt' | 'en' {
  let stored: string | null = null
  try { stored = localStorage.getItem('agentistics-lang') } catch { /* private mode */ }
  if (stored === 'pt' || stored === 'en') return stored
  return (navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

function startPreboot(): void {
  stampTheme()
  const root = document.getElementById('ag-preboot')
  const svg = root?.querySelector<SVGSVGElement>('svg.ag-preboot-mark')
  if (!root || !svg || typeof svg.animate !== 'function') return
  root.setAttribute('aria-label', bootLang() === 'pt' ? 'Carregando o Agentistics' : 'Loading Agentistics')
  const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const accent = document.documentElement.hasAttribute('data-central') ? CENTRAL_ACCENT : undefined
  svg.innerHTML = d1Markup(56, 'ag-d1-boot', reduced, accent)
  if (reduced) breatheD1(svg)
  else {
    const now = Date.now()
    const anchor = bootAnchor(now)
    // Document-timeline ms of the anchor: `now` maps to `performance.now()`, so an anchor from an
    // earlier page lands in the past and the loop resumes at its phase (mod one loop).
    const back = (now - anchor) % D1_DURATION
    animateD1(svg, performance.now() - back)
  }

  window.setTimeout(() => {
    const status = root.querySelector<HTMLElement>('.ag-boot-status')
    if (!status || !root.isConnected || root.classList.contains('ag-boot-out') || status.textContent) return
    status.textContent = bootLang() === 'pt' ? 'Ainda carregando…' : 'Still loading…'
  }, STATUS_AFTER_MS)
}

startPreboot()
