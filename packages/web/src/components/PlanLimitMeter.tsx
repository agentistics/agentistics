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
import { HARNESS_LABELS } from '../lib/harness'
import {
  currentUsedPct, forecastPhrase, LIMIT_HOT, LIMIT_WARN, limitTone, resetPhrase, shortWhen, SOURCE_LABEL, stalePhrase,
  updatedPhrase, warnForecast, windowLabel, windowShort,
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
 * The mini meter beside the composer's context circle (and under the % in the phone's header
 * button): "5 h ▬ 12%" / "7 d ▬ 47%", 3 px flat bars, tone from `limitTone`. Pure drawing — the
 * caller wraps it in the button that opens the metrics popover. A window renewed with no reading
 * says "–" (empty bar), never a zero.
 */
export function PlanLimitMini({ limits, now, lang, compact = false }: { limits: PlanLimits; now: number; lang: Lang; compact?: boolean }) {
  return (
    <span
      data-plan-mini={limits.harness}
      style={{
        display: 'grid', gridTemplateColumns: `auto ${compact ? 18 : 26}px auto`, columnGap: compact ? 3 : 5, rowGap: compact ? 2 : 3,
        alignItems: 'center', fontSize: compact ? 9 : 10, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', textAlign: 'left',
      }}
    >
      {limits.windows.map(w => {
        const pct = currentUsedPct(w, now)
        const renewed = windowRenewed(w, now)
        const shown = Math.round(pct)
        const label = windowShort(w.kind, lang)
        const hot = !renewed && pct >= LIMIT_HOT
        return [
          <span key={`${w.kind}k`} style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{label}</span>,
          <span key={`${w.kind}b`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}
            aria-label={`${windowLabel(w.kind, lang)}: ${renewed ? '–' : `${shown}%`}`}
            style={{ display: 'block', height: 3, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <span style={{ display: 'block', width: renewed ? 0 : `${Math.min(100, Math.max(0, pct))}%`, height: '100%', borderRadius: 2, background: limitTone(pct) }} />
          </span>,
          <span key={`${w.kind}v`} data-plan-window={w.kind} style={{
            minWidth: compact ? 18 : 22, textAlign: 'right', whiteSpace: 'nowrap',
            color: hot ? limitTone(pct) : 'var(--text-secondary)', fontWeight: hot ? 600 : 400,
          }}>{renewed ? '–' : `${shown}%`}</span>,
        ]
      })}
    </span>
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
