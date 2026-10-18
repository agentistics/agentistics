/**
 * AccountRow — Settings → Billing: one row per account (title, plan, limits, availability, "Edit
 * plan") and the first-detection notice. Presentational: BillingSettings owns the data.
 *
 * Reuses the app's pieces only: RowSwitch, Select, RecordCard, PlanLimitBars (the meter), Pill.
 */
import React, { useState } from 'react'
// @harness-adapters-only: accounts exist per ADAPTER harness (a login to a vendor's CLI)
import { HARNESS_ORDER, plansForHarness, type BillingSettings, type HarnessId, type PlanLimits } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PlanLimitBars } from '../../components/PlanLimitMeter'
import { Pill } from '../../components/Pill'
import { MetricNote } from '../../components/MetricNote'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { Disclosure } from '../../components/Disclosure'
import { RecordCard, RecordCardAction, RowSwitch, ScopeNote, Select, dialogButtonStyle } from './primitives'
import { accountTitle, accountWhose, isPlaceholderName, summarizeHarnesses } from './accountsSummary'
import { REPORTS_LIMITS, capabilityNotes, matchDetectedPlan, planSummary, type BillingAccount } from './accountBilling'

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
  accounts: (n: number) => (pt ? `${n} ${n === 1 ? 'conta' : 'contas'}` : `${n} ${n === 1 ? 'account' : 'accounts'}`),
  withPlan: (n: number, total: number) => (pt ? `${n} de ${total} com plano` : `${n} of ${total} with a plan`),
  noMeterShort: pt ? 'Sem limites de uso informados' : 'No usage limits reported',
  searchPlans: pt ? 'Buscar plano…' : 'Search plans…',
  saving: pt ? 'Salvando…' : 'Saving…',
  noticeFailed: pt ? 'Não foi possível salvar a resposta. Tente de novo.' : 'Could not save the answer. Try again.',
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
  /** Inside a Disclosure panel: no frame of its own. */
  bare?: boolean
}

export function AccountPlanRow({ a, p }: { a: BillingAccount; p: AccountPlansProps }) {
  const pt = p.lang === 'pt'
  const t = T(pt)
  const isMobile = useIsMobile()
  const label = HARNESS_LABELS[a.harness] ?? a.harness
  const title = accountTitle(a, label, pt)
  // The e-mail is never drawn beside a nickname: the nickname IS the name, on every surface.
  const whose = a.nickname && !isPlaceholderName(a.nickname) ? null : accountWhose(a, pt)
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
      <div style={{ padding: '0 12px' }}><RowSwitch on={a.available} onToggle={() => p.onToggle(a)} disabled={busy} label={`${t.agents} · ${title}`} /></div>
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
    <div data-billing-accounts={p.harness} style={p.bare ? undefined : { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden', marginBottom: 14 }}>
      {p.accounts.map(a => <AccountPlanRow key={a.id} a={a} p={p} />)}
      {capabilityNotes(p.harness).map(n => (
        <div key={n} style={{ padding: '8px 14px' }}>
          <MetricNote>{n === 'noMeter' ? t.noMeter : n === 'noIdentity' ? t.noIdentity : t.agy}</MetricNote>
        </div>
      ))}
    </div>
  )
}

export interface BillingAccountsViewProps extends Omit<AccountPlansProps, 'harness' | 'accounts'> {
  /** Every billable account of every harness in scope. */
  accounts: BillingAccount[]
  harnesses: readonly HarnessId[]
  /** The assistant whose rows are open (one at a time); `null` = all collapsed. */
  openHarness: HarnessId | null
  onOpen: (h: HarnessId | null) => void
}

const viewGrid = (isMobile: boolean): React.CSSProperties => isMobile
  ? { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }
  : { display: 'grid', gridTemplateColumns: '20px minmax(0,1.5fr) minmax(0,1.3fr) 170px', gap: 12, alignItems: 'center' }

/**
 * Settings → Billing, per assistant: the SAME collapsed rows Settings → Accounts draws (shared
 * Disclosure, one open at a time, the worst limit bars from `summarizeHarnesses`), whose panel holds
 * that assistant's account rows. An assistant with no billable account has no row.
 */
export function BillingAccountsView(p: BillingAccountsViewProps) {
  const pt = p.lang === 'pt'
  const t = T(pt)
  const isMobile = useIsMobile()
  const order = HARNESS_ORDER.filter(h => p.harnesses.includes(h)) // @harness-adapters-only: accounts are a per-adapter fact
  const summaries = summarizeHarnesses(p.accounts, p.limits, p.now, order)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden', marginBottom: 14 }}>
      {summaries.map(s => {
        const label = HARNESS_LABELS[s.harness] ?? s.harness
        const mine = p.accounts.filter(a => a.harness === s.harness)
        const priced = mine.filter(a => planSummary(p.billing, a, p.today).source !== 'none').length
        const open = p.openHarness === s.harness
        return (
          <div key={s.harness} data-billing-harness={s.harness} style={{ borderTop: '1px solid var(--border)' }}>
            <Disclosure
              open={open}
              onToggle={() => p.onOpen(open ? null : s.harness)}
              panelId={`billing-panel-${s.harness}`}
              panelLabel={label}
              keepMounted
              buttonStyle={{ ...viewGrid(isMobile), fontFamily: 'inherit' }}
              panelStyle={{ background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)' }}
              header={chevron => (
                <>
                  {!isMobile && chevron}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    {isMobile && chevron}
                    <HarnessMark harness={s.harness} size={24} />
                    <span style={{ minWidth: 0 }}>
                      <b style={{ display: 'block', fontSize: 13.5, color: 'var(--text-primary)' }}>{label}</b>
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t.accounts(s.total)}</span>
                    </span>
                  </span>
                  <div style={{ minWidth: 0, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                    {s.worst ? <PlanLimitBars limits={s.worst} now={p.now} lang={p.lang} /> : t.noMeterShort}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{t.withPlan(priced, mine.length)}</div>
                </>
              )}
            >
              <AccountPlans {...p} harness={s.harness} accounts={mine} bare />
            </Disclosure>
          </div>
        )
      })}
    </div>
  )
}

/** "New <Harness> account detected. Which plan is it?" — stays until the answer is STORED. */
export function FirstDetectionNotice({ lang, account, onAnswer, onDismiss, status }: {
  lang: Lang
  account: BillingAccount
  /** `planId` null never happens here; dismissal is its own callback. */
  onAnswer: (a: BillingAccount, planId: string) => void
  onDismiss: (a: BillingAccount) => void
  /** `saving` while a write is in flight; `failed` after one was refused — the buttons come back. */
  status?: 'saving' | 'failed'
}) {
  const pt = lang === 'pt'
  const t = T(pt)
  const isMobile = useIsMobile()
  const harnessLabel = HARNESS_LABELS[account.harness] ?? account.harness
  const title = accountTitle(account, harnessLabel, pt)
  const [planId, setPlanId] = useState(() => matchDetectedPlan(account.harness, account.plan))
  const busy = status === 'saving'
  const options = plansForHarness(account.harness).map(e => ({
    value: e.id, label: e.label,
    hint: e.monthly ? `${e.monthly.currency} ${e.monthly.amount}/${pt ? 'mês' : 'mo'}` : (pt ? 'sem valor publicado' : 'no published price'),
  }))
  return (
    <div role="status" data-billing-notice={account.id}>
      <ScopeNote>
        <span style={{ overflowWrap: 'anywhere' }}>
          {pt ? `Nova conta do ${harnessLabel} detectada (${title}). Qual é o plano?` : `New ${harnessLabel} account detected (${title}). Which plan is it?`}
        </span>
      </ScopeNote>
      <div style={{ margin: '-6px 0 12px' }}>
        <Select value={planId} onChange={setPlanId} options={options} searchable disabled={busy}
          placeholder={pt ? 'Escolha um plano' : 'Choose a plan'} searchPlaceholder={t.searchPlans} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexDirection: isMobile ? 'column' : 'row' }}>
          <button type="button" disabled={!planId || busy} style={dialogButtonStyle('primary', isMobile)} onClick={() => planId && onAnswer(account, planId)}>
            {busy ? t.saving : pt ? 'Confirmar plano' : 'Confirm plan'}
          </button>
          <button type="button" disabled={busy} style={dialogButtonStyle('secondary', isMobile)} onClick={() => onDismiss(account)}>
            {pt ? 'Não sei agora' : 'Not sure yet'}
          </button>
        </div>
        {status === 'failed' && <p role="alert" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--accent-red)' }}>{t.noticeFailed}</p>}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8, lineHeight: 1.5 }}>
          {pt ? 'Sem resposta, esta conta fica sem custo de plano (N/D), nunca zero.' : 'Without an answer this account has no plan cost (N/A), never zero.'}
        </div>
      </div>
    </div>
  )
}
