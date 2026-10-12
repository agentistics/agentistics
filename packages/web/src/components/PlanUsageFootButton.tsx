import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Gauge } from 'lucide-react'
import { HARNESS_LABELS } from '../lib/harness'
import { currentUsedPct, limitLevel, limitLevelWord, usePlanLimits, windowLabel } from '../lib/planLimits'
import { requestPlanUsageModal } from '../lib/planUsageModalRequests'
import { scrollIsOutside } from '../lib/popoverScroll'
import { LimitLevelIcon, PlanUsageSummary } from './PlanLimitMeter'

const POP_W = 344
const CARET = 10
const GRACE_MS = 100

/**
 * The sidebar footer's "Uso" button: hover or keyboard focus opens the plan-usage summary in a
 * portaled popover with a caret on the button; click opens the plan-usage modal. Icon only (so the five
 * footer buttons share one width); the level badge appears when a window is at 75% or more.
 */
export function PlanUsageFootButton({ lang, collapsed, footBtn }: { lang: 'pt' | 'en'; collapsed: boolean; footBtn: CSSProperties }) {
  const pt = lang === 'pt'
  const snap = usePlanLimits()
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const worst = useMemo(() => (snap.limits ?? []).flatMap(l => l.windows.map(w => ({ l, w, pct: currentUsedPct(w, snap.now) }))).sort((a, b) => b.pct - a.pct)[0], [snap.limits, snap.now])
  const level = limitLevel(worst?.pct ?? null)
  const base = pt ? 'Uso dos planos' : 'Plan usage'
  const label = worst && level !== 'ok'
    ? `${base} — ${limitLevelWord(level, lang)}: ${HARNESS_LABELS[worst.l.harness]}, ${windowLabel(worst.w.kind, lang)} ${pt ? 'em' : 'at'} ${Math.round(worst.pct)}%`
    : base
  const open = useCallback(() => { if (timer.current) clearTimeout(timer.current); const r = btnRef.current?.getBoundingClientRect(); if (r) setRect(r) }, [])
  const close = useCallback(() => { if (timer.current) clearTimeout(timer.current); setRect(null) }, [])
  const closeSoon = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setRect(null), GRACE_MS) }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useLayoutEffect(() => { if (rect) close() }, [collapsed]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!rect) return
    const onScroll = (e: Event) => { if (scrollIsOutside(popRef.current, e.target)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('keydown', onKey) }
  }, [rect, close])

  let pop: React.ReactNode = null
  if (rect) {
    const common: CSSProperties = { position: 'fixed', zIndex: 600, background: 'var(--bg-card)', border: '1px solid var(--ag-tint-4)', borderRadius: 12, boxShadow: 'var(--ag-shadow-menu)' }
    const caret: CSSProperties = { position: 'absolute', width: CARET, height: CARET, background: 'var(--bg-card)', transform: 'rotate(45deg)' }
    const style: CSSProperties = collapsed
      // Collapsed rail: opens to the RIGHT, caret on the left edge at the button's vertical middle.
      ? { ...common, left: rect.right + CARET + 4, bottom: Math.max(8, window.innerHeight - rect.bottom - 8) }
      // Expanded: opens UPWARD, left-aligned to the aside, caret under the button's centre.
      : { ...common, left: 8, bottom: window.innerHeight - rect.top + CARET + 2 }
    const caretLeft = rect.left + rect.width / 2 - (collapsed ? 0 : 8) - CARET / 2
    pop = createPortal(
      <div ref={popRef} role="dialog" aria-labelledby="plan-usage-summary-title" data-plan-usage-popover style={{ ...style, maxWidth: POP_W + 20 }} onMouseEnter={open} onMouseLeave={closeSoon}>
        <PlanUsageSummary onOpen={() => { requestPlanUsageModal(); close() }} limits={snap.limits} registered={snap.registered} now={snap.now} lang={lang} />
        {collapsed
          ? <span aria-hidden style={{ ...caret, left: -CARET / 2 - 1, bottom: Math.max(4, rect.height / 2 + 8 - CARET / 2 - 8), borderLeft: '1px solid var(--ag-tint-4)', borderBottom: '1px solid var(--ag-tint-4)' }} />
          : <span aria-hidden style={{ ...caret, bottom: -CARET / 2 - 1, left: Math.min(POP_W - 20, Math.max(8, caretLeft)), borderRight: '1px solid var(--ag-tint-4)', borderBottom: '1px solid var(--ag-tint-4)' }} />}
      </div>,
      document.body,
    )
  }
  return (
    <div style={{ flex: collapsed ? undefined : 1, minWidth: 0, width: collapsed ? 34 : 'auto', position: 'relative', display: 'flex' }} onMouseEnter={open} onMouseLeave={closeSoon}>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={rect !== null}
        onFocus={open} onBlur={closeSoon}
        onClick={() => { requestPlanUsageModal(); close() }}
        style={{ ...footBtn, width: collapsed ? 34 : '100%', flex: 1, minWidth: 0, position: 'relative' }}
      >
        <Gauge size={15} />
        {level !== 'ok' && <span style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LimitLevelIcon pct={worst!.pct} size={14} lang={lang} /></span>}
      </button>
      {pop}
    </div>
  )
}
