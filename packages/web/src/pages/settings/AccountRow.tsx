/**
 * AccountRow — Settings → Billing's one list: a row per account (or per assistant that cannot say
 * which account is signed in), each saying ONCE who it is, what plan it pays, how much of its limits
 * it has used and whether agents may use it. The row's button is the only way into the editor.
 * Presentational: BillingSettings owns the data.
 *
 * Reuses the app's pieces only: RecordCard, Toggle, Pill, PlanLimitBars, HarnessMark, dialogButtonStyle.
 */
import React from 'react'
import type { BillingMode, PlanLimits } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PlanLimitBars } from '../../components/PlanLimitMeter'
import { Pill } from '../../components/Pill'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { RecordCard, RecordCardAction, Toggle, dialogButtonStyle } from './primitives'
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
  problem: pt ? 'Períodos com problema' : 'Periods need fixing',
  noMeter: pt ? 'Não informado' : 'Not reported',
  noMeterYet: pt ? 'Sem leitura ainda' : 'No reading yet',
  saveFailed: (n: string) => (pt ? `Não foi possível salvar a conta “${n}”. Tente de novo.` : `Could not save the account “${n}”. Try again.`),
})

/** A row as drawn: the pure row plus what the page resolved for it. */
export interface BillingRowView extends BillingRow {
  /** The plan in force today, or `null` when nothing prices this row. */
  plan: { name: string; price: string | null; mode: BillingMode } | null
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
  /** The row whose editor is open, so it reads as selected. */
  selectedKey: string | null
  onToggle: (a: BillingAccount) => void
  onEdit: (row: BillingRowView) => void
}

const GRID = 'minmax(100px,1.3fr) minmax(95px,.8fr) minmax(190px,1.8fr) 54px 90px'
const nowrap: React.CSSProperties = { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

function PlanCell({ r, t }: { r: BillingRowView; t: ReturnType<typeof T> }) {
  if (r.problem) return <span style={{ justifySelf: 'start' }}><Pill tone="error" nowrap>{t.problem}</Pill></span>
  if (!r.plan) return <span style={{ justifySelf: 'start' }}><Pill tone="warn" nowrap>{t.noPlan}</Pill></span>
  return (
    <div style={{ minWidth: 0 }}>
      <span style={{ ...nowrap, fontSize: 12.5, color: 'var(--text-primary)' }}>{r.plan.name}</span>
      {r.plan.price && <span style={{ ...nowrap, fontSize: 11.5, color: 'var(--text-tertiary)' }}>{r.plan.price}</span>}
    </div>
  )
}

function Usage({ r, now, lang, t }: { r: BillingRowView; now: number; lang: Lang; t: ReturnType<typeof T> }) {
  if (r.limits) return <div data-billing-usage style={{ minWidth: 0, overflowWrap: 'normal' }}><PlanLimitBars limits={r.limits} now={now} lang={lang} /></div>
  return <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{REPORTS_LIMITS.has(r.harness) ? t.noMeterYet : t.noMeter}</span>
}

const actionLabel = (r: BillingRowView, t: ReturnType<typeof T>) => (r.problem ? t.review : r.plan ? t.edit : t.setPlan)

export function BillingAccountList(p: BillingAccountListProps) {
  const pt = p.lang === 'pt'
  const t = T(pt)
  const isMobile = useIsMobile()
  const toggle = (r: BillingRowView) => r.account && (
    <Toggle on={r.account.available} disabled={p.pendingIds.has(r.account.id)} label={`${t.agents} · ${r.title}`}
      onToggle={() => r.account && p.onToggle(r.account)} />
  )
  const failed = (r: BillingRowView) => r.account && p.failedIds.has(r.account.id) && (
    <p role="alert" style={{ gridColumn: '1 / -1', margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{t.saveFailed(r.title)}</p>
  )
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 10px' }}>{planCoverageText(p.rows, p.lang)}</div>
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {p.rows.map(r => (
            <div key={r.key} data-billing-row={r.key}>
              <RecordCard
                leading={<HarnessMark harness={r.harness} size={22} />}
                title={r.title}
                subtitle={r.sub}
                fields={[
                  { label: t.plan, value: r.problem || !r.plan ? <PlanCell r={r} t={t} /> : `${r.plan.name}${r.plan.price ? ` · ${r.plan.price}` : ''}` },
                  { label: t.usage, value: <Usage r={r} now={p.now} lang={p.lang} t={t} /> },
                  ...(r.account ? [{ label: t.agents, value: <span style={{ display: 'inline-flex' }}>{toggle(r)}</span> }] : []),
                ]}
                actions={<RecordCardAction label={`${actionLabel(r, t)} · ${r.title}`} onClick={() => p.onEdit(r)}>{actionLabel(r, t)}</RecordCardAction>}
              />
              {failed(r)}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 14, padding: '8px 14px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', background: 'var(--bg-elevated)' }}>
            <span>{t.account}</span><span>{t.plan}</span><span>{t.usage}</span><span>{t.agents}</span><span />
          </div>
          {p.rows.map(r => (
            <div key={r.key} data-billing-row={r.key} style={{
              display: 'grid', gridTemplateColumns: GRID, gap: 14, alignItems: 'center', padding: '12px 14px',
              borderTop: '1px solid var(--border)', background: p.selectedKey === r.key ? 'var(--bg-elevated)' : undefined,
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <HarnessMark harness={r.harness} size={22} />
                <span style={{ minWidth: 0 }}>
                  <b style={{ ...nowrap, fontSize: 13, color: 'var(--text-primary)' }}>{r.title}</b>
                  <span title={r.sub} style={{ ...nowrap, fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>{r.sub}</span>
                </span>
              </span>
              <PlanCell r={r} t={t} />
              <Usage r={r} now={p.now} lang={p.lang} t={t} />
              <span>{toggle(r)}</span>
              <button type="button" style={{ ...dialogButtonStyle(r.plan && !r.problem ? 'secondary' : 'primary', false), whiteSpace: 'nowrap', width: '100%' }}
                aria-label={`${actionLabel(r, t)} · ${r.title}`} onClick={() => p.onEdit(r)}>{actionLabel(r, t)}</button>
              {failed(r)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
