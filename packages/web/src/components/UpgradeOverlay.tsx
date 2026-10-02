/**
 * UpgradeOverlay.tsx — what the screen shows while the machine updates itself.
 *
 * Drawn from `useUpgradeFlow()` and nothing else, so the popup in the Nay window and the bell's
 * sheet start the same flow and see the same loader. Every step it narrates is a REAL stage
 * (`upgradeSteps.ts`): the bar under "Download" is bytes over content-length when GitHub sent one
 * and absent otherwise, never a timer dressed up as progress. The line above it rotates through
 * the step's phrase pool (`updateI18n.ts`).
 *
 * It owns the page while it runs (an upgrade restarts the process serving it, so nothing behind
 * it would work anyway) and gives it back on failure or timeout, with the reason in words.
 */

import { useEffect, useState, type CSSProperties } from 'react'
import { Check, RotateCw, X } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { UpgradeCore } from './UpgradeCore'
import { PHRASE_ROTATE_MS, UPDATE_STEPS, pickPhrase, ut, versionSeed, type UpdateKey } from '../lib/updateI18n'
import { dismissFlow, startUpgrade, useUpgradeFlow } from '../lib/upgradeFlow'
import { stepIndex } from '../lib/upgradeSteps'
import { prefersReducedMotion } from '../lib/nayNotifyAnim'

const STEP_LABEL: Record<(typeof UPDATE_STEPS)[number], UpdateKey> = {
  data: 'loader.step.data', brain: 'loader.step.brain', wiring: 'loader.step.wiring', power: 'loader.step.power',
}

export function UpgradeOverlay({ lang, isMobile }: { lang: Lang; isMobile: boolean }) {
  const flow = useUpgradeFlow()
  const [reduced] = useState(prefersReducedMotion)
  const [tick, setTick] = useState(0)
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth))
  const step = flow.view?.step ?? 'data'
  const active = flow.phase !== 'idle'

  // A new line every few seconds while a step lasts; a new step starts its own pool from the top.
  useEffect(() => { setTick(0) }, [step])
  useEffect(() => {
    if (!active || reduced || flow.phase === 'failed' || flow.phase === 'timeout') return
    const t = window.setInterval(() => setTick(n => n + 1), PHRASE_ROTATE_MS)
    return () => window.clearInterval(t)
  }, [active, reduced, flow.phase])
  useEffect(() => {
    const on = () => setVw(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  if (!active) return null
  const seed = versionSeed(flow.target)
  const phraseKey = pickPhrase(step, seed, tick)
  const stopped = flow.phase === 'failed' || flow.phase === 'timeout'
  const size = Math.min(isMobile ? 260 : 320, vw - 48)
  const at = stepIndex(step)
  const download = flow.view?.download

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ut(lang, 'loader.title', { version: flow.target })}
      data-testid="upgrade-overlay"
      data-step={step}
      data-phase={flow.phase}
      style={{
        position: 'fixed', inset: 0, zIndex: 10050,
        background: 'radial-gradient(ellipse at 50% 38%, #141b2b 0%, #0a0e17 55%, #05070b 100%)',
        color: '#e5e7eb', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))',
        overflowY: 'auto', fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#fb923c', marginBottom: 6 }}>
        Agentistics
      </div>
      <h2 style={{ margin: 0, fontSize: isMobile ? 18 : 20, fontWeight: 800, letterSpacing: '-0.01em', textAlign: 'center' }}>
        {ut(lang, 'loader.title', { version: flow.target })}
      </h2>

      <div style={{ margin: isMobile ? '18px 0 10px' : '24px 0 14px', opacity: stopped ? 0.35 : 1, transition: 'opacity 300ms' }}>
        <UpgradeCore fraction={flow.view?.fraction ?? 0} step={step} size={size} isMobile={isMobile} reducedMotion={reduced} />
      </div>

      {!stopped ? (
        <>
          {/* The narration — a live region, so a screen reader hears each new line once. */}
          <div aria-live="polite" style={{ minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', maxWidth: 420, textAlign: 'center' }}>
            <span key={phraseKey} className="ag-upd-phrase" style={{ fontSize: isMobile ? 15 : 16, fontWeight: 600, color: '#fde68a' }}>
              {ut(lang, phraseKey)}…
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
            {ut(lang, 'loader.stage_label', { n: at + 1, total: UPDATE_STEPS.length })}
            {step === 'data' && download !== undefined && <> · {ut(lang, 'loader.percent', { pct: Math.floor(download * 100) })}</>}
          </div>

          <ol aria-label={ut(lang, 'loader.stage_label', { n: at + 1, total: UPDATE_STEPS.length })} style={{
            listStyle: 'none', padding: 0, margin: '18px 0 0', display: 'grid',
            gridTemplateColumns: `repeat(${UPDATE_STEPS.length}, minmax(0, 1fr))`, gap: isMobile ? 6 : 10,
            width: '100%', maxWidth: 440,
          }}>
            {UPDATE_STEPS.map((s, i) => {
              const done = i < at || flow.phase === 'arrived'
              const now = i === at && flow.phase !== 'arrived'
              return (
                <li key={s} aria-current={now ? 'step' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <div style={{ width: '100%', height: 4, borderRadius: 2, background: 'rgba(148,163,184,0.18)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 2,
                      width: done ? '100%' : now ? (s === 'data' && download !== undefined ? `${Math.max(6, download * 100)}%` : '40%') : '0%',
                      background: done ? '#5eead4' : 'linear-gradient(90deg, #f97316, #fbbf24)',
                      transition: 'width 400ms ease',
                    }} className={now && !(s === 'data' && download !== undefined) ? 'ag-upd-shimmer' : undefined} />
                  </div>
                  <span style={{
                    fontSize: 10.5, fontWeight: now ? 700 : 500, color: done ? '#5eead4' : now ? '#fde68a' : '#64748b',
                    display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
                  }}>
                    {done && <Check size={11} />}{ut(lang, STEP_LABEL[s])}
                  </span>
                </li>
              )
            })}
          </ol>
          <p style={{ fontSize: 11.5, color: '#64748b', margin: '18px 0 0', maxWidth: 380, textAlign: 'center', lineHeight: 1.5 }}>
            {ut(lang, 'loader.keep_open')}
          </p>
        </>
      ) : (
        <div role="alert" style={{ maxWidth: 400, textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fca5a5', marginBottom: 6 }}>
            {ut(lang, flow.phase === 'failed' ? 'loader.failed_title' : 'loader.timeout_title')}
          </div>
          <p style={{ fontSize: 13, color: '#cbd5e1', margin: '0 0 16px', lineHeight: 1.6 }}>
            {flow.message ?? ut(lang, flow.phase === 'failed' ? 'loader.failed_body' : 'loader.timeout_body')}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            {flow.phase === 'failed' ? (
              <button type="button" onClick={() => { const v = flow.target; dismissFlow(); void startUpgrade(v, lang === 'pt' ? 'pt' : 'en') }} style={primaryBtn}>
                <RotateCw size={14} /> {ut(lang, 'loader.retry')}
              </button>
            ) : (
              <button type="button" onClick={() => window.location.reload()} style={primaryBtn}>
                <RotateCw size={14} /> {ut(lang, 'loader.reload')}
              </button>
            )}
            <button type="button" onClick={dismissFlow} style={ghostBtn}>
              <X size={14} /> {ut(lang, 'loader.dismiss')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// @touch-intentional — the loader's recovery actions are full dialog buttons, 44px on every screen.
const primaryBtn: CSSProperties = {
  // @touch-intentional — a full dialog button; 44px of paint on every screen.
  display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '0 18px', borderRadius: 10,
  border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700, background: '#f97316', color: '#fff',
}
// @touch-intentional — see primaryBtn.
const ghostBtn: CSSProperties = {
  // @touch-intentional — a full dialog button; 44px of paint on every screen.
  display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '0 18px', borderRadius: 10,
  border: '1px solid rgba(148,163,184,0.35)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 13.5, fontWeight: 600, color: '#cbd5e1',
}
