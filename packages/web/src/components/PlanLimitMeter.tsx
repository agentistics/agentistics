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
import { effectiveWindow, windowKey, windowRenewed, type AgentSchedule, type PlanLimitWindow, type PlanLimits } from '@agentistics/core'
import { createPortal } from 'react-dom'
import { useId, useState, type ReactNode } from 'react'
import { CalendarClock, Gauge, KeyRound } from 'lucide-react'
import { PlanUsageScroll } from './PlanUsageScroll'
import { AgentScheduleEditor, AgentUseBadge } from './AgentScheduleEditor'
import { scheduleSummaryText, type AgentUseView } from '../lib/agentScheduleView'
import { HARNESS_LABELS } from '../lib/harness'
import { HarnessMark } from './sessions/HarnessMark'
import {
  currentUsedPct, forecastPhrase, LIMIT_WARN, limitTone, resetPhrase, ringResetPhrase, shortWhen, SOURCE_LABEL, stalePhrase,
  updatedPhrase, warnForecast, windowLabel, windowShort, fmtWhen, limitLevel, limitLevelWord, subscriptionName, subscriptionRows, type RegisteredPlan,
} from '../lib/planLimits'
import { ToggleSwitch } from './ToggleSwitch'
import { useApiUsage } from '../lib/apiUsage'
import { accountsSectionTitle, ApiUsageRows, SectionTitle, apiSectionTitle } from './ApiUsageSection'

type Lang = 'pt' | 'en'

function Unmeasured({ limits, lang }: { limits: PlanLimits; lang: Lang }) {
  if (!limits.unmeasuredReason) return null
  const blocked = /Go usage limit (?:exceeded|reached)/i.test(limits.unmeasuredReason)
  return <span data-plan-unmeasured style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>{lang === 'pt'
    ? (blocked ? 'Go bloqueado pelo limite do provedor. Renovação desconhecida; aguardando recuperação confirmada.' : 'Quota e renovação: sem medição do provedor.')
    : limits.unmeasuredReason}</span>
}

/** Keep computed reset times distinct from the harness's reported times. */
function windowResetPhrase(w: PlanLimitWindow, now: number, lang: Lang): string {
  if (!windowRenewed(w, now)) return resetPhrase(w, now, lang)
  const next = effectiveWindow(w, now)
  return `${resetPhrase(w, now, lang)} · ${lang === 'pt' ? 'renovação estimada' : 'estimated reset'} ${fmtWhen(next.resetsAt, now, lang)}`
}

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

export function LimitLevelIcon({ pct, size = 16, lang = 'pt', level = limitLevel(pct) }: { pct: number | null; size?: number; lang?: Lang; level?: ReturnType<typeof limitLevel> }) {
  if (level === 'ok') return null
  const critical = level === 'critical'
  return <svg aria-label={limitLevelWord(level, lang, pct)} width={size} height={size} viewBox="0 0 20 20" role="img" style={{ color: critical ? 'var(--accent-red)' : 'var(--anthropic-orange)', flexShrink: 0 }}>
    {critical ? <polygon points="6,1 14,1 19,6 19,14 14,19 6,19 1,14 1,6" fill="currentColor" /> : <polygon points="10,1 19,18 1,18" fill="currentColor" />}
    <text x="10" y={critical ? 14 : 15} textAnchor="middle" fontSize="12" fontWeight="800" fill="var(--bg-base)">!</text>
  </svg>
}

/** The grid one "Plan usage" row is laid out on: mark, name + plan, one ring per window. */
export const PLAN_ROW_GRID = { display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'center', gap: 8 } as const

/** One circle: the upper arc is 5 h, the lower arc is the week. Scoped readings remain named. */
export function PlanUsageIndicator({ limits, now, lang }: { limits: PlanLimits; now: number; lang: Lang }) {
  const tooltipId = useId()
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null)
  const showTooltip = (el: HTMLElement) => { const rect = el.getBoundingClientRect(); setTooltip({ x: Math.max(8, Math.min(rect.left, window.innerWidth - 256)), y: rect.top - 6 }) }
  const details = limits.windows.map(w => `${windowLabel(w.kind, lang, w.scope)}: ${windowRenewed(w, now) ? '–' : `${Math.round(currentUsedPct(w, now))}%`}${ringResetPhrase(w, now, lang) ? ` · ${ringResetPhrase(w, now, lang)}` : ''}`).join('\n')
  const arc = (kind: '5h' | 'week') => {
    const windows = limits.windows.filter(w => w.kind === kind)
    const pct = windows.length ? Math.max(...windows.map(w => currentUsedPct(w, now))) : null
    // Both arcs start on the LEFT and fill toward the right (the upper one over the top, the lower one
    // under the bottom), so the two readings grow the same way instead of one looking like it shrinks.
    const d = kind === '5h' ? 'M 4.17 14 A 12 12 0 0 1 27.83 14' : 'M 4.17 18 A 12 12 0 0 0 27.83 18'
    return <g data-plan-indicator-arc={kind} data-position={kind === '5h' ? 'top' : 'bottom'}>
      <path d={d} fill="none" stroke="var(--ag-tint-4)" strokeWidth={2.5} strokeDasharray={pct === null ? '2 3' : undefined} />
      {pct !== null && <path data-plan-indicator-fill d={d} pathLength={100} fill="none" stroke={limitTone(pct)} strokeWidth={2.5} strokeDasharray={`${Math.min(100, Math.max(0, pct))} 100`} strokeLinecap={pct > 0 ? 'round' : 'butt'} />}
    </g>
  }
  return <div data-plan-usage-indicator role="img" tabIndex={0} aria-label={details} aria-describedby={tooltip ? tooltipId : undefined}
    onMouseEnter={e => showTooltip(e.currentTarget)} onMouseLeave={() => setTooltip(null)} onFocus={e => showTooltip(e.currentTarget)} onBlur={() => setTooltip(null)}
    style={{ gridColumn: '3 / -1', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: 190 }}>
    <span style={{ position: 'relative', display: 'flex', width: 32, height: 32, flexShrink: 0 }}>
      <svg aria-hidden width={32} height={32} viewBox="0 0 32 32">{arc('5h')}{arc('week')}</svg>
      <Gauge size={12} aria-hidden style={{ position: 'absolute', top: 10, left: 10, color: 'var(--text-secondary)' }} />
    </span>
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, overflowWrap: 'anywhere', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
      <span>{limits.windows.map((w, i) => <span key={windowKey(w)}>{i > 0 ? ' · ' : ''}{w.kind === '5h' && !w.scope ? '5 h' : windowLabel(w.kind, lang, w.scope)} {windowRenewed(w, now) ? '–' : `${Math.round(currentUsedPct(w, now))}%`}</span>)}</span>
      {limits.windows.map(w => { const reset = ringResetPhrase(w, now, lang); return reset ? <span key={windowKey(w)} data-plan-ring-reset style={{ fontSize: 9.5, color: 'var(--text-tertiary)' }}>{w.kind === '5h' && !w.scope ? '5 h' : windowLabel(w.kind, lang, w.scope)} · {reset}</span> : null })}
    </span>
    {tooltip && createPortal(<span id={tooltipId} role="tooltip" style={{ position: 'fixed', left: tooltip.x, top: tooltip.y, transform: 'translateY(-100%)', maxWidth: 240, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 11, whiteSpace: 'pre-line', pointerEvents: 'none', zIndex: 4000 }}>{details}</span>, document.body)}
  </div>
}

/**
 * The CELLS of one "Plan usage" row — shared by the summary list and the account-switch picker
 * (CONTA.LIMITES), so an account reads the same in both. `note` replaces the plan line (a reason the
 * row cannot be picked); `tag` leads the plan line ("Current"), so it never cuts the name.
 */
export function PlanUsageRowCells({ harness, name, plan, limits: reading, now, lang, note, tag, wrap = false, loginBroken = false, compact = false }: {
  harness: PlanLimits['harness']; name: string; plan: string | undefined; limits: PlanLimits | null; now: number; lang: Lang
  /** The account's login is expired or signed out: whatever reading it has is stale, so no rings (0/0 would read as "unused"). */
  loginBroken?: boolean
  compact?: boolean
  note?: ReactNode; tag?: ReactNode
  /** The picker: name and plan WRAP (never an ellipsis on the one fact that tells rows apart), the tag on its own line. */
  wrap?: boolean
}) {
  const text = wrap
    ? { display: 'block', overflowWrap: 'anywhere' } as const
    : { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const
  // A reading of an account that cannot sign in is the last thing it said, not what it uses now.
  const limits = loginBroken ? null : reading
  const waiting = loginBroken ? (lang === 'pt' ? 'sem login' : 'signed out') : (lang === 'pt' ? 'sem leitura do plano' : 'no plan reading')
  return <>
    <HarnessMark harness={harness} size={20} />
    <div style={{ minWidth: 0 }}>
      <b style={{ ...text, fontSize: 13 }}>{name}</b>
      {wrap
        ? <>
          <span style={{ ...text, fontSize: 11.5, color: 'var(--text-tertiary)' }}>{plan ?? (lang === 'pt' ? 'plano não registrado' : 'plan not registered')}</span>
          {tag && <span style={{ display: 'flex', marginTop: 2 }}>{tag}</span>}
          {!limits && <span style={{ ...text, fontSize: 11.5, color: 'var(--text-secondary)' }}>{waiting}</span>}
        </>
        : <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>{tag}<span style={{ ...text, minWidth: 0, fontSize: 11.5, color: 'var(--text-tertiary)' }}>{plan ?? (lang === 'pt' ? 'plano não registrado' : 'plan not registered')}</span></span>}
      {note && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{note}</span>}
      {limits && <Unmeasured limits={limits} lang={lang} />}
    </div>
    {limits && compact ? <PlanUsageIndicator limits={limits} now={now} lang={lang} /> : limits ? limits.windows.map(w => <div key={windowKey(w)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}><PlanUsageRing pct={currentUsedPct(w, now)} size={36}>{Math.round(currentUsedPct(w, now))}</PlanUsageRing><span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{windowLabel(w.kind, lang, w.scope)}</span>{(() => { const reset = ringResetPhrase(w, now, lang); return reset ? <span data-plan-ring-reset style={{ fontSize: 9.5, lineHeight: 1.2, whiteSpace: 'nowrap', color: 'var(--text-tertiary)' }}>{reset}</span> : null })()}</div>) : wrap ? null : <span style={{ gridColumn: '3 / -1', fontSize: 11.5, color: 'var(--text-secondary)' }}>{waiting}</span>}
  </>
}

export function PlanUsageSummary({ limits, registered = [], accountLabels, now, lang, onOpen, embedded = false, agentUse, onRelogin }: {
  /** The popup's per-account controls: ONLY the agent-use switch and "Sign in again" (never the schedule). */
  agentUse?: ((harness: PlanLimits['harness'], account?: string) => { on: boolean; pending: boolean; onToggle: () => void; accountId: string; view?: AgentUseView; reloginable: boolean; loginBroken?: boolean } | undefined) & { loaded?: boolean; accounts?: readonly { harness: PlanLimits['harness']; id: string; label?: string }[] }
  onRelogin?: (r: { accountId: string; harness: PlanLimits['harness']; who: string }) => void
  onOpen?: () => void; limits: PlanLimits[] | null; registered?: RegisteredPlan[]; accountLabels?: Record<string, string>; now: number; lang: Lang; /** Inside a card that already carries the title: fill its width, no own title or inset. */ embedded?: boolean }) {
  const rows = subscriptionRows(limits, registered, accountLabels, agentUse?.accounts)
  const apis = useApiUsage().items ?? []
  const sectioned = apis.length > 0
  return <div data-plan-usage-summary style={{ width: '100%', boxSizing: 'border-box', padding: embedded ? 0 : 10, display: 'flex', flexDirection: 'column', gap: 4, ...(embedded ? {} : { minHeight: 0, flex: '1 1 auto' }) }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 8px', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--text-secondary)' }}>{!embedded && <>◉ <span id="plan-usage-summary-title">{lang === 'pt' ? 'Uso dos planos' : 'Plan usage'}</span></>}<span style={{ marginLeft: 'auto', fontWeight: 500, letterSpacing: 0 }}>{lang === 'pt' ? '% usado' : '% used'}</span></div>
    <PlanUsageScroll lang={lang} embedded={embedded}>
    {sectioned && <SectionTitle>{accountsSectionTitle(lang)}</SectionTitle>}
    {rows.map((row, i) => {
      const control = agentUse?.(row.harness, row.account)
      const who = subscriptionName(row.harness, row.accountLabel)
      return <div key={`${row.harness}:${i}`} data-plan-scroll-item style={{ borderTop: '1px solid var(--border)', padding: '8px 4px' }}>
        <div data-plan-row={row.harness} style={PLAN_ROW_GRID}>
          <PlanUsageRowCells compact harness={row.harness} name={who} plan={row.plan} limits={row.limits} now={now} lang={lang} loginBroken={control?.loginBroken === true} />
        </div>
        {!control && agentUse && agentUse.loaded === false && row.account && <div data-plan-row-controls-loading style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-tertiary)' }}>…</div>}
        {control && <div data-plan-row-controls={control.accountId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ToggleSwitch on={control.on} disabled={control.pending} onToggle={control.onToggle} label={`${lang === 'pt' ? 'Uso por agentes' : 'Agent use'} · ${who}`} />
            {lang === 'pt' ? 'Uso por agentes' : 'Agent use'}
          </span>
          {control.view && <AgentUseBadge view={control.view} lang={lang} />}
          {control.loginBroken && onRelogin && <button type="button" data-plan-row-relogin={control.accountId} onClick={() => onRelogin({ accountId: control.accountId, harness: row.harness, who })}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 8, padding: '3px 9px', fontSize: 11.5, cursor: 'pointer' }}>
            <KeyRound size={12} aria-hidden />{lang === 'pt' ? 'Refazer login' : 'Sign in again'}
          </button>}
        </div>}
      </div>
    })}
    {sectioned && <><SectionTitle>{apiSectionTitle(lang)}</SectionTitle><ApiUsageRows items={apis} now={now} lang={lang} /></>}
    {rows.some(r => r.limits?.windows.some(w => currentUsedPct(w, now) >= 75)) && <div style={{ padding: '7px 4px', fontSize: 11.5, color: 'var(--text-secondary)' }}>{rows.flatMap(r => (r.limits?.windows ?? []).filter(w => currentUsedPct(w, now) >= 75).slice(0, 1).map(w => <span key={`${r.harness}:${windowKey(w)}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><LimitLevelIcon pct={currentUsedPct(w, now)} lang={lang} />{HARNESS_LABELS[r.harness]}: {windowLabel(w.kind, lang, w.scope)} {lang === 'pt' ? 'em' : 'at'} {Math.round(currentUsedPct(w, now))}% · {lang === 'pt' ? 'renova' : 'resets'} {fmtWhen(w.resetsAt, now, lang)}</span>))}</div>}
    </PlanUsageScroll>
    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 4px 4px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>{lang === 'pt' ? 'Clique para ver tudo' : 'Click to see everything'} <button type="button" data-plan-usage-open onClick={onOpen} style={{ float: 'right', border: 0, background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: 'var(--anthropic-orange)', cursor: 'pointer' }}>{lang === 'pt' ? 'Abrir ›' : 'Open ›'}</button></div>
  </div>
}

/** One window as a ring + words. Shared by the detailed card (48px) and the composer block (34px). */
function WindowRow({ w, now, observedAt, lang, ring, forecast = true }: { w: PlanLimitWindow; now: number; observedAt: number; lang: Lang; ring: number; forecast?: boolean }) {
  const pt = lang === 'pt'
  const pct = currentUsedPct(w, now)
  const renewed = windowRenewed(w, now)
  const f = forecast ? warnForecast(w, now, observedAt) : null
  return <div data-plan-window={windowKey(w)} style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
    <PlanUsageRing pct={pct} size={ring}>{renewed ? '–' : ring >= 44 ? `${Math.round(pct)}%` : Math.round(pct)}</PlanUsageRing>
    <div style={{ minWidth: 0, flex: 1, fontSize: 12, lineHeight: 1.5 }}>
      <b style={{ display: 'block', whiteSpace: 'normal', overflowWrap: 'normal' }}>{windowLabel(w.kind, lang, w.scope)}</b>
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 5, color: 'var(--text-secondary)' }}>
        {!renewed && <span style={{ whiteSpace: 'nowrap' }}>{pt ? `restam ${Math.max(0, 100 - Math.round(pct))}%` : `${Math.max(0, 100 - Math.round(pct))}% left`} ·</span>}
        {windowResetPhrase(w, now, lang).split(/ (\((?:em|in) .+\))$/).filter(Boolean).map((part, i) => <span key={i} style={{ whiteSpace: renewed ? 'normal' : 'nowrap' }}>{part}</span>)}
      </div>
      {forecast && <span data-plan-forecast-slot style={{ display: 'block', minHeight: '1.5em', color: LIMIT_WARN, fontWeight: 600 }}>{f ? forecastPhrase(f, now, lang) : null}</span>}
    </div>
    <LimitLevelIcon pct={pct} lang={lang} />
  </div>
}

/** The composer's "Plano" block body: THIS session's harness only — rings, never bars. */
export function PlanSessionBlock({ limits, now, lang }: { limits: PlanLimits; now: number; lang: Lang }) {
  const stale = stalePhrase(limits, now, lang)
  return <div data-plan-limits={limits.harness} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    <Unmeasured limits={limits} lang={lang} />
    {limits.windows.map(w => <WindowRow key={windowKey(w)} w={w} now={now} observedAt={limits.updatedAt} lang={lang} ring={34} />)}
    <div style={{ fontSize: 10.5, color: stale ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }}>{updatedPhrase(limits, now, lang)} · {lang === 'pt' ? 'fonte' : 'source'}: {SOURCE_LABEL[limits.source][lang]}</div>
  </div>
}

/**
 * The DETAILED card (Nay's Limits tab, mobile panel). `limits: null` is a registered plan that has
 * reported nothing yet: named, state "no plan reading", NO ring and no zero.
 */
export function PlanUsageCard({ limits, pending, accountLabel, now, lang, embedded = false, showPlan = true, agentUse, isMobile = false }: { isMobile?: boolean; agentUse?: { on: boolean; pending: boolean; onToggle: () => void; accountId?: string; schedule?: AgentSchedule; view?: AgentUseView; applyAccount?: (account: unknown) => void }; showPlan?: boolean; embedded?: boolean; accountLabel?: string; limits: PlanLimits | null; pending?: { harness: PlanLimits['harness']; plan: string }; now: number; lang: Lang }) {
  const pt = lang === 'pt'
  const harness = limits?.harness ?? pending!.harness
  const plan = limits ? (limits.plan ?? limits.sourcePlan) : pending?.plan
  const worst = limits?.windows.length ? Math.max(...limits.windows.map(w => currentUsedPct(w, now)), 0) : null
  const early = limits?.windows.some(w => warnForecast(w, now, limits.updatedAt) !== null) ?? false
  const level = early && limitLevel(worst) === 'ok' ? 'attention' : limitLevel(worst)
  const state = limits?.unmeasuredReason ? (pt ? 'sem medição' : 'unknown') : limits ? limitLevelWord(level, lang, worst) : (pt ? 'sem leitura do plano' : 'no plan reading')
  const stale = limits ? stalePhrase(limits, now, lang) : null
  return <div data-plan-usage-card={harness} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, padding: embedded ? 0 : 12, borderRadius: 12, background: 'var(--bg-card)', border: embedded ? undefined : '1px solid var(--border)' }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <HarnessMark harness={harness} size={24} />
      <div style={{ minWidth: 0, flex: '1 1 140px', overflowWrap: 'anywhere' }}><b style={{ display: 'block', fontSize: 14 }}>{subscriptionName(harness, accountLabel)}</b>{showPlan && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{plan ?? (pt ? 'plano não registrado' : 'plan not registered')}</span>}</div>
      <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, maxWidth: '100%' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap', color: !limits || limits.unmeasuredReason ? 'var(--text-tertiary)' : level === 'critical' ? 'var(--accent-red)' : level === 'attention' ? 'var(--anthropic-orange)' : 'var(--accent-green)' }}><LimitLevelIcon pct={worst} level={level} size={14} lang={lang} />{state}</span>
        {agentUse && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {pt ? 'Uso por agentes' : 'Agent use'}
          <ToggleSwitch on={agentUse.on} disabled={agentUse.pending} onToggle={agentUse.onToggle} tap={isMobile ? 44 : undefined}
            label={`${pt ? 'Uso por agentes' : 'Agent use'} · ${subscriptionName(harness, accountLabel)}`} />
        </span>}
      </div>
    </div>
    {agentUse?.view
      ? <AgentUseBadge view={agentUse.view} lang={lang} />
      : agentUse && !agentUse.on && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{pt ? 'Agentes não usam esta conta' : "Agents won't use this account"}</span>}
    {agentUse?.accountId && <AgentScheduleSection control={{ ...agentUse, accountId: agentUse.accountId }} who={subscriptionName(harness, accountLabel)} lang={lang} isMobile={isMobile} />}
    {limits && <Unmeasured limits={limits} lang={lang} />}
    {limits && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{limits.windows.map(w => <div key={windowKey(w)} style={{ padding: 10, borderRadius: 10, background: 'var(--ag-tint-2)' }}><WindowRow w={w} now={now} observedAt={limits.updatedAt} lang={lang} ring={48} /></div>)}</div>}
    <span style={{ minHeight: 14, fontSize: 11, color: stale ? LIMIT_WARN : 'var(--text-tertiary)' }}>{limits ? updatedPhrase(limits, now, lang) : null}</span>
  </div>
}

/** The card's "Agenda" disclosure: closed by default, the editor inside. */
function AgentScheduleSection({ control, who, lang, isMobile }: { control: { accountId: string; schedule?: AgentSchedule; view?: AgentUseView; applyAccount?: (account: unknown) => void }; who: string; lang: Lang; isMobile: boolean }) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const active = !!control.schedule?.enabled
  const summary = scheduleSummaryText(control.schedule, lang)
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    <button type="button" aria-expanded={open} data-agent-schedule-toggle onClick={() => setOpen(o => !o)}
      style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer', minHeight: isMobile ? 44 : undefined }}>
      <CalendarClock size={13} aria-hidden />{pt ? 'Agenda' : 'Schedule'}{active ? (pt ? ' · ligada' : ' · on') : ''}{active && !open && summary ? <span data-agent-schedule-summary style={{ fontWeight: 400, color: 'var(--text-tertiary)' }}> · {summary}</span> : null}{open ? ' ▴' : ' ▾'}
    </button>
    {open && <div style={{ padding: 10, borderRadius: 10, background: 'var(--ag-tint-2)', minWidth: 0 }}>
      <AgentScheduleEditor accountId={control.accountId} who={who} schedule={control.schedule} view={control.view} lang={lang} isMobile={isMobile} onSaved={control.applyAccount} showBadge={false} />
    </div>}
  </div>
}

export function PlanLimitMeter({ window: w, now, observedAt = now, lang, forecast = false }: {
  window: PlanLimitWindow
  now: number
  observedAt?: number
  lang: Lang
  /** Add the average-at-reading exhaustion forecast under the bar (the new-session cards). */
  forecast?: boolean
}) {
  const pct = currentUsedPct(w, now)
  const shown = Math.round(pct)
  // A window that renewed since the last reading has no figure of its own yet: said, not zeroed.
  const renewed = windowRenewed(w, now)
  const tone = limitTone(pct)
  // The forecast is said ONLY when the window runs out before it renews — in amber, never green.
  const f = forecast ? warnForecast(w, now, observedAt) : null
  const label = windowLabel(w.kind, lang, w.scope)
  return (
    <div data-plan-window={windowKey(w)} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
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
        {windowResetPhrase(w, now, lang)}
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
      {limits.windows.map(w => <PlanLimitMeter key={windowKey(w)} window={w} now={now} observedAt={limits.updatedAt} lang={lang} forecast={forecast} />)}
      <Unmeasured limits={limits} lang={lang} />
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
    // Scoped records hold one window per model group: the arc shows the tightest.
    const w = limits.windows.filter(x => x.kind === kind).sort((a, b) => currentUsedPct(b, now) - currentUsedPct(a, now))[0]
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
export function PlanLimitBars({ limits, now, lang, labelWidth }: { limits: PlanLimits; now: number; lang: Lang; labelWidth?: string }) {
  const warn = limits.windows.map(w => warnForecast(w, now, limits.updatedAt)).find(Boolean) ?? null
  return (
    <div data-plan-limits={limits.harness} data-plan-compact style={{ display: 'grid', gridTemplateColumns: `${labelWidth ?? 'auto'} minmax(16px, 1fr) auto`, alignItems: 'center', columnGap: 6, rowGap: 3, fontSize: 10.5, minWidth: 0 }}>
      {limits.windows.map(w => {
        const pct = currentUsedPct(w, now)
        const renewed = windowRenewed(w, now)
        const label = windowShort(w.kind, lang, w.scope)
        return [
          <span key={`${windowKey(w)}l`} style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{label}</span>,
          <div key={`${windowKey(w)}b`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
            aria-label={`${windowLabel(w.kind, lang, w.scope)}: ${Math.round(pct)}%`}
            style={{ height: 3, minWidth: 16, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: limitTone(pct), borderRadius: 2 }} />
          </div>,
          <span key={`${windowKey(w)}v`} data-plan-window={windowKey(w)} style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {renewed ? '–' : `${Math.round(pct)}% · ${shortWhen(w.resetsAt, now, lang, w.kind)}`}
          </span>,
          ...(renewed ? [<span key={`${windowKey(w)}reset`} data-plan-renewal style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', whiteSpace: 'normal', overflowWrap: 'normal', lineHeight: 1.4 }}>
            {windowResetPhrase(w, now, lang)}
          </span>] : []),
        ]
      })}
      {warn && (
        <span data-plan-forecast style={{ gridColumn: '1 / -1', color: LIMIT_WARN, fontWeight: 600, whiteSpace: 'normal', overflowWrap: 'normal' }}>
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
