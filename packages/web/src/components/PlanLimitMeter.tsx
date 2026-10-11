/**
 * The ONE plan-limit meter, drawn the same way on every surface that shows a plan's windows — the
 * composer circle's panel, the new-session harness cards and Nay's Limits tab. Same bar, same
 * colours (`limitTone`), same words (`lib/planLimits.ts`): the owner's rule is that the three
 * surfaces carry the same design and the same information, so they share this file rather than
 * each drawing their own.
 *
 * A harness with no record draws NOTHING (the callers simply have no `PlanLimits` for it) — never a
 * zero bar: nothing observed is not nothing used.
 */
import { windowRenewed, type PlanLimitWindow, type PlanLimits } from '@agentistics/core'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { HARNESS_LABELS } from '../lib/harness'
import { HarnessMark } from './sessions/HarnessMark'
import {
  currentUsedPct, forecastPhrase, LIMIT_WARN, limitTone, resetPhrase, shortWhen, SOURCE_LABEL, stalePhrase,
  updatedPhrase, warnForecast, windowLabel, windowShort, fmtWhen,
} from '../lib/planLimits'

type Lang = 'pt' | 'en'

export function PlanUsageRing({ pct, size = 36, stroke = 3, children }: { pct: number | null; size?: number; stroke?: number; children?: ReactNode }) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const value = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return <span style={{ position: 'relative', width: size, height: size, display: 'inline-flex', flexShrink: 0 }}>
    <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--ag-tint-4)" strokeWidth={stroke} strokeDasharray={pct === null ? '3 3' : undefined} />
      {pct !== null && <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={limitTone(value)} strokeWidth={stroke} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
    </svg>
    {children !== undefined && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: pct !== null && pct >= 75 ? limitTone(value) : 'var(--text-primary)' }}>{children}</span>}
  </span>
}

export function LimitLevelIcon({ pct, size = 16 }: { pct: number | null; size?: number }) {
  if (pct === null || pct < 75) return null
  const critical = pct >= 95
  return <svg aria-label={critical ? 'critical limit' : 'limit attention'} width={size} height={size} viewBox="0 0 20 20" role="img" style={{ color: critical ? 'var(--accent-red)' : 'var(--anthropic-orange)', flexShrink: 0 }}>
    {critical ? <polygon points="6,1 14,1 19,6 19,14 14,19 6,19 1,14 1,6" fill="currentColor" /> : <polygon points="10,1 19,18 1,18" fill="currentColor" />}
    <text x="10" y={critical ? 14 : 15} textAnchor="middle" fontSize="12" fontWeight="800" fill="var(--bg-base)">!</text>
  </svg>
}

function subscriptionRows(limits: PlanLimits[] | null, registered: { harness: PlanLimits['harness']; plan: string }[]) {
  const found = new Set((limits ?? []).map(l => l.harness))
  return [...(limits ?? []).map(l => ({ limits: l, harness: l.harness, plan: l.plan ?? l.sourcePlan })), ...registered.filter(r => !found.has(r.harness)).map(r => ({ limits: null, harness: r.harness, plan: r.plan }))]
}

export function PlanUsageSummary({ limits, registered = [], now, lang }: { limits: PlanLimits[] | null; registered?: { harness: PlanLimits['harness']; plan: string }[]; now: number; lang: Lang }) {
  const rows = subscriptionRows(limits, registered)
  return <div data-plan-usage-summary style={{ width: 344, padding: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 8px', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--text-secondary)' }}>◉ <span id="plan-usage-summary-title">{lang === 'pt' ? 'Uso dos planos' : 'Plan usage'}</span><span style={{ marginLeft: 'auto', fontWeight: 500, letterSpacing: 0 }}>{lang === 'pt' ? '% usado' : '% used'}</span></div>
    {rows.map(row => <div key={row.harness} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'center', gap: 8, padding: '8px 4px', borderTop: '1px solid var(--border)' }}>
      <HarnessMark harness={row.harness} size={20} />
      <div style={{ minWidth: 0 }}><b style={{ display: 'block', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{HARNESS_LABELS[row.harness]}</b><span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.plan ?? (lang === 'pt' ? 'plano não registrado' : 'plan not registered')}</span></div>
      {row.limits ? row.limits.windows.map(w => <div key={w.kind} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}><PlanUsageRing pct={currentUsedPct(w, now)} size={36}>{Math.round(currentUsedPct(w, now))}</PlanUsageRing><span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{windowLabel(w.kind, lang)}</span></div>) : <span style={{ gridColumn: '3 / -1', fontSize: 11.5, color: 'var(--text-secondary)' }}>{lang === 'pt' ? 'aguardando leitura' : 'waiting for the first reading'}</span>}
    </div>)}
    {rows.some(r => r.limits?.windows.some(w => currentUsedPct(w, now) >= 75)) && <div style={{ padding: '7px 4px', fontSize: 11.5, color: 'var(--text-secondary)' }}>{rows.flatMap(r => (r.limits?.windows ?? []).filter(w => currentUsedPct(w, now) >= 75).slice(0, 1).map(w => <span key={`${r.harness}:${w.kind}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><LimitLevelIcon pct={currentUsedPct(w, now)} />{HARNESS_LABELS[r.harness]}: {windowLabel(w.kind, lang)} em {Math.round(currentUsedPct(w, now))}% · {lang === 'pt' ? 'renova' : 'resets'} {fmtWhen(w.resetsAt, now, lang)}</span>))}</div>}
    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 4px 4px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>{lang === 'pt' ? 'Clique para ver tudo' : 'Click to see everything'} <b style={{ float: 'right', color: 'var(--anthropic-orange)' }}>{lang === 'pt' ? 'Abrir ›' : 'Open ›'}</b></div>
  </div>
}

export function PlanUsageCard({ limits, now, lang }: { limits: PlanLimits; now: number; lang: Lang }) {
  const pt = lang === 'pt'
  const values = limits.windows.map(w => currentUsedPct(w, now))
  const worst = Math.max(...values, 0)
  const state = worst >= 95 ? (pt ? 'quase no fim' : 'almost exhausted') : worst >= 75 ? (pt ? 'atenção' : 'attention') : (pt ? 'com folga' : 'room to spare')
  return <div data-plan-usage-card={limits.harness} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><HarnessMark harness={limits.harness} size={24} /><div style={{ minWidth: 0 }}><b style={{ display: 'block', fontSize: 14 }}>{HARNESS_LABELS[limits.harness]}</b><span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{limits.plan ?? limits.sourcePlan ?? (pt ? 'plano não registrado' : 'plan not registered')}</span></div><span style={{ marginLeft: 'auto', fontSize: 12, color: worst >= 95 ? 'var(--accent-red)' : worst >= 75 ? 'var(--anthropic-orange)' : 'var(--accent-green)' }}><LimitLevelIcon pct={worst} />{state}</span></div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{limits.windows.map(w => { const pct = currentUsedPct(w, now); const f = warnForecast(w, now); return <div key={w.kind} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 10, borderRadius: 10, background: 'var(--ag-tint-2)' }}><PlanUsageRing pct={pct} size={48}>{Math.round(pct)}%</PlanUsageRing><div style={{ minWidth: 0, fontSize: 12 }}><b style={{ display: 'block' }}>{windowLabel(w.kind, lang)}</b><span style={{ display: 'block', color: 'var(--text-secondary)' }}>{Math.round(pct)}% {pt ? 'usado' : 'used'} · {100 - Math.round(pct)}% {pt ? 'restam' : 'left'}</span><span style={{ display: 'block', color: 'var(--text-tertiary)' }}>{resetPhrase(w, now, lang)}</span>{f && <span style={{ display: 'block', color: LIMIT_WARN, fontWeight: 600 }}>{forecastPhrase(f, now, lang)}</span>}</div><LimitLevelIcon pct={pct} /></div> })}</div>
    {stalePhrase(limits, now, lang) && <span style={{ fontSize: 11, color: 'var(--anthropic-orange)' }}>{stalePhrase(limits, now, lang)}</span>}
  </div>
}

export function PlanLimitMeter({ window: w, now, lang, forecast = false }: {
  window: PlanLimitWindow
  now: number
  lang: Lang
  /** Add the at-current-pace forecast under the bar (the new-session cards). */
  forecast?: boolean
}) {
  const pct = currentUsedPct(w, now)
  const shown = Math.round(pct)
  // A window that renewed since the last reading has no figure of its own yet: said, not zeroed.
  const renewed = windowRenewed(w, now)
  const tone = limitTone(pct)
  // The forecast is said ONLY when the window runs out before it renews — in amber, never green.
  const f = forecast ? warnForecast(w, now) : null
  const label = windowLabel(w.kind, lang)
  return (
    <div data-plan-window={w.kind} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
        <span style={{ color: 'var(--text-tertiary)', width: 44, flexShrink: 0 }}>{label}</span>
        <div
          role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}
          aria-label={`${label}: ${shown}%`}
          style={{ flex: 1, minWidth: 30, height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}
        >
          <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: tone, borderRadius: 3, transition: 'width 0.3s' }} />
        </div>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>{renewed ? '–' : `${shown}%`}</span>
      </div>
      <div style={{ paddingLeft: 50, fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.35 }}>
        {resetPhrase(w, now, lang)}
        {f && (
          <span data-plan-forecast style={{ color: LIMIT_WARN, fontWeight: 600 }}>
            {' · '}{forecastPhrase(f, now, lang)}
          </span>
        )}
      </div>
    </div>
  )
}

/** A plan's windows as meters, with (optionally) the plan name, last update and source. */
export function PlanLimitsBlock({ limits, now, lang, forecast = false, header = false, details = false }: {
  limits: PlanLimits
  now: number
  lang: Lang
  forecast?: boolean
  /** Harness + plan name above the meters (Nay's Limits tab). */
  header?: boolean
  /** "updated X ago · source" under them (always said when stale, even without `details`). */
  details?: boolean
}) {
  const pt = lang === 'pt'
  const stale = stalePhrase(limits, now, lang)
  const plan = limits.plan ?? limits.sourcePlan
  return (
    <div data-plan-limits={limits.harness} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {header && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12.5 }}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{HARNESS_LABELS[limits.harness]}</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {plan ?? (pt ? 'plano não registrado' : 'plan not registered')}
          </span>
        </div>
      )}
      {limits.windows.map(w => <PlanLimitMeter key={w.kind} window={w} now={now} lang={lang} forecast={forecast} />)}
      {(details || stale) && (
        <div style={{ fontSize: 10.5, color: stale ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }}>
          {details ? updatedPhrase(limits, now, lang) : stale}
          {details && ` · ${pt ? 'fonte' : 'source'}: ${SOURCE_LABEL[limits.source][lang]}`}
        </div>
      )}
    </div>
  )
}

/**
 * The composer circle's two thin OUTER arcs — 5 h inside, week outside — drawn around a gauge of
 * `size` px. Positioned absolutely so the gauge's own layout does not move.
 */
export function PlanLimitArcs({ limits, now, size }: { limits: PlanLimits; now: number; size: number }) {
  const stroke = 1.6
  const gap = 1.4
  const outer = size + 2 * 2 * (stroke + gap)
  const ring = (kind: '5h' | 'week', index: number) => {
    const w = limits.windows.find(x => x.kind === kind)
    if (!w) return null
    const pct = currentUsedPct(w, now)
    const r = size / 2 + gap + stroke / 2 + index * (stroke + gap)
    const c = 2 * Math.PI * r
    return (
      <g key={kind} data-plan-arc={kind}>
        <circle cx={outer / 2} cy={outer / 2} r={r} fill="none" stroke="var(--border-subtle, var(--border))" strokeWidth={stroke} />
        <circle
          cx={outer / 2} cy={outer / 2} r={r} fill="none" stroke={limitTone(pct)} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, pct / 100)))}
          strokeLinecap="round" transform={`rotate(-90 ${outer / 2} ${outer / 2})`}
          style={{ transition: 'stroke-dashoffset 0.3s, stroke 0.3s' }}
        />
      </g>
    )
  }
  const inset = -(outer - size) / 2
  return (
    <svg
      aria-hidden width={outer} height={outer} viewBox={`0 0 ${outer} ${outer}`}
      style={{ position: 'absolute', top: inset, left: inset, pointerEvents: 'none' }}
    >
      {ring('5h', 0)}
      {ring('week', 1)}
    </svg>
  )
}

/**
 * The COMPACT reading for the new-session cards (owner's mock D): one thin bar per window, each on
 * ONE line — "5 h ▬▬ 2% · 23:53", "sem ▬▬ 32% · qui" — and at most one short amber line, only when
 * a window runs out before it renews. Same bar, colours and words as `PlanLimitMeter`.
 */
export function PlanLimitBars({ limits, now, lang }: { limits: PlanLimits; now: number; lang: Lang }) {
  const warn = limits.windows.map(w => warnForecast(w, now)).find(Boolean) ?? null
  return (
    <div data-plan-limits={limits.harness} data-plan-compact style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', columnGap: 6, rowGap: 3, fontSize: 10.5, minWidth: 0 }}>
      {limits.windows.map(w => {
        const pct = currentUsedPct(w, now)
        const renewed = windowRenewed(w, now)
        const label = windowShort(w.kind, lang)
        return [
          <span key={`${w.kind}l`} style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{label}</span>,
          <div key={`${w.kind}b`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
            aria-label={`${windowLabel(w.kind, lang)}: ${Math.round(pct)}%`}
            style={{ height: 3, minWidth: 16, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: limitTone(pct), borderRadius: 2 }} />
          </div>,
          <span key={`${w.kind}v`} data-plan-window={w.kind} style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {renewed ? '–' : `${Math.round(pct)}%`} · {shortWhen(w.resetsAt, now, lang, w.kind)}
          </span>,
        ]
      })}
      {warn && (
        <span data-plan-forecast style={{ gridColumn: '1 / -1', color: LIMIT_WARN, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {forecastPhrase(warn, now, lang)}
        </span>
      )}
    </div>
  )
}

/**
 * The hover card over a harness chip (new-session wizard, desktop): the harness, its plan and the
 * compact bars. Same look as the right rail's tooltip; never takes the pointer; opens upward.
 */
export function PlanLimitsTooltip({ limits, now, lang, x, y }: { limits: PlanLimits; now: number; lang: Lang; x: number; y: number }) {
  const plan = limits.plan ?? limits.sourcePlan
  return createPortal(
    <div role="tooltip" data-plan-tooltip={limits.harness} style={{
      position: 'fixed', left: Math.min(x, (typeof window === 'undefined' ? 1280 : window.innerWidth) - 248), top: y,
      // Opens ABOVE the chip (owner, 2026-10-10): `y` is the chip's top edge.
      transform: 'translateY(-100%)',
      width: 240, padding: '8px 10px', borderRadius: 8, boxSizing: 'border-box',
      background: 'var(--bg-elevated)', color: 'var(--text-primary)',
      border: '1px solid var(--border)', boxShadow: '0 4px 12px -4px rgba(0,0,0,0.4)',
      pointerEvents: 'none', zIndex: 4000, display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
        <span style={{ fontWeight: 700 }}>{HARNESS_LABELS[limits.harness]}</span>
        {plan && <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plan}</span>}
      </div>
      <PlanLimitBars limits={limits} now={now} lang={lang} />
      {stalePhrase(limits, now, lang) && <span style={{ fontSize: 10, color: 'var(--anthropic-orange)' }}>{stalePhrase(limits, now, lang)}</span>}
    </div>,
    document.body,
  )
}
