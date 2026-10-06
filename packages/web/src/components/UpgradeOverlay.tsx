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

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { RotateCw, X } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { PHRASE_ROTATE_MS, pickPhrase, ut, versionSeed } from '../lib/updateI18n'
import { dismissFlow, startUpgrade, useUpgradeFlow } from '../lib/upgradeFlow'
import { prefersReducedMotion } from '../lib/nayNotifyAnim'
import { StageText, canvasStyle, titleText, useRunScene, useStageRefs } from './UpdateStage'

export function UpgradeOverlay({ lang, isMobile }: { lang: Lang; isMobile: boolean }) {
  const flow = useUpgradeFlow()
  const [reduced] = useState(prefersReducedMotion)
  const [tick, setTick] = useState(0)
  const step = flow.view?.step ?? 'data'
  const active = flow.phase !== 'idle'
  const stopped = flow.phase === 'failed' || flow.phase === 'timeout'
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const flowRef = useRef(flow)
  flowRef.current = flow
  const refs = useStageRefs()

  // A new line every few seconds while a step lasts; a new step starts its own pool from the top.
  useEffect(() => { setTick(0) }, [step])
  useEffect(() => {
    if (!active || reduced || stopped) return
    const t = window.setInterval(() => setTick(n => n + 1), PHRASE_ROTATE_MS)
    return () => window.clearInterval(t)
  }, [active, reduced, stopped])

  useRunScene({ canvas, refs, flowRef, lang, reduced, isMobile, enabled: active })

  if (!active) return null
  const phraseKey = pickPhrase(step, versionSeed(flow.target), tick)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={titleText(lang, 'loader.title', flow.from, flow.target)}
      data-testid="upgrade-overlay"
      data-step={step}
      data-phase={flow.phase}
      style={{ position: 'fixed', inset: 0, zIndex: 10050, background: '#0a0a0f', color: 'rgba(255,255,255,.95)', fontFamily: 'inherit' }}
    >
      <canvas ref={canvas} aria-hidden style={canvasStyle} />
      {!stopped ? (
        <StageText
          lang={lang} isMobile={isMobile} refs={refs} from={flow.from} to={flow.target} title="loader.title" note
          phrase={<span key={phraseKey} className="ag-upd-phrase">{ut(lang, phraseKey)}…</span>}
        />
      ) : (
        <div role="alert" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', background: 'rgba(10,10,15,.72)' }}>
          <div style={{ maxWidth: 400 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#fca5a5', marginBottom: 6 }}>
              {ut(lang, flow.phase === 'failed' ? 'loader.failed_title' : 'loader.timeout_title')}
            </div>
            <p style={{ fontSize: 13, color: '#cbd5e1', margin: '0 0 16px', lineHeight: 1.6 }}>
              {flow.message ?? ut(lang, flow.phase === 'failed' ? 'loader.failed_body' : 'loader.timeout_body')}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={() => { const v = flow.target; dismissFlow(); void startUpgrade(v, lang === 'pt' ? 'pt' : 'en') }} style={primaryBtn}>
                <RotateCw size={14} /> {ut(lang, 'loader.retry')}
              </button>
              <button type="button" onClick={dismissFlow} style={ghostBtn}>
                <X size={14} /> {ut(lang, 'loader.dismiss')}
              </button>
            </div>
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
