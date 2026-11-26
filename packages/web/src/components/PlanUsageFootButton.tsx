import { useEscapeOwner } from '../lib/overlayStack'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Gauge } from 'lucide-react'
import { HARNESS_LABELS } from '../lib/harness'
import { currentUsedPct, limitLevel, limitLevelWord, usePlanLimits, windowLabel } from '../lib/planLimits'
import { requestUsagePage } from '../lib/usagePageRequests'
import { subscribePlanUsagePopup } from '../lib/planUsagePopupRequests'
import { scrollClosesPopover } from '../lib/popoverScroll'
import { LimitLevelIcon, PlanUsageSummary } from './PlanLimitMeter'
import { usePlanAgentUse } from '../lib/usePlanAgentUse'
import { ReloginModal } from '../pages/settings/ReloginModal'
import type { HarnessId } from '@agentistics/core'

const POP_W = 344
const CARET = 10
const GRACE_MS = 100
const EDGE = 8

/**
 * PURE. Where the popover sits for the footer button at `btn` (CONTAS.AGENDA-SALVAR): BESIDE the
 * button — to its right, past the sidebar — and centred vertically on the screen by the caller
 * (`top: 50%` + `translateY(-50%)`). On a phone (<= 600px) there is no sidebar beside anything: it is
 * a centred sheet 12px from each edge. `maxHeight` keeps it inside the screen; its list scrolls.
 */
export function anchorBeside(btn: { right: number }, viewportW: number, viewportH: number): { left: number; width: number; maxHeight: number; sheet: boolean } {
  const maxHeight = popMaxHeight(viewportH)
  if (viewportW <= 600) return { left: 12, width: Math.max(0, viewportW - 24), maxHeight, sheet: true }
  const left = Math.min(btn.right + CARET + 4, Math.max(EDGE, viewportW - EDGE - 120))
  return { left, width: Math.max(0, Math.min(POP_W + 20, viewportW - EDGE - left)), maxHeight, sheet: false }
}

/** PURE. The popup never outgrows the room above its anchor (nor 560px): the list inside scrolls. */
export function popMaxHeight(room: number): number {
  return Math.max(160, Math.min(560, Math.floor(room) - EDGE))
}

/**
 * The sidebar footer's "Uso" button: hover or keyboard focus opens the plan-usage summary in a
 * portaled popover with a caret on the button; click opens the plan-usage modal. Icon only (so the five
 * footer buttons share one width); the level badge appears when a window is at 75% or more.
 */
export function PlanUsageFootButton({ lang, collapsed, footBtn }: { lang: 'pt' | 'en'; collapsed: boolean; footBtn: CSSProperties }) {
  const pt = lang === 'pt'
  const snap = usePlanLimits()
  const skipReturnFocus = useRef(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  // CONTAS.AGENDA-AGENTICA: per account, ONLY the agent-use switch and "Sign in again".
  const agentUse = usePlanAgentUse(rect !== null, lang)
  const [relogin, setRelogin] = useState<{ accountId: string; harness: HarnessId; who: string } | null>(null)
  const worst = useMemo(() => (snap.limits ?? []).flatMap(l => l.windows.map(w => ({ l, w, pct: currentUsedPct(w, snap.now) }))).sort((a, b) => b.pct - a.pct)[0], [snap.limits, snap.now])
  const level = limitLevel(worst?.pct ?? null)
  const base = pt ? 'Uso dos planos' : 'Plan usage'
  const label = worst && level !== 'ok'
    ? `${base} — ${limitLevelWord(level, lang)}: ${HARNESS_LABELS[worst.l.harness]}, ${windowLabel(worst.w.kind, lang, worst.w.scope)} ${pt ? 'em' : 'at'} ${Math.round(worst.pct)}%`
    : base
  const open = useCallback(() => { if (timer.current) clearTimeout(timer.current); const r = btnRef.current?.getBoundingClientRect(); if (r) setRect(r) }, [])
  const close = useCallback(() => { if (timer.current) clearTimeout(timer.current); setRect(null) }, [])
  const closeSoon = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setRect(null), GRACE_MS) }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useLayoutEffect(() => { if (rect) close() }, [collapsed]) // eslint-disable-line react-hooks/exhaustive-deps
  useEscapeOwner(!!rect, close)
  useEffect(() => {
    if (!rect) return
    // Only a PERSON's gesture may close it: a conversation that scrolls itself on a new message is not one. A press
    // outside the popup (or its button) closes it the way any popover does; a scroll closes it only right after a
    // wheel / touch / key gesture.
    let lastGesture: number | null = null
    const gesture = () => { lastGesture = Date.now() }
    const onScroll = (e: Event) => { if (scrollClosesPopover(popRef.current, e.target, lastGesture, Date.now())) close() }
    const onPress = (e: Event) => {
      const t = e.target as Node | null
      if (t && (popRef.current?.contains(t) || btnRef.current?.contains(t))) return
      close()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('wheel', gesture, true)
    window.addEventListener('touchmove', gesture, true)
    window.addEventListener('keydown', gesture, true)
    window.addEventListener('pointerdown', onPress, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('wheel', gesture, true)
      window.removeEventListener('touchmove', gesture, true)
      window.removeEventListener('keydown', gesture, true)
      window.removeEventListener('pointerdown', onPress, true)
    }
  }, [rect, close])

  // The popover is portaled to <body>, so the browser's tab order never reaches it from the button.
  // Tab from the button steps INTO it ("Open ›"); Tab out of it resumes after the button and
  // shift+Tab returns to it. Opening the modal focuses the button first, so the modal hands focus
  // back to the button — not to <body> — when it closes.
  const openModal = useCallback(() => { btnRef.current?.focus(); requestUsagePage(); close() }, [close])
  // Keyboard focus opens the summary; focus handed back by a modal closed with the pointer does not.
  const onBtnFocus = (e: React.FocusEvent<HTMLButtonElement>) => {
    if (skipReturnFocus.current) { skipReturnFocus.current = false; return }
    let visible = true
    try { visible = e.currentTarget.matches(':focus-visible') } catch { /* older engines: keep opening */ }
    if (visible) open()
  }
  const onBtnKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || e.shiftKey || !rect) return
    const target = popRef.current?.querySelector<HTMLElement>('[data-plan-usage-open]')
    if (target) { e.preventDefault(); target.focus() }
  }
  const onPopKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !btnRef.current) return
    const inside = Array.from(popRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])') ?? [])
    const index = inside.indexOf(document.activeElement as HTMLElement)
    const adjacent = inside[index + (e.shiftKey ? -1 : 1)]
    if (index >= 0 && adjacent) { e.preventDefault(); adjacent.focus(); return }
    e.preventDefault()
    if (e.shiftKey) { btnRef.current.focus(); return }
    const all = Array.from(document.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      .filter(el => !popRef.current?.contains(el) && el.offsetParent !== null)
    const next = all[all.indexOf(btnRef.current) + 1]
    close()
    ;(next ?? btnRef.current).focus()
  }

  let pop: React.ReactNode = null
  if (rect) {
    const common: CSSProperties = { display: 'flex', flexDirection: 'column', position: 'fixed', zIndex: 600, background: 'var(--bg-card)', border: '1px solid var(--ag-tint-4)', borderRadius: 12, boxShadow: 'var(--ag-shadow-menu)' }
    // CONTAS.AGENDA-SALVAR: the popup opens BESIDE its button (the sidebar's footer) and is centred
    // vertically on the SCREEN — never pinned to the top, never hugging the footer. On a phone it is a
    // centred sheet. No caret: it is not pointing at one spot of the button any more.
    const { left: popLeft, width: popW, maxHeight } = anchorBeside(rect, window.innerWidth, window.innerHeight)
    const style: CSSProperties = { ...common, left: popLeft, width: popW, top: '50%', transform: 'translateY(-50%)', maxHeight }
    pop = createPortal(
      <div ref={popRef} role="dialog" aria-labelledby="plan-usage-summary-title" data-plan-usage-popover data-plan-usage-placement="beside-centered" style={style} onMouseEnter={open} onMouseLeave={closeSoon} onFocus={open} onBlur={closeSoon} onKeyDown={onPopKey}>
        <PlanUsageSummary onOpen={openModal} agentUse={agentUse} onRelogin={r => { close(); setRelogin(r) }} limits={snap.limits} registered={snap.registered} accountLabels={snap.accountLabels} now={snap.now} lang={lang} />
      </div>,
      document.body,
    )
  }
  return (
    <div data-plan-usage-trigger style={{ flex: collapsed ? undefined : 1, minWidth: 0, width: collapsed ? 34 : 'auto', position: 'relative', display: 'flex' }} onMouseEnter={open} onMouseLeave={closeSoon}>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={rect !== null}
        onFocus={onBtnFocus} onBlur={closeSoon} onKeyDown={onBtnKey}
        onClick={openModal}
        data-plan-usage-hot={rect !== null ? 'true' : undefined}
        style={collapsed
          ? { ...footBtn, width: 34, flex: 1, minWidth: 0, position: 'relative' }
          : {
              // CONTAS.AGENDA-SALVAR r4 · N1: the prototype's labelled pill — dot + "Uso dos planos", hot while the popup is open.
              display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', minHeight: footBtn.height, padding: '5px 10px', borderRadius: 99,
              border: `1px solid ${rect !== null ? 'var(--anthropic-orange)' : 'var(--border)'}`,
              background: rect !== null ? 'var(--anthropic-orange-glow, var(--anthropic-orange-dim))' : 'transparent',
              color: rect !== null ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', transition: 'all 0.15s',
            }}
      >
        {collapsed ? <Gauge size={15} /> : <span data-plan-usage-dot aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: level === 'critical' ? 'var(--accent-red)' : level === 'attention' ? 'var(--anthropic-orange)' : 'var(--accent-green, #10b981)' }} />}
        {!collapsed && <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{base}</span>}
        {level !== 'ok' && (collapsed
          ? <span style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LimitLevelIcon pct={worst!.pct} size={14} lang={lang} /></span>
          : <span style={{ marginLeft: 'auto', display: 'inline-flex' }}><LimitLevelIcon pct={worst!.pct} size={14} lang={lang} /></span>)}
      </button>
      {pop}
      {relogin && <ReloginModal accountId={relogin.accountId} harness={relogin.harness} who={relogin.who} lang={lang} onClose={() => setRelogin(null)} />}
    </div>
  )
}

/**
 * The phone's way into the same popup (CONTAS.AGENDA-SALVAR U1): there is no sidebar footer button on
 * a phone, so the "Go to" sheet's "Uso dos planos" row opens THIS — the very `PlanUsageSummary` as a
 * centred sheet (`anchorBeside` answers `sheet: true` at <= 600px) over a scrim. A press outside, Esc or
 * "Abrir contas ›" closes it.
 */
export function PlanUsagePhoneSheet({ lang }: { lang: 'pt' | 'en' }) {
  const [open, setOpen] = useState(false)
  const snap = usePlanLimits()
  const agentUse = usePlanAgentUse(open, lang)
  const [relogin, setRelogin] = useState<{ accountId: string; harness: HarnessId; who: string } | null>(null)
  const close = useCallback(() => setOpen(false), [])
  useEffect(() => subscribePlanUsagePopup(() => setOpen(true)), [])
  useEscapeOwner(open, close)
  const { left, width, maxHeight } = anchorBeside({ right: 0 }, typeof window === 'undefined' ? 390 : window.innerWidth, typeof window === 'undefined' ? 800 : window.innerHeight)
  return <>
    {open && createPortal(
      <div data-plan-usage-scrim onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 599, background: 'var(--ag-scrim, rgba(0,0,0,0.55))' }}>
        <div role="dialog" aria-modal="true" aria-labelledby="plan-usage-summary-title" data-plan-usage-popover data-plan-usage-placement="phone-sheet" onClick={e => e.stopPropagation()}
          style={{ display: 'flex', flexDirection: 'column', position: 'fixed', zIndex: 600, background: 'var(--bg-card)', border: '1px solid var(--ag-tint-4)', borderRadius: 12, boxShadow: 'var(--ag-shadow-menu)', left, width, top: '50%', transform: 'translateY(-50%)', maxHeight }}>
          <PlanUsageSummary onOpen={() => { close(); requestUsagePage() }} agentUse={agentUse} onRelogin={r => { close(); setRelogin(r) }} limits={snap.limits} registered={snap.registered} accountLabels={snap.accountLabels} now={snap.now} lang={lang} />
        </div>
      </div>,
      document.body,
    )}
    {relogin && <ReloginModal accountId={relogin.accountId} harness={relogin.harness} who={relogin.who} lang={lang} onClose={() => setRelogin(null)} />}
  </>
}
