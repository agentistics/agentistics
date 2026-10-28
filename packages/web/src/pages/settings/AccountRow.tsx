/**
 * AccountRow — Usage → Accounts' one list: a row per account (or per assistant that cannot say
 * which account is signed in), each saying ONCE who it is, what plan it pays, how much of its limits
 * it has used and whether agents may use it. The row's button is the only way into the editor.
 * BillingSettings owns row data; the shared plan snapshot supplies the chart color identity set.
 *
 * Reuses the app's pieces only: Toggle, Pill, PlanUsageRing, HarnessMark, IconButton.
 */
import React from 'react'
import { Pencil } from 'lucide-react'
import { windowKey, type BillingMode, type PlanLimitWindow, type PlanLimits } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PlanUsageRing } from '../../components/PlanLimitMeter'
import { Pill } from '../../components/Pill'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { IconButton } from '../../components/sessions/RepoSearchView'
import { HARNESS_LABELS } from '../../lib/harness'
import { currentUsedPct, resetPhrase, usePlanLimits, windowLabel, windowShort } from '../../lib/planLimits'
import { usageColors, USAGE_NO_READING_COLOR } from '../../lib/usageColors'
import { Toggle } from './primitives'
import { planCoverageText, REPORTS_LIMITS, type BillingAccount, type BillingRow } from './accountBilling'

type Lang = 'pt' | 'en'

const T = (pt: boolean) => ({
  account: pt ? 'Conta' : 'Account',
  plan: pt ? 'Plano' : 'Plan',
  usage: pt ? 'Uso' : 'Usage',
  agents: pt ? 'Agentes' : 'Agents',
  edit: pt ? 'Editar' : 'Edit',
  setPlan: pt ? 'Definir plano' : 'Set plan',
  review: pt ? 'Revisar' : 'Review',
  noPlan: pt ? 'Sem plano' : 'No plan',
  starts: (day: string) => (pt ? `Plano começa em ${day}` : `Plan starts ${day}`),
  problem: pt ? 'Períodos com problema' : 'Periods need fixing',
  noMeter: pt ? 'Não informado' : 'Not reported',
  noMeterYet: pt ? 'Sem leitura ainda' : 'No reading yet',
  signedOut: pt ? 'Não conectado' : 'Not connected',
  signIn: pt ? 'Entre no assistente neste computador ou use “Adicionar conta” abaixo.' : 'Sign in to the assistant on this computer, or use “Add account” below.',
  saveFailed: (n: string) => (pt ? `Não foi possível salvar a conta “${n}”. Tente de novo.` : `Could not save the account “${n}”. Try again.`),
})

/** A row as drawn: the pure row plus what the page resolved for it. */
export interface BillingRowView extends BillingRow {
  /** The plan in force today, or `null` when nothing prices this row. */
  plan: { name: string; price: string | null; mode: BillingMode } | null
  /** With no plan in force, the day (`dd/MM/yyyy`) a registered plan starts — never "no plan" then. */
  starts?: string | null
  /** Its timeline has overlapping or broken periods: it cannot be priced until they are fixed. */
  problem: boolean
  limits: PlanLimits | null
}

export interface BillingAccountListProps {
  lang: Lang
  rows: BillingRowView[]
  now: number
  pendingIds: ReadonlySet<string>
  failedIds: ReadonlySet<string>
  /** False until the first plan-limits answer: a row must not claim "not reported" before anybody was asked. */
  limitsReady?: boolean
  /** The row whose editor is open, so it reads as selected. */
  selectedKey: string | null
  onToggle: (a: BillingAccount) => void
  onEdit: (row: BillingRowView) => void
}

const cellText: React.CSSProperties = { display: 'block', whiteSpace: 'normal', overflowWrap: 'break-word' }

/** The plan half of the muted line: the plan's name, or the state that stands in for one. */
function PlanCell({ r, t }: { r: BillingRowView; t: ReturnType<typeof T> }) {
  if (r.signedOut) return <Pill tone="neutral" nowrap>{t.signedOut}</Pill>
  if (r.problem) return <Pill tone="error" nowrap>{t.problem}</Pill>
  if (!r.plan && r.starts) return <Pill tone="neutral" nowrap>{t.starts(r.starts)}</Pill>
  if (!r.plan) return <Pill tone="warn" nowrap>{t.noPlan}</Pill>
  return <span>{r.plan.name}{r.plan.price ? ` · ${r.plan.price}` : ''}</span>
}

/**
 * The two rings a row carries: the 5-hour and the weekly window (unscoped first — a model-scoped
 * weekly window is a third meter the editor shows in full). The renewal is the ring's tooltip.
 */
export function rowWindows(limits: PlanLimits): PlanLimitWindow[] {
  const plain = limits.windows.filter(w => !w.scope)
  const picked = (['5h', 'week'] as const).map(k => plain.find(w => w.kind === k)).filter((w): w is PlanLimitWindow => !!w)
  return picked.length ? picked : limits.windows.slice(0, 2)
}

function Usage({ r, now, lang, t, ready = true }: { r: BillingRowView; now: number; lang: Lang; t: ReturnType<typeof T>; ready?: boolean }) {
  if (r.signedOut) return <span data-signed-out style={{ fontSize: 11.5, color: 'var(--text-tertiary)', maxWidth: 260 }}>{t.signIn}</span>
  if (r.limits) return (
    <span data-billing-usage data-plan-limits={r.limits.harness} style={{ display: 'inline-flex', gap: 10 }}>
      {rowWindows(r.limits).map(w => {
        const pct = Math.round(currentUsedPct(w, now))
        const tip = `${windowLabel(w.kind, lang, w.scope)}: ${pct}% · ${resetPhrase(w, now, lang)}`
        return (
          <span key={windowKey(w)} title={tip} aria-label={tip} role="img" data-usage-ring={w.kind}
            style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <PlanUsageRing pct={pct} size={32}>{pct}</PlanUsageRing>
            <span aria-hidden style={{ fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{windowShort(w.kind, lang, w.scope)}</span>
          </span>
        )
      })}
    </span>
  )
  if (!ready && r.account) return <span aria-busy="true" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>…</span>
  return <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{REPORTS_LIMITS.has(r.harness) ? t.noMeterYet : t.noMeter}</span>
}

const actionLabel = (r: BillingRowView, t: ReturnType<typeof T>) => (r.problem ? t.review : r.plan || r.starts ? t.edit : t.setPlan)

/**
 * One compact ROW per account: harness mark + name, the assistant and plan muted under it, the two
 * usage rings, the agent-use switch and a pencil. At phone width the row wraps to two lines — who
 * on the first, the controls on the second — so nothing scrolls sideways.
 */
export function BillingAccountList(p: BillingAccountListProps) {
  const pt = p.lang === 'pt'
  const t = T(pt)
  const isMobile = useIsMobile()
  const target = isMobile ? 44 : 32
  const { budgets, readings } = usePlanLimits()
  // Match the charts' full identity set before either surface filters or reorders accounts.
  const colors = usageColors([
    ...budgets.map(b => `${b.harness}:${b.account ?? 'default'}`),
    ...readings.map(r => `${r.harness}:${r.account}`),
  ])
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 10px' }}>{planCoverageText(p.rows, p.lang)}</div>
      <div role="list" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden', marginBottom: 14 }}>
        {p.rows.map((r, i) => (
          <div role="listitem" key={r.key} data-billing-row={r.key} style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 8, padding: isMobile ? '10px 12px' : '8px 14px',
            borderTop: i ? '1px solid var(--border)' : undefined, background: p.selectedKey === r.key ? 'var(--bg-elevated)' : undefined,
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 220px' }}>
              <span aria-hidden="true" data-account-color={`${r.harness}:${r.account?.id || 'default'}`} style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: readings.some(a => a.harness === r.harness && a.account === (r.account?.id || 'default') && a.points.some(p => p.fiveHourPct != null || p.weekPct != null))
                  ? colors.get(`${r.harness}:${r.account?.id || 'default'}`) ?? USAGE_NO_READING_COLOR : USAGE_NO_READING_COLOR,
              }} />
              <HarnessMark harness={r.harness} size={22} />
              <span style={{ minWidth: 0 }} title={r.sub.replaceAll(' · ', '\n')}>
                <b style={{ ...cellText, fontSize: 13, color: 'var(--text-primary)' }}>{r.title}</b>
                <span data-billing-subtitle style={{ ...cellText, fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                  {HARNESS_LABELS[r.harness] ?? r.harness} · <PlanCell r={r} t={t} />
                </span>
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto', flexShrink: 0 }}>
              <Usage r={r} now={p.now} lang={p.lang} t={t} ready={p.limitsReady ?? true} />
              {r.account && (
                <Toggle on={r.account.available} disabled={p.pendingIds.has(r.key)} label={`${t.agents} · ${r.title}`}
                  targetSize={target} text={t.agents} onToggle={() => r.account && p.onToggle(r.account)} />
              )}
              <IconButton label={`${actionLabel(r, t)} · ${r.title}`} size={target} onClick={() => p.onEdit(r)}
                color={r.plan && !r.problem ? 'var(--text-secondary)' : 'var(--anthropic-orange)'}><Pencil size={15} /></IconButton>
            </span>
            {r.account && p.failedIds.has(r.key) && (
              <p role="alert" style={{ flexBasis: '100%', margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{t.saveFailed(r.title)}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
