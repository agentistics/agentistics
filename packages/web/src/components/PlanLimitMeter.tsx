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
import type { PlanLimitWindow, PlanLimits } from '@agentistics/core'
import { HARNESS_LABELS } from '../lib/harness'
import {
  currentUsedPct, forecastPhrase, forecastWindow, limitTone, resetPhrase, SOURCE_LABEL, stalePhrase,
  updatedPhrase, windowLabel,
} from '../lib/planLimits'

type Lang = 'pt' | 'en'

export function PlanLimitMeter({ window: w, now, lang, forecast = false }: {
  window: PlanLimitWindow
  now: number
  lang: Lang
  /** Add the at-current-pace forecast under the bar (the new-session cards). */
  forecast?: boolean
}) {
  const pct = currentUsedPct(w, now)
  const shown = Math.round(pct)
  const tone = limitTone(pct)
  const f = forecastWindow(w, now)
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
        <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>{shown}%</span>
      </div>
      <div style={{ paddingLeft: 50, fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.35 }}>
        {resetPhrase(w, now, lang)}
        {forecast && f.kind !== 'renewed' && (
          <span style={{ color: f.kind === 'runs-out' || f.kind === 'exhausted' ? tone : undefined }}>
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
