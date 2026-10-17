/**
 * AccountRow — Settings → Billing: one row per account (title, plan, limits, availability, "Edit
 * plan") and the first-detection notice. Presentational: BillingSettings owns the data.
 *
 * Reuses the app's pieces only: RowSwitch, Select, RecordCard, PlanLimitBars (the meter), Pill.
 */
import React, { useState } from 'react'
import { plansForHarness, type BillingSettings, type HarnessId, type PlanLimits } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PlanLimitBars } from '../../components/PlanLimitMeter'
import { Pill } from '../../components/Pill'
import { MetricNote } from '../../components/MetricNote'
import { RecordCard, RecordCardAction, RowSwitch, Select, dialogButtonStyle } from './primitives'
import { accountTitle, accountWhose } from './accountsSummary'
import { REPORTS_LIMITS, matchDetectedPlan, planSummary, type BillingAccount } from './accountBilling'

type Lang = 'pt' | 'en'

const T = (pt: boolean) => ({
  harnessPlan: pt ? 'Plano do assistente (padrão)' : 'Assistant plan (default)',
  noPlan: pt ? 'Plano não informado' : 'Plan not set',
  plan: pt ? 'Plano' : 'Plan',
  limits: pt ? 'Limites' : 'Limits',
  agents: pt ? 'Agentes' : 'Agents',
  edit: pt ? 'Editar plano' : 'Edit plan',
  editing: pt ? 'Editando' : 'Editing',
  hidden: pt ? 'Oculta dos agentes' : 'Hidden from agents',
  noMeter: pt ? 'Este assistente não informa seus limites de uso.' : 'This assistant does not report its usage limits.',
  noMeterYet: pt ? 'Sem leitura de limites ainda' : 'No limits reading yet',
  agy: pt ? 'O Antigravity mantém uma única conta.' : 'Antigravity keeps a single account.',
  saveFailed: (n: string) => (pt ? `Não foi possível salvar a conta “${n}”. Tente de novo.` : `Could not save the account “${n}”. Try again.`),
  noIdentity: pt
    ? 'Este assistente não informa qual conta está logada; use uma pasta por conta.'
    : 'This assistant does not report which account is signed in; use one folder per account.',
})

export interface AccountPlansProps {
  lang: Lang
  harness: HarnessId
  /** Every billable account of `harness`, oldest first. */
  accounts: BillingAccount[]
  billing: BillingSettings
  limits: PlanLimits[] | null
  now: number
  today: string
  pendingIds: ReadonlySet<string>
  failedIds: ReadonlySet<string>
  /** The account the period editor below targets; `null` = the assistant's default timeline. */
  selectedId: string | null
  onToggle: (a: BillingAccount) => void
  onEdit: (a: BillingAccount) => void
}

export function AccountPlanRow({ a, p }: { a: BillingAccount; p: AccountPlansProps }) {
  const pt = p.lang === 'pt'
  const t = T(pt)
  const isMobile = useIsMobile()
  const label = HARNESS_LABELS[a.harness] ?? a.harness
  const title = accountTitle(a, label, pt)
  const whose = accountWhose(a, pt)
  const sum = planSummary(p.billing, a, p.today)
  const planText = sum.name ? (sum.source === 'default' ? `${sum.name} · ${t.harnessPlan}` : sum.name) : t.noPlan
  const reading = p.limits?.find(l => l.account === a.id) ?? null
  const meter = reading
    ? <PlanLimitBars limits={reading} now={p.now} lang={p.lang} />
    : <span>{REPORTS_LIMITS.has(a.harness) ? t.noMeterYet : t.noMeter}</span>
  const busy = p.pendingIds.has(a.id)
  const selected = p.selectedId === a.id
  const hiddenBadge = !a.available ? <Pill tone="neutral" nowrap>{t.hidden}</Pill> : undefined
  return (
    <div data-billing-account={a.id}>
      {isMobile ? (
        <RecordCard
          title={title}
          subtitle={whose ?? undefined}
          badge={hiddenBadge}
          fields={[{ label: t.plan, value: planText }, { label: t.limits, value: meter }]}
          actions={<RecordCardAction label={`${t.edit} · ${title}`} onClick={() => p.onEdit(a)}>{selected ? `${t.editing}…` : t.edit}</RecordCardAction>}
        />
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1.2fr) minmax(0,1.2fr) auto', gap: 12, alignItems: 'center',
          padding: '12px 14px', borderTop: '1px solid var(--border)', background: selected ? 'var(--bg-elevated)' : undefined,
        }}>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 13, color: 'var(--text-primary)' }}>{title}</b> {hiddenBadge}
            {whose && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)' }}>{whose}</span>}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', minWidth: 0 }}>{planText}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0 }}>{meter}</div>
          <button type="button" style={dialogButtonStyle('secondary', false)} onClick={() => p.onEdit(a)}>{t.edit}</button>
        </div>
      )}
      <RowSwitch on={a.available} onToggle={() => p.onToggle(a)} disabled={busy} label={`${t.agents} · ${title}`} />
      {p.failedIds.has(a.id) && <p role="alert" style={{ margin: '0 14px 8px', fontSize: 12, color: 'var(--accent-red)' }}>{t.saveFailed(title)}</p>}
    </div>
  )
}

/** The accounts block for one harness: a row per account, plus the harness sentences. */
export function AccountPlans(p: AccountPlansProps) {
  const pt = p.lang === 'pt'
  const t = T(pt)
  if (p.accounts.length === 0) return null
  return (
    <div data-billing-accounts={p.harness} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden', marginBottom: 14 }}>
      {p.accounts.map(a => <AccountPlanRow key={a.id} a={a} p={p} />)}
      {!REPORTS_LIMITS.has(p.harness) && <div style={{ padding: '8px 14px' }}><MetricNote>{t.noMeter}</MetricNote></div>}
      {p.harness === 'antigravity' && <div style={{ padding: '8px 14px' }}><MetricNote>{t.agy}</MetricNote></div>}
    </div>
  )
}

/** "New <Harness> account detected. Which plan is it?" — answered once, dismissible. */
export function FirstDetectionNotice({ lang, account, onAnswer, onDismiss }: {
  lang: Lang
  account: BillingAccount
  /** `planId` null never happens here; dismissal is its own callback. */
  onAnswer: (a: BillingAccount, planId: string) => void
  onDismiss: (a: BillingAccount) => void
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const harnessLabel = HARNESS_LABELS[account.harness] ?? account.harness
  const title = accountTitle(account, harnessLabel, pt)
  const [planId, setPlanId] = useState(() => matchDetectedPlan(account.harness, account.plan))
  const options = plansForHarness(account.harness).map(e => ({
    value: e.id, label: e.label,
    hint: e.monthly ? `${e.monthly.currency} ${e.monthly.amount}/${pt ? 'mês' : 'mo'}` : (pt ? 'sem valor publicado' : 'no published price'),
  }))
  return (
    <div role="status" data-billing-notice={account.id} style={{
      border: '1px solid var(--accent-orange, var(--border))', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)',
      padding: '12px 14px', marginBottom: 12,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
        {pt ? `Nova conta do ${harnessLabel} detectada (${title}). Qual é o plano?` : `New ${harnessLabel} account detected (${title}). Which plan is it?`}
      </div>
      <Select value={planId} onChange={setPlanId} options={options} searchable
        placeholder={pt ? 'Escolha um plano' : 'Choose a plan'} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexDirection: isMobile ? 'column' : 'row' }}>
        <button type="button" disabled={!planId} style={dialogButtonStyle('primary', isMobile)} onClick={() => planId && onAnswer(account, planId)}>
          {pt ? 'Confirmar plano' : 'Confirm plan'}
        </button>
        <button type="button" style={dialogButtonStyle('secondary', isMobile)} onClick={() => onDismiss(account)}>
          {pt ? 'Não sei agora' : 'Not sure yet'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8, lineHeight: 1.5 }}>
        {pt ? 'Sem resposta, esta conta fica sem custo de plano (N/D), nunca zero.' : 'Without an answer this account has no plan cost (N/A), never zero.'}
      </div>
    </div>
  )
}
