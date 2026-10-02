/**
 * UpdateFinale.tsx — the moment after: the new bundle has booted on the version the upgrade was
 * for, and says so.
 *
 * The same scene the loader drew (`UpdateStage`), at full charge: it is SUCKED into the logo, a
 * subtle burst follows (flash + sparks), then an orange ring and a green one leave the mark; the
 * header and the step text fade as the burst begins, and the result text comes in only after they
 * are gone — never on top of them (`finaleBeat`).
 *
 * THE LOGO IS NEVER REDRAWN (owner rule). It is the brand's own raster, and only SCALE, OPACITY and
 * GLOW change (`LogoPose`, `updateScene.ts`) — properties that cannot touch a stroke or a shape.
 *
 * Shown by `App.tsx` only when `consumeRestore` returned a snapshot for THIS tab on THIS version,
 * so a plain reload never replays it. It leaves by itself; a tap or Escape leaves sooner. Under
 * reduced motion there is no travel: one calm frame with the result text.
 */

import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@agentistics/core'
import { ut } from '../lib/updateI18n'
import { finaleBeat, REDUCED_FINALE_BEAT } from '../lib/updateAnim'
import { createScene } from '../lib/updateScene'
import { UPDATE_ANIMATION } from '../lib/upgradeSteps'
import { brandAsset } from '../lib/brand'
import { prefersReducedMotion } from '../lib/nayNotifyAnim'
import { INK_SOFT, StageText, TEXT_SHADOW, VersionTitle, canvasStyle, titleText, useStageRefs } from './UpdateStage'

export const FINALE_MS = 5600

export function UpdateFinale({ lang, version, from = '', onDone, isMobile = false }: { lang: Lang; version: string; from?: string; onDone: () => void; isMobile?: boolean }) {
  const [reduced] = useState(prefersReducedMotion)
  const [leaving, setLeaving] = useState(false)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const result = useRef<HTMLDivElement | null>(null)
  const refs = useStageRefs()

  useEffect(() => {
    const t1 = window.setTimeout(() => setLeaving(true), FINALE_MS - 450)
    const t2 = window.setTimeout(onDone, FINALE_MS)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone() }
    window.addEventListener('keydown', key)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); window.removeEventListener('keydown', key) }
  }, [onDone])

  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const logo = new Image()
    logo.src = brandAsset('/minimalistLogo.png')
    const scene = createScene(cv, UPDATE_ANIMATION, logo, reduced)
    scene.resize()
    // the hive keeps every line of the step text clear until the burst takes it away
    const ink = (root: HTMLElement | null): HTMLElement[] => (root ? Array.from(root.querySelectorAll<HTMLElement>('[data-ink]')) : [])
    scene.setInk([...ink(refs.hud.current), ...ink(refs.foot.current)])
    const onResize = () => { scene.resize(); draw(performance.now(), 16) }
    window.addEventListener('resize', onResize)
    const t0 = performance.now()
    let raf = 0, last = t0, gone = false, shown = false
    const draw = (now: number, dt: number) => {
      const t = (now - t0) / 1000
      scene.drawFinale({ t, now, dt })
      const beat = reduced ? REDUCED_FINALE_BEAT : finaleBeat(t)
      if (beat.chromeGone && !gone) { gone = true; if (refs.hud.current) refs.hud.current.style.opacity = '0'; if (refs.foot.current) refs.foot.current.style.opacity = '0' }
      // the result text waits for the step text to have left
      if (beat.textIn && !shown && result.current) { shown = true; result.current.style.opacity = '1' }
    }
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) { last = now; return }
      const dt = Math.min(64, now - last); last = now
      draw(now, dt)
    }
    if (reduced) { draw(t0, 16); logo.onload = () => draw(performance.now(), 16) } else raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); scene.dispose() }
  }, [reduced, refs])

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={titleText(lang, 'finale.updated', from, version)}
      data-testid="update-finale"
      data-animation={UPDATE_ANIMATION}
      onClick={onDone}
      style={{ position: 'fixed', inset: 0, zIndex: 10060, cursor: 'pointer', background: '#0a0a0f', color: 'rgba(255,255,255,.95)', opacity: leaving ? 0 : 1, transition: 'opacity 420ms ease' }}
    >
      <canvas ref={canvas} aria-hidden style={canvasStyle} />
      <StageText lang={lang} isMobile={isMobile} refs={refs} from={from} to={version} title="loader.title" allDone
        phrase={<span>{ut(lang, 'phrase.power.4')}…</span>} />
      <div ref={result} style={{
        position: 'fixed', left: 0, right: 0, top: 'calc(47% + 20vmin)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        textAlign: 'center', padding: '0 16px', opacity: 0, transition: 'opacity .6s ease', pointerEvents: 'none',
        textShadow: TEXT_SHADOW,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase', color: '#10b981' }}>{ut(lang, 'finale.ok')}</span>
        <b style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.01em' }}><VersionTitle lang={lang} k="finale.updated" from={from} to={version} /></b>
        <small style={{ fontSize: 13, color: INK_SOFT }}>{ut(lang, 'finale.sub')}</small>
      </div>
    </div>
  )
}
