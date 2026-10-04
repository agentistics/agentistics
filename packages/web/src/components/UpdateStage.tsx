/**
 * UpdateStage.tsx — the shared stage of the update experience: a full-screen canvas scene
 * (`lib/updateScene.ts`) with the header and the step text laid over it. The loader
 * (`UpgradeOverlay`) and the finale (`UpdateFinale`) both draw through it, so the two read as one
 * continuous piece even though a reload sits between them.
 *
 * The per-frame work is IMPERATIVE on purpose: the displayed progress eases every frame, and routing
 * that through React state would re-render the tree sixty times a second. React renders the
 * structure once; the loop writes widths and text into the refs it was handed.
 */

import { useEffect, useMemo, useRef, type CSSProperties, type MutableRefObject, type ReactNode } from 'react'
import type { Lang } from '@agentistics/core'
import { brandAsset } from '../lib/brand'
import { UPGRADE_POLL_MS } from '../lib/appReload'
import { UPDATE_STEPS, ut, splitPair, versionPair, type UpdateKey } from '../lib/updateI18n'
import { easeToward, estimateDownload, sceneTarget, EASE_TAU_MS } from '../lib/updateAnim'
import { createScene, type Scene } from '../lib/updateScene'
import { stepIndex } from '../lib/upgradeSteps'
import { UPDATE_ANIMATION } from '../lib/upgradeSteps'
import type { FlowState } from '../lib/upgradeFlow'

export const FROM_COLOR = '#F59E0B'
export const TO_COLOR = '#10b981'

const STEP_LABEL: Record<(typeof UPDATE_STEPS)[number], UpdateKey> = {
  data: 'loader.step.data', brain: 'loader.step.brain', wiring: 'loader.step.wiring', power: 'loader.step.power',
}

/** `Atualizando v<from> → v<to>` with the origin orange and the target green. */
export function VersionTitle({ lang, k, from, to }: { lang: Lang; k: 'loader.title' | 'finale.updated'; from: string; to: string }) {
  const [a, b] = splitPair(lang, k)
  return (
    <>
      {a}
      {from && <><span style={{ color: FROM_COLOR }}>v{from}</span><span style={{ color: 'rgba(255,255,255,.42)', margin: '0 .35em' }}>→</span></>}
      <span style={{ color: TO_COLOR }}>v{to}</span>
      {b}
    </>
  )
}

export const titleText = (lang: Lang, k: 'loader.title' | 'finale.updated', from: string, to: string) =>
  ut(lang, k, { pair: versionPair(from, to) })

/**
 * The text's own crispness. The hive makes room around the text (no scrim, no overlay), so all it
 * needs is a hair of shadow — the prototype's 1 px. The core keeps its heavier halo: its streams
 * run straight through the type.
 */
export const TEXT_SHADOW = UPDATE_ANIMATION === 'hive' ? '0 1px 1px rgba(0,0,0,.55)' : '0 1px 2px rgba(0,0,0,.9), 0 0 18px rgba(10,10,15,.95)'
const SHADOW = TEXT_SHADOW

/** AA contrast on the stage background: step labels not yet reached, the second line of figures, the note. */
export const INK_DIM = 'rgba(255,255,255,.62)'
export const INK_SOFT = 'rgba(255,255,255,.76)'

const hudStyle: CSSProperties = {
  position: 'fixed', left: 0, right: 0, top: 'calc(env(safe-area-inset-top, 0px) + 8vh)', display: 'flex', flexDirection: 'column',
  alignItems: 'center', gap: 6, pointerEvents: 'none', paddingInline: 16, textAlign: 'center', transition: 'opacity .5s ease', textShadow: SHADOW,
}
const footStyle: CSSProperties = {
  position: 'fixed', left: 0, right: 0, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 8vh)', display: 'flex', flexDirection: 'column',
  alignItems: 'center', gap: 12, pointerEvents: 'none', paddingInline: 16, textAlign: 'center', transition: 'opacity .5s ease', textShadow: SHADOW,
}

/** The step bars. Each bar is `[track, fill]`; the loop writes the fill's width and colour. */
export interface StageRefs {
  hud: MutableRefObject<HTMLDivElement | null>
  foot: MutableRefObject<HTMLDivElement | null>
  sub: MutableRefObject<HTMLDivElement | null>
  fills: MutableRefObject<(HTMLDivElement | null)[]>
  labels: MutableRefObject<(HTMLSpanElement | null)[]>
}

export function useStageRefs(): StageRefs {
  // ONE object for the life of the component. It used to be rebuilt every render, and it is a dependency of the
  // scene effects: every poll's re-render disposed and recreated the canvas scene, so the animation restarted
  // endlessly (UPD.ANIM).
  const hud = useRef<HTMLDivElement | null>(null), foot = useRef<HTMLDivElement | null>(null), sub = useRef<HTMLDivElement | null>(null)
  const fills = useRef<(HTMLDivElement | null)[]>([]), labels = useRef<(HTMLSpanElement | null)[]>([])
  return useMemo(() => ({ hud, foot, sub, fills, labels }), [hud, foot, sub, fills, labels])
}

export function StageText({ lang, isMobile, refs, from, to, phrase, title, note, allDone }: {
  lang: Lang; isMobile: boolean; refs: StageRefs; from: string; to: string
  phrase: ReactNode; title: 'loader.title'; note?: boolean; allDone?: boolean
}) {
  return (
    <>
      <div ref={refs.hud} style={hudStyle} data-testid="update-hud">
        <div data-ink style={{ font: '600 11px/1 inherit', fontSize: 11, fontWeight: 600, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#94a3b8' }}>Agentistics</div>
        <h2 data-ink style={{ margin: 0, fontSize: isMobile ? 18 : 22, fontWeight: 600, lineHeight: 1.2, color: 'rgba(255,255,255,.95)' }}>
          <VersionTitle lang={lang} k={title} from={from} to={to} />
        </h2>
      </div>
      <div ref={refs.foot} style={footStyle} data-testid="update-foot">
        <div aria-live="polite" data-ink style={{ minHeight: '1.3em', fontSize: isMobile ? 15 : 17, fontWeight: 600, color: 'rgba(255,255,255,.95)' }}>{phrase}</div>
        <div ref={refs.sub} data-ink style={{ fontSize: 12, fontWeight: 500, fontFamily: 'ui-monospace, monospace', color: INK_SOFT, fontVariantNumeric: 'tabular-nums' }}>&nbsp;</div>
        <ol data-ink aria-label={ut(lang, 'loader.stage_label', { n: 1, total: UPDATE_STEPS.length })} style={{
          listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: `repeat(${UPDATE_STEPS.length}, minmax(0, 1fr))`,
          gap: 8, width: 'min(460px, 100%)',
        }}>
          {UPDATE_STEPS.map((s, i) => (
            <li key={s} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,.16)', overflow: 'hidden', position: 'relative' }}>
                <div ref={el => { refs.fills.current[i] = el }} style={{ position: 'absolute', inset: '0 auto 0 0', width: '100%', transformOrigin: 'left center', transform: `scaleX(${allDone ? 1 : 0})`, willChange: 'transform', background: allDone ? TO_COLOR : '#F59E0B', borderRadius: 2 }} />
              </div>
              <span ref={el => { refs.labels.current[i] = el }} style={{ fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: allDone ? TO_COLOR : INK_DIM }}>
                {ut(lang, STEP_LABEL[s])}
              </span>
            </li>
          ))}
        </ol>
        {note && <p data-ink style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: INK_SOFT, maxWidth: '46ch' }}>{ut(lang, 'loader.keep_open')}</p>}
      </div>
    </>
  )
}

function useLogo(): HTMLImageElement | null {
  const ref = useRef<HTMLImageElement | null>(null)
  if (!ref.current && typeof Image !== 'undefined') { ref.current = new Image(); ref.current.src = brandAsset('/minimalistLogo.png') }
  return ref.current
}

/**
 * Writes a style/text only when it changed: the loop runs every frame and most frames change nothing,
 * and a style write that changes nothing still costs a recalculation.
 */
const memo = new WeakMap<object, Record<string, string>>()
export function setStyle(el: HTMLElement, prop: 'width' | 'background' | 'animation' | 'transform' | 'color', val: string): void {
  let m = memo.get(el)
  if (!m) memo.set(el, m = {})
  if (m[prop] !== val) { m[prop] = val; el.style[prop] = val }
}
export function setText(el: HTMLElement, v: string): void {
  const m = memo.get(el) ?? {}; memo.set(el, m)
  if (m.text !== v) { m.text = v; el.textContent = v }
}

/** The fixed full-screen canvas. */
export const canvasStyle: CSSProperties = { position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block' }

/**
 * Drives the LOADER's scene from the live flow. Real progress only: the target comes from the real
 * step (`sceneTarget`), the download is advanced between polls from the measured rate (never past
 * one poll's worth), the restart is indeterminate, and what is displayed EASES toward the target.
 */
export function useRunScene(opts: {
  canvas: MutableRefObject<HTMLCanvasElement | null>; refs: StageRefs; flowRef: MutableRefObject<FlowState>
  lang: Lang; reduced: boolean; isMobile: boolean; enabled: boolean
}) {
  const logo = useLogo()
  const { canvas, refs, flowRef, lang, reduced, enabled } = opts
  useEffect(() => {
    const cv = canvas.current
    if (!enabled || !cv || !logo) return
    const scene: Scene = createScene(cv, UPDATE_ANIMATION, logo, reduced)
    scene.resize()
    // the hive leaves every LINE of text clear (no scrim): hand it the elements that carry ink
    const ink = (root: HTMLElement | null): HTMLElement[] => (root ? Array.from(root.querySelectorAll<HTMLElement>('[data-ink]')) : [])
    scene.setInk([...ink(refs.hud.current), ...ink(refs.foot.current)])
    const onResize = () => scene.resize()
    window.addEventListener('resize', onResize)
    let raf = 0, last = performance.now(), lastDrawn = -1e9, pShown = 0
    let stepAt = performance.now(), stepNow = 'data'
    const bars = [0, 0, 0, 0]
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) { last = now; return }
      if (reduced && now - lastDrawn < 500) return
      const dt = Math.min(64, now - last); last = now; lastDrawn = now
      const flow = flowRef.current, view = flow.view
      const step = view?.step ?? 'data'
      if (step !== stepNow) { stepNow = step; stepAt = now }
      const dl = flow.bytes ? estimateDownload(flow.bytes, flow.rate, Date.now(), UPGRADE_POLL_MS) : view?.download
      const brain = view ? Math.max(0, Math.min(1, (view.fraction - 0.55) / 0.17)) : 0
      const tg = sceneTarget(step, dl, now - stepAt, brain)
      const k = reduced ? 1 : dt / (dt + EASE_TAU_MS) // same feel at any frame rate
      pShown = reduced ? tg.p : easeToward(pShown, tg.p, dt)
      scene.drawRunning({ p: pShown, indet: tg.indet, now, dt })
      // the text layer, written straight into the DOM
      const total = flow.bytes?.total ?? 0
      const sub = refs.sub.current
      if (sub) {
        const at = ut(lang, 'loader.stage_label', { n: tg.i + 1, total: UPDATE_STEPS.length })
        setText(sub, step === 'data' && total > 0 && dl !== undefined
          ? `${at} · ${ut(lang, 'loader.mb', { a: (dl * total / 1048576).toFixed(1), b: (total / 1048576).toFixed(1) })}`
          : tg.indet ? `${at} · ${ut(lang, 'loader.waiting')}` : at)
      }
      for (let n = 0; n < UPDATE_STEPS.length; n++) {
        const goal = n < tg.i ? 1 : n === tg.i ? tg.frac : 0
        bars[n] = reduced ? goal : bars[n]! + (goal - bars[n]!) * Math.min(1, k)
        const el = refs.fills.current[n], lab = refs.labels.current[n]
        if (el) {
          const indet = n === tg.i && tg.indet
          // the fill is a compositor transform, not a width: nothing here touches layout
          setStyle(el, 'width', indet ? '35%' : '100%')
          setStyle(el, 'background', n < tg.i ? '#10b981' : '#F59E0B')
          setStyle(el, 'animation', indet && !reduced ? 'ag-upd-indet 1.4s ease-in-out infinite' : 'none')
          setStyle(el, 'transform', indet && !reduced ? '' : `scaleX(${indet ? 1 : bars[n]!.toFixed(3)})`)
        }
        if (lab) setStyle(lab, 'color', n < tg.i ? '#10b981' : n === tg.i ? 'rgba(255,255,255,.95)' : INK_DIM)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); scene.dispose() }
  }, [enabled, reduced, lang, logo, canvas, refs, flowRef])
}

export { stepIndex }
