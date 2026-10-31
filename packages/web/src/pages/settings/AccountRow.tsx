/**
 * AccountRow — Usage → Accounts' one list: a row per account (or per assistant that cannot say
 * which account is signed in), each saying ONCE who it is, what plan it pays, how much of its limits
 * it has used and whether agents may use it. The row's button is the only way into the editor.
 * BillingSettings owns row data; the shared plan snapshot supplies the chart color identity set.
 *
 * Reuses the app's pieces only: Toggle, Pill, PlanUsageRing, HarnessMark, IconButton.
 */
import React from 'react'
import { KeyRound, Pencil, X } from 'lucide-react'
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
import { AUTH_COPY } from '../../lib/accountRelogin'
import { planCoverageText, REPORTS_LIMITS, type BillingAccount, type BillingRow } from './accountBilling'

type Lang = 'pt' | 'en'

const T = (pt: boolean) => ({
  account: pt ? 'Conta' : 'Account',
  plan: pt ? 'Plano' : 'Plan',
  usage: pt ? 'Uso' : 'Usage',
  agents: pt ? 'Agentes' : 'Agents',
  edit: pt ? 'Editar' : 'Edit',
  setPlan: pt ? 'Definir plano' : 'Set plan',
  confirm: pt ? 'Confirmar plano' : 'Confirm plan',
  review: pt ? 'Revisar' : 'Review',
  noPlan: pt ? 'Sem plano' : 'No plan',
  detected: (name: string) => (pt ? `Detectado: ${name} · confirme` : `Detected: ${name} · confirm`),
  starts: (day: string) => (pt ? `Plano começa em ${day}` : `Plan starts ${day}`),
  problem: pt ? 'Períodos com problema' : 'Periods need fixing',
  noMeter: pt ? 'Não informado' : 'Not reported',
  noQuotaOpencode: pt ? 'Sem cota de plano no OpenCode' : 'No plan quota for OpenCode',
  noMeterYet: pt ? 'Sem leitura ainda' : 'No reading yet',
  signedOut: pt ? 'Não conectado' : 'Not connected',
  signIn: pt ? 'Entre no assistente neste computador ou use “Adicionar conta” abaixo.' : 'Sign in to the assistant on this computer, or use “Add account” below.',
  notSignedIn: (name: string) => (pt ? `${name} instalado, sem login` : `${name} is installed, not signed in`),
  signInNow: pt ? 'Entrar' : 'Sign in',
  signingIn: pt ? 'Abrindo…' : 'Opening…',
  hideNotice: (name: string) => (pt ? `Ocultar o aviso do ${name}` : `Hide the ${name} notice`),
  saveFailed: (n: string) => (pt ? `Não foi possível salvar a conta “${n}”. Tente de novo.` : `Could not save the account “${n}”. Try again.`),
})

/** A row as drawn: the pure row plus what the page resolved for it. */
export interface BillingRowView extends BillingRow {
  /** The plan in force today, or `null` when nothing prices this row. */
  plan: { name: string; price: string | null; mode: BillingMode } | null
  /** With no plan in force, the day (`dd/MM/yyyy`) a registered plan starts — never "no plan" then. */
  starts?: string | null
  /** With nothing registered, the plan the assistant reported (or detection found) — not saved until confirmed. */
  detected?: string | null
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
  /** An assistant installed here with no login: its notice's "Sign in" (the install dialog's flow). */
  onSignIn?: (harness: BillingRowView['harness']) => void
  /** The assistant whose sign-in is being opened, so its button reads as busy. */
  signingIn?: string | null
  /** The sign-in's refusal, said under its notice. */
  signInError?: { harness: string; message: string } | null
  /** Assistants whose notice the person closed. */
  hiddenSignedOut?: ReadonlySet<string>
  onHideSignedOut?: (harness: BillingRowView['harness']) => void
  /** HOTFIX.LOGIN-EXPIRADO: "Sign in again" on a row whose account's login expired or is signed out. */
  onRelogin?: (row: BillingRowView) => void
}

const cellText: React.CSSProperties = { display: 'block', whiteSpace: 'normal', overflowWrap: 'break-word' }

/** The plan half of the muted line: the plan's name, or the state that stands in for one. */
function PlanCell({ r, t }: { r: BillingRowView; t: ReturnType<typeof T> }) {
  if (r.signedOut) return <Pill tone="neutral" nowrap>{t.signedOut}</Pill>
  if (r.problem) return <Pill tone="error" nowrap>{t.problem}</Pill>
  if (!r.plan && r.starts) return <Pill tone="neutral" nowrap>{t.starts(r.starts)}</Pill>
  if (!r.plan && r.detected) return <Pill tone="warn" nowrap>{t.detected(r.detected)}</Pill>
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
  // USO.CARREGANDO: why the plan-limits answer has not arrived, when the store knows (a refusal ends the wait).
  const { failure } = usePlanLimits()
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
  // Before the first answer EVERY row waits — an assistant row with no identified account included: saying
  // "No reading yet" then is a claim nobody could make yet. A refusal is final: "not reported" here.
  // OpenCode has no quota endpoint at all: a stated fact at any moment, not a "waiting" and not a percentage.
  if (r.harness === 'opencode') return <span data-no-quota style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t.noQuotaOpencode}</span>
  if (!ready && (failure === 'unauthorized' || failure === 'unavailable')) return <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t.noMeter}</span>
  if (!ready) return <span aria-busy="true" data-usage-waiting style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>…</span>
  return <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{REPORTS_LIMITS.has(r.harness) ? t.noMeterYet : t.noMeter}</span>
}

/** The row's account cannot work now (its login expired, or nothing holds it). */
export const loginOff = (r: BillingRowView): boolean => r.account?.login === 'expired' || r.account?.login === 'signed_out'

const actionLabel = (r: BillingRowView, t: ReturnType<typeof T>) => (r.problem ? t.review : r.plan || r.starts ? t.edit : r.detected ? t.confirm : t.setPlan)

/**
 * One compact ROW per account: harness mark + name, the assistant and plan muted under it, the two
 * usage rings, the agent-use switch and a pencil. At phone width the row wraps to two lines — who
 * on the first, the controls on the second — so nothing scrolls sideways.
 */
export function BillingAccountList(p: BillingAccountListProps) {
  const pt = p.lang === 'pt'
  const t = T(pt)
  const a = AUTH_COPY(pt)
  const isMobile = useIsMobile()
  const target = isMobile ? 44 : 32
  const { budgets, readings } = usePlanLimits()
  // Match the charts' full identity set before either surface filters or reorders accounts.
  const colors = usageColors([
    ...budgets.map(b => `${b.harness}:${b.account ?? 'default'}`),
    ...readings.map(r => `${r.harness}:${r.account}`),
  ])
  // A harness with no login here is not an account: a closable notice, outside the list and its count.
  const accountRows = p.rows.filter(r => !r.signedOut)
  const notices = p.rows.filter(r => r.signedOut && !p.hiddenSignedOut?.has(r.harness))
  return (
    <div>
      {notices.map(r => {
        const name = HARNESS_LABELS[r.harness] ?? r.harness
        const busy = p.signingIn === r.harness
        const err = p.signInError?.harness === r.harness ? p.signInError.message : null
        return (
          <div key={r.key} data-signed-out data-signed-out-notice={r.harness} role="status" style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: isMobile ? '8px 10px' : '6px 10px', margin: '0 0 10px',
            border: '1px dashed var(--border)', borderRadius: 'var(--radius-md, 8px)', fontSize: 12.5, color: 'var(--text-secondary)',
          }}>
            <HarnessMark harness={r.harness} size={18} />
            <span style={{ flex: '1 1 160px', minWidth: 0 }}>{t.notSignedIn(name)}</span>
            {p.onSignIn && (
              <button type="button" disabled={busy} onClick={() => p.onSignIn?.(r.harness)} style={{
                minHeight: target, padding: '0 12px', borderRadius: 'var(--radius-md, 8px)', border: '1px solid var(--anthropic-orange)',
                background: 'transparent', color: 'var(--anthropic-orange)', fontSize: 12.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
              }}>{busy ? t.signingIn : t.signInNow}</button>
            )}
            {p.onHideSignedOut && (
              <IconButton label={t.hideNotice(name)} size={target} onClick={() => p.onHideSignedOut?.(r.harness)} color="var(--text-tertiary)"><X size={14} /></IconButton>
            )}
            {err && <p role="alert" style={{ flexBasis: '100%', margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{err}</p>}
          </div>
        )
      })}
      {accountRows.length > 0 && <>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 10px' }}>{planCoverageText(accountRows, p.lang)}</div>
      <div role="list" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden', marginBottom: 14 }}>
        {accountRows.map((r, i) => (
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
                  {loginOff(r) && <> · <span data-account-login-state={r.account!.login}><Pill tone="error" nowrap>{r.account!.login === 'expired' ? a.rowExpired : a.rowSignedOut}</Pill></span></>}
                </span>
              </span>
            </span>
            {loginOff(r) && r.account!.relogin && p.onRelogin && (
              <button type="button" data-account-row-relogin onClick={() => p.onRelogin?.(r)} style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, order: isMobile ? 3 : undefined, flexBasis: isMobile ? '100%' : undefined, minHeight: target, padding: '0 12px', borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--anthropic-orange)', background: 'transparent', color: 'var(--anthropic-orange)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}><KeyRound size={14} aria-hidden />{a.relogin}</button>
            )}
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
      </>}
    </div>
  )
}
