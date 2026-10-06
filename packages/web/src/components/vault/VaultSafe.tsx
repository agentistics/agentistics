import { useEffect, useRef, useState } from 'react'

/**
 * The big safe on the vault page, in the app's ORANGE (`--anthropic-orange`: outline, dial, bolts, a soft
 * orange-tinted fill — owner, 2026-10-05) — the same token as the accent and the logo, so dark and light
 * themes both keep it readable.
 *
 * The big safe on the vault page (owner-approved prototype `cofre-proto.html`, 2026-10-05).
 *
 * `phase` says what it is doing:
 *  - `locked`     closed, still.
 *  - `unlocking`  Hello / the code is in progress: ONLY the dial moves, like a combination lock — a little
 *                 left, a little right, alternating, looping until the phase changes. Bolts and door stay
 *                 shut. If the unlock fails (back to `locked`) the dial eases back to rest from wherever it
 *                 was, instead of snapping.
 *  - `opening`    the unlock worked: the dial turns further to one side, the side bolts retract and the
 *                 door swings open (~2.2 s, `SAFE_OPEN_MS`) — the page shows its content AFTER this.
 *  - `open`       open, still (what the page shows once it has content, if the safe is drawn at all).
 * `from="open"` mounts open and closes at once — the short reverse for a vault that just locked.
 *
 * Motion is CSS (transform only, so nothing reflows) and `prefers-reduced-motion` turns all of it off:
 * the safe then simply changes state. The door's 3D swing uses `perspective()` on the element rather
 * than on a parent, so it never creates a stacking context the page would have to know about.
 */
export type SafePhase = 'locked' | 'unlocking' | 'opening' | 'open'

/** How long the opening takes — the page waits this long before it shows the vault's content. */
export const SAFE_OPEN_MS = 2300

/** Widths that give the 140:150 drawing a height of ~140 px on a desktop and ~100 px on a phone. */
export const SAFE_WIDTH_DESKTOP = 130
export const SAFE_WIDTH_MOBILE = 94

const CSS = `
.vs .vs-dial{transform-box:fill-box;transform-origin:center;transition:transform .45s ease}
.vs .vs-door{transform-box:fill-box;transform-origin:left center;transition:transform .35s ease}
.vs .vs-bolt{transition:transform .3s ease}
.vs.vs-unlocking .vs-dial{animation:vs-comb 2.6s ease-in-out infinite}
.vs.vs-opening .vs-dial,.vs.vs-open .vs-dial{transform:rotate(-630deg)}
.vs.vs-opening .vs-dial{transition:transform 1.6s cubic-bezier(.3,.1,.2,1)}
.vs.vs-opening .vs-bolt,.vs.vs-open .vs-bolt{transform:translateX(-7px)}
.vs.vs-opening .vs-bolt{transition:transform .5s ease .9s}
.vs.vs-opening .vs-door,.vs.vs-open .vs-door{transform:perspective(700px) rotateY(-38deg)}
.vs.vs-opening .vs-door{transition:transform .8s ease 1.1s}
@keyframes vs-comb{0%{transform:rotate(0)}10%{transform:rotate(-55deg)}22%{transform:rotate(40deg)}34%{transform:rotate(-80deg)}46%{transform:rotate(65deg)}58%{transform:rotate(-45deg)}70%{transform:rotate(30deg)}82%{transform:rotate(-20deg)}100%{transform:rotate(0)}}
@media (prefers-reduced-motion:reduce){.vs .vs-dial,.vs .vs-door,.vs .vs-bolt{transition:none!important;animation:none!important}}
`

const lastDialDeg = new WeakMap<Element, number>()
/** The rotation (degrees) of a computed `matrix(a, b, …)` transform; 0 for `none` or anything unreadable. */
export function angleOf(transform: string): number {
  const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(transform)
  if (!m) return 0
  const a = Number(m[1]), b = Number(m[2])
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round(Math.atan2(b, a) * 180 / Math.PI) : 0
}

export function VaultSafe({ phase, from, width = 240, label }: { phase: SafePhase; from?: 'open'; width?: number; label?: string }) {
  // Mount open, close on the next frame: the CSS transition then plays the short reverse.
  const [closing, setClosing] = useState(from === 'open')
  useEffect(() => {
    if (from !== 'open') return
    const t = setTimeout(() => setClosing(false), 40)
    return () => clearTimeout(t)
  }, [from])
  const shown: SafePhase = closing ? 'open' : phase
  // unlocking → locked (a cancelled Hello, a wrong code): ease the dial back from the angle the
  // combination animation left it at — removing the animation alone would snap it to zero.
  const dial = useRef<SVGGElement | null>(null)
  const prev = useRef<SafePhase>(shown)
  useEffect(() => {
    const was = prev.current
    prev.current = shown
    const el = dial.current
    if (was !== 'unlocking' || shown !== 'locked' || !el || typeof el.animate !== 'function') return
    try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return } catch { /* no matchMedia: animate */ }
    const deg = lastDialDeg.get(el) ?? 0
    if (Math.abs(deg) < 1) return
    el.animate([{ transform: `rotate(${deg}deg)` }, { transform: 'rotate(0deg)' }], { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)' })
  }, [shown])
  // While it turns, remember its angle every frame (read off the computed matrix), for the ease-back above.
  useEffect(() => {
    if (shown !== 'unlocking') return
    let raf = 0
    const tick = () => {
      const el = dial.current
      if (el) lastDialDeg.set(el, angleOf(getComputedStyle(el).transform))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [shown])
  return (
    <>
      <style>{CSS}</style>
      <svg className={`vs vs-${shown}`} data-safe-phase={shown} viewBox="0 0 140 150" role="img" aria-label={label ?? 'Safe'}
        style={{ width, maxWidth: '72vw', height: 'auto', color: 'var(--anthropic-orange)', overflow: 'visible' }}>
        <rect x="6" y="6" width="128" height="122" rx="12" fill="currentColor" opacity=".2" />
        <rect x="6" y="6" width="128" height="122" rx="12" fill="none" stroke="currentColor" strokeWidth="4" />
        <g className="vs-door">
          <rect x="18" y="18" width="104" height="98" rx="6" fill="var(--bg-surface, var(--bg-elevated))" /><rect x="18" y="18" width="104" height="98" rx="6" fill="currentColor" fillOpacity=".1" stroke="currentColor" strokeWidth="3.5" />
          <rect x="14" y="34" width="8" height="16" rx="2" fill="currentColor" />
          <rect x="14" y="84" width="8" height="16" rx="2" fill="currentColor" />
          <g className="vs-bolt"><rect x="112" y="40" width="14" height="6" rx="2" fill="currentColor" /><rect x="112" y="88" width="14" height="6" rx="2" fill="currentColor" /></g>
          <g className="vs-dial" ref={dial}>
            <circle cx="66" cy="67" r="30" fill="none" stroke="currentColor" strokeWidth="3.5" />
            <circle cx="66" cy="67" r="21" fill="currentColor" opacity=".22" />
            <circle cx="66" cy="67" r="21" fill="none" stroke="currentColor" strokeWidth="3" />
            <g stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><path d="M66 46v-8M66 88v8M45 67h-8M87 67h8M51.2 52.2l-5.6-5.6M80.8 81.8l5.6 5.6M51.2 81.8l-5.6 5.6M80.8 52.2l5.6-5.6" /></g>
            <circle cx="66" cy="67" r="6" fill="currentColor" />
            <circle cx="66" cy="49" r="2.4" fill="var(--bg-surface, var(--bg-elevated))" />
          </g>
          <rect x="102" y="58" width="7" height="20" rx="3" fill="currentColor" />
        </g>
        <g fill="currentColor"><path d="M22 128h20l-3 14H25z" /><path d="M98 128h20l-3 14h-14z" /></g>
      </svg>
    </>
  )
}
