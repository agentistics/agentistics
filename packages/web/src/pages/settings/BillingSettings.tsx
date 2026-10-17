/**
 * Settings → Billing: ONE list of accounts (who, plan, usage, agents) and ONE editor.
 *
 * Every account — or, for an assistant that cannot say who is signed in, the assistant itself — is
 * one row, and that row's button opens the only editor on the page: nickname, plan, price, dates and
 * the earlier plans. Each meter, login and plan name is drawn once. The row edits the timeline it
 * actually prices on (its own, or the assistant default it inherits — `rowScope`), so what the row
 * says and what the editor changes can never be two different plans.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Pencil, Trash2, AlertTriangle, Sparkles } from 'lucide-react'
import {
  findPlan,
  plansForHarness,
  sortPeriods,
  validateTimeline,
  type BillingDetection,
  type BillingPeriod,
  type BillingCurrency,
  type BillingSettings as BillingSettingsShape,
  type HarnessId,
  type PlanCatalogEntry,
  // @harness-adapters-only: plans are a subscription to a vendor's CLI, a per-adapter fact
  HARNESS_ORDER,
  isAdapterHarness,
} from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Drawer } from '../../components/Drawer'
import { DatePicker } from '../../components/DatePicker'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { Checkbox, ConfirmModal, FieldInput, SectionHeader, Select, TabSelect, dialogButtonStyle } from './primitives'
import {
  applyPlan,
  splitTimeline,
  modeLabel,
  currencySymbol,
  formatAmountDisplay,
  parseAmountInput,
  describeError,
  draftFromPeriod,
  draftWantsPrice,
  emptyDraft,
  periodFromDraft,
  periodName,
  validateDraft,
  type PeriodDraft,
} from './billingForm'
import { billingNotices, useNoticeSaveState } from '../../lib/billingNotices'
import { BillingAccountList, type BillingRowView } from './AccountRow'
import {
  accountsNeedingPlan, billingRows, closeBefore, matchDetectedPlan, saveErrorPlace, saveThenClose, scopePeriods, toggleAvailability,
  unknownPeriod, withScopePeriods, type BillingAccount, type SaveError,
} from './accountBilling'
import { createAccountMutator } from './accountMutations'
import { usePlanLimits } from '../../lib/planLimits'

/** The wire shape of `GET /api/billing/plan-prices`. Declared here rather than imported: the web
 *  bundle must never reach into `packages/server`. */
interface ScrapedPlanPrice {
  planId: string
  amount: number
  currency: BillingCurrency
  source: string
}

const newPeriodId = (): string =>
  `bp_${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-6)}`

/** `yyyy-MM-dd` for the date picker's max — nobody is billed for the future. */
const today = (): string => new Date().toISOString().slice(0, 10)
const dayOf = (ms: number | undefined): string => (ms && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : today())

const priceText = (p: BillingPeriod, pt: boolean): string | null =>
  p.price ? `${currencySymbol(p.price.currency)} ${formatAmountDisplay(String(p.price.amount), p.price.currency)}${pt ? '/mês' : '/mo'}` : null

export default function BillingSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const isMobile = useIsMobile()

  const { limits: planLimits, now: limitsNow } = usePlanLimits()
  const [accounts, setAccounts] = useState<BillingAccount[]>([])
  // The list arrived (a failed fetch never counts): only then may stale `failed` answers be pruned.
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [pendingIds, setPending] = useState<Set<string>>(new Set())
  const [failedIds, setFailed] = useState<Set<string>>(new Set())
  const mutator = useRef(createAccountMutator<BillingAccount>((id, body) =>
    fetch(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))).current
  useEffect(() => {
    let cancelled = false
    fetch('/api/accounts')
      .then(r => (r.ok ? r.json() : null))
      .then((b: { accounts?: BillingAccount[] } | null) => {
        if (cancelled) return
        setAccounts(b?.accounts ?? [])
        if (b) setAccountsLoaded(true)
      })
      .catch(() => { /* the assistants' own timelines still work without the list */ })
    return () => { cancelled = true }
  }, [])

  // Plans are an ADAPTER fact (a subscription to a vendor's CLI): the native harness has none. An
  // assistant is listed when it has sessions here or a signed-in account.
  const harnesses: HarnessId[] = useMemo(() => {
    const present = new Set<HarnessId>([...(ctx.data.harnesses ?? []).filter(isAdapterHarness), ...accounts.map(a => a.harness)])
    if (present.size === 0) present.add('claude')
    return HARNESS_ORDER.filter(h => present.has(h)) // @harness-adapters-only: plans are a per-adapter fact
  }, [ctx.data.harnesses, accounts])

  const needPlan = useMemo(() => accountsNeedingPlan(accounts, ctx.billing, harnesses), [accounts, ctx.billing, harnesses])
  const noticeState = useNoticeSaveState()
  useEffect(() => {
    if (accountsLoaded) billingNotices.prune(new Set(needPlan.map(a => a.id)))
  }, [accountsLoaded, needPlan])

  const rows: BillingRowView[] = useMemo(() => billingRows(accounts, ctx.billing, harnesses, h => HARNESS_LABELS[h] ?? h, pt).map(r => {
    const periods = scopePeriods(ctx.billing, r.scope)
    const cur = splitTimeline(sortPeriods(periods), today()).current
    return {
      ...r,
      plan: cur ? { name: periodName(cur) || modeLabel(cur.mode, pt ? 'pt' : 'en'), price: priceText(cur, pt) } : null,
      problem: validateTimeline({ periods }).size > 0,
      limits: r.account ? planLimits?.find(l => l.account === r.account!.id) ?? null : null,
    }
  }), [accounts, ctx.billing, harnesses, pt, planLimits])

  const toggleAccount = async (a: BillingAccount) => {
    if (mutator.has(a.id)) return
    setPending(h => new Set(h).add(a.id))
    const res = await toggleAvailability(mutator, a)
    setPending(h => { const n = new Set(h); n.delete(a.id); return n })
    if (res.status === 'ok') {
      setAccounts(h => h.map(x => x.id === a.id ? { ...x, ...res.account } : x))
      setFailed(h => { const n = new Set(h); n.delete(a.id); return n })
    } else if (res.status === 'failed') setFailed(h => new Set(h).add(a.id))
  }

  // ── the one editor ──────────────────────────────────────────────────────────────────────────
  const [editKey, setEditKey] = useState<string | null>(null)
  const row = editKey ? rows.find(r => r.key === editKey) ?? null : null
  const periods = useMemo(() => (row ? sortPeriods(scopePeriods(ctx.billing, row.scope)) : []), [row, ctx.billing])
  const { current, history } = useMemo(() => splitTimeline(periods, today()), [periods])
  const timelineErrors = useMemo(() => validateTimeline({ periods }), [periods])

  const [draft, setDraft] = useState<PeriodDraft | null>(null)
  // What the drawer opened WITH, so "unsaved changes" means changes — not merely "a drawer is open".
  const [origin, setOrigin] = useState('')
  const [nick, setNick] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [saveError, setSaveError] = useState<SaveError | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BillingPeriod | null>(null)
  const [detections, setDetections] = useState<BillingDetection[]>([])
  const [planPrices, setPlanPrices] = useState<ScrapedPlanPrice[]>([])
  /**
   * "I changed plan", folded into the plan picker: choosing ANOTHER plan while the one in force is
   * open starts a new period today and, on save, closes the old one the day before — the seam is
   * exact by construction, so a plan change can leave neither a gap nor an overlap.
   */
  const [changingFrom, setChangingFrom] = useState<BillingPeriod | null>(null)
  const [seededFrom, setSeededFrom] = useState<string | null>(null)

  // Live vendor prices: best-effort; nothing simply means the built-in catalog stands.
  useEffect(() => {
    let cancelled = false
    fetch('/api/billing/plan-prices')
      .then(r => (r.ok ? r.json() : null))
      .then((body: { prices?: ScrapedPlanPrice[] } | null) => { if (!cancelled) setPlanPrices(body?.prices ?? []) })
      .catch(() => { /* the catalog is the floor */ })
    return () => { cancelled = true }
  }, [])
  // Detection only pre-selects a plan in the editor. A failure is silent: everything works by hand.
  useEffect(() => {
    let cancelled = false
    fetch('/api/billing/detect')
      .then(r => (r.ok ? r.json() : null))
      .then((body: { detections?: BillingDetection[] } | null) => { if (!cancelled) setDetections(body?.detections ?? []) })
      .catch(() => { /* by hand */ })
    return () => { cancelled = true }
  }, [])

  const livePrice = useCallback((planId: string) => planPrices.find(p => p.planId === planId) ?? null, [planPrices])
  /** A catalog entry with today's vendor price in place of the compiled-in one, when one was read. */
  const withLive = useCallback((entry: PlanCatalogEntry): PlanCatalogEntry => {
    const live = livePrice(entry.id)
    return live ? { ...entry, monthly: { amount: live.amount, currency: live.currency, verifiedAt: today(), source: live.source } } : entry
  }, [livePrice])

  const openDraft = (next: PeriodDraft, nickname: string) => {
    setDraft(next)
    setNick(nickname)
    setOrigin(JSON.stringify([next, nickname]))
    setShowErrors(false)
    setSaveError(null)
    setChangingFrom(null)
  }
  const openRow = (r: BillingRowView) => {
    const own = sortPeriods(scopePeriods(ctx.billing, r.scope))
    const cur = splitTimeline(own, today()).current
    setEditKey(r.key)
    setSeededFrom(null)
    if (cur) { openDraft(draftFromPeriod(cur), r.account?.nickname ?? ''); return }
    // Nothing in force: pre-select what the assistant reported, else what detection found.
    const detection = detections.find(d => d.harness === r.harness && d.source !== 'none' && d.mode !== 'unknown')
    const planId = (r.account ? matchDetectedPlan(r.harness, r.account.plan) : '') || detection?.planId || ''
    const entry = planId ? findPlan(planId) : undefined
    const start = { ...emptyDraft(), from: r.account ? dayOf(r.account.firstSeen) : today(), ongoing: true }
    openDraft(entry ? applyPlan(start, withLive(entry)) : start, r.account?.nickname ?? '')
    if (entry && !r.account?.plan && detection) setSeededFrom(pt ? detection.evidencePt : detection.evidenceEn)
  }
  const close = () => { setEditKey(null); setDraft(null); setChangingFrom(null) }
  const dirty = draft !== null && JSON.stringify([draft, nick]) !== origin

  const pickPlan = (planId: string) => {
    const entry = findPlan(planId)
    if (!entry || !draft) return
    if (current && draft.id === current.id && planId !== current.planId) {
      setChangingFrom(current)
      setDraft(applyPlan({ ...emptyDraft(), from: today(), ongoing: true }, withLive(entry)))
      return
    }
    if (changingFrom && planId === changingFrom.planId) {
      setChangingFrom(null)
      setDraft(draftFromPeriod(changingFrom))
      return
    }
    // A price the previous pick filled in is not one the user typed: the new pick replaces it.
    const prev = draft.planId ? findPlan(draft.planId) : undefined
    const prevAmount = prev ? (livePrice(prev.id)?.amount ?? prev.monthly?.amount) : undefined
    const base = prevAmount !== undefined && draft.amount === String(prevAmount) ? { ...draft, amount: '' } : draft
    setDraft(applyPlan(base, withLive(entry)))
  }

  /** The timeline the draft joins: with a plan change, the plan in force already closed at the seam. */
  const others = useMemo(() => (changingFrom && draft ? closeBefore(periods, changingFrom.id, draft.from) : periods), [periods, changingFrom, draft])
  const draftErrors = useMemo(() => (draft ? validateDraft(draft, others, newPeriodId) : []), [draft, others])
  const errorFor = (codes: string[]): string | null => {
    if (!showErrors) return null
    const hit = draftErrors.find(e => codes.includes(e.code))
    if (!hit) return null
    const other = hit.code === 'overlap' ? others.find(p => p.id === (hit as { withId: string }).withId) : undefined
    return describeError(hit, pt ? 'pt' : 'en', other ? periodName(other) : undefined)
  }

  /** Every plan write: the row's own scope, tracked while its account still needs a plan. */
  const writePeriods = useCallback(async (next: BillingPeriod[]): Promise<boolean> => {
    if (!row) return false
    const scope = row.scope
    const change = (cur: BillingSettingsShape): BillingSettingsShape => withScopePeriods(cur, scope, next)
    setSaveError(null)
    const tracked = row.account !== null && needPlan.some(a => a.id === row.account!.id) ? row.account.id : null
    let ok: boolean
    if (tracked) {
      billingNotices.mark(tracked, 'saving')
      ok = await ctx.saveBilling(change).then(() => true, () => false)
      if (ok) billingNotices.clear(tracked); else billingNotices.mark(tracked, 'failed')
    } else ok = await ctx.saveBilling(change).then(() => true, () => false)
    if (!ok) setSaveError({ msg: pt ? 'Não foi possível salvar. Tente de novo.' : 'Could not save. Try again.', id: tracked })
    return ok
  }, [row, needPlan, ctx, pt])

  const saveNickname = async (): Promise<boolean> => {
    const a = row?.account
    if (!a || nick.trim() === (a.nickname ?? '')) return true
    const res = await mutator.patch(a.id, { nickname: nick.trim() })
    if (res.status !== 'ok') {
      setSaveError({ msg: pt ? 'Não foi possível salvar o apelido. Tente de novo.' : 'Could not save the nickname. Try again.', id: null })
      return false
    }
    setAccounts(h => h.map(x => x.id === a.id ? { ...x, ...res.account } : x))
    return true
  }

  const save = async () => {
    if (!draft || !row) return
    const planChanged = JSON.stringify(draft) !== JSON.stringify((JSON.parse(origin || '[null]') as [PeriodDraft | null])[0])
    // The button is never disabled: pressing it reveals what is missing instead.
    if (planChanged && draftErrors.length > 0) { setShowErrors(true); return }
    if (!(await saveNickname())) return
    if (!planChanged) { close(); return }
    const period = periodFromDraft(draft, newPeriodId)
    const rest = others.filter(p => p.id !== period.id)
    await saveThenClose(() => writePeriods([...rest, period]), close)
  }
  /** "Not sure yet": the account prices as `unknown` (N/A, never 0) until a plan is registered. */
  const notSure = async () => {
    if (!row?.account) return
    await saveThenClose(() => writePeriods([unknownPeriod(today(), newPeriodId)]), close)
  }

  const catalogOptions = useMemo(() => (row ? plansForHarness(row.harness) : []).map(entry => {
    const price = livePrice(entry.id) ?? entry.monthly
    return {
      value: entry.id, label: entry.label,
      hint: price ? `${price.currency} ${price.amount}/${pt ? 'mês' : 'mo'}` : (pt ? 'sem valor publicado' : 'no published price'),
    }
  }), [row, pt, livePrice])
  const selectedEntry = draft?.planId ? findPlan(draft.planId) : undefined
  const errPlace = saveErrorPlace(saveError, noticeState, draft !== null)
  const editingPast = draft !== null && draft.id !== '' && draft.id !== current?.id
  const L = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 } as const

  return (
    <div>
      <SectionHeader label={pt ? 'Assinaturas e uso' : 'Subscriptions & usage'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'Uma linha por conta: o plano que você paga e quanto dos limites já usou. Todo custo no app é uma estimativa a preço de API até você cadastrar o plano — aí ele passa a refletir o que você realmente paga. Os agentes só usam as contas com “Agentes” ligado. Tudo fica nesta máquina.'
          : 'One row per account: the plan you pay for and how much of its limits you have used. Every cost in the app is an API-price estimate until you register the plan — then it reflects what you actually pay. Agents only use accounts with “Agents” on. It all stays on this machine.'}
      </p>

      <BillingAccountList lang={ctx.lang} rows={rows} now={limitsNow} pendingIds={pendingIds} failedIds={failedIds}
        selectedKey={editKey} onToggle={a => { void toggleAccount(a) }} onEdit={openRow} />

      {errPlace === 'page' && saveError && (
        <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--accent-red)' }}>{saveError.msg}</div>
      )}

      <Drawer open={draft !== null && row !== null} title={row?.title ?? ''} onClose={close} lang={pt ? 'pt' : 'en'} dirty={dirty}
        footer={
          <div style={{ display: 'flex', gap: 8, width: '100%', flexDirection: isMobile ? 'column-reverse' : 'row' }}>
            {!current && row?.account && (
              <button type="button" style={{ ...dialogButtonStyle('secondary', isMobile), flex: isMobile ? undefined : 1 }} onClick={() => { void notSure() }}>
                {pt ? 'Não sei agora' : 'Not sure yet'}
              </button>
            )}
            <button type="button" style={{ ...dialogButtonStyle('primary', isMobile), flex: 1 }} onClick={() => { void save() }}>{pt ? 'Salvar' : 'Save'}</button>
          </div>
        }>
        {draft && row && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, minWidth: 0 }}>
              <HarnessMark harness={row.harness} size={22} />
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.sub}</span>
            </div>
            {errPlace === 'drawer' && saveError && <div role="alert" style={{ marginBottom: 10, fontSize: 12, color: 'var(--accent-red)' }}>{saveError.msg}</div>}
            {timelineErrors.size > 0 && (
              <div role="alert" style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 14, padding: '10px 12px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--accent-red)' }}>
                <AlertTriangle size={15} style={{ color: 'var(--accent-red)', flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {pt
                    ? 'Há períodos com problema abaixo. Enquanto não forem corrigidos, o custo do plano desta conta não pode ser calculado — dois planos no mesmo dia cobrariam esse dia duas vezes.'
                    : 'Some periods below have problems. Until they are fixed this account’s plan cost cannot be computed — two plans on the same day would charge that day twice.'}
                </div>
              </div>
            )}
            {row.account && (
              <FieldInput label={pt ? 'Apelido' : 'Nickname'} value={nick} onChange={setNick} maxLength={40} placeholder={pt ? 'Ex.: Pessoal' : 'e.g. Personal'}
                sub={pt ? 'É só este nome que os agentes veem — nunca o e-mail.' : 'Agents only ever see this name — never the e-mail.'} />
            )}
            {editingPast && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 10px' }}>
                {pt ? 'Editando um plano anterior.' : 'Editing an earlier plan.'}{' '}
                <button type="button" style={linkBtn} onClick={() => current ? openDraft(draftFromPeriod(current), nick) : openRow(row)}>
                  {pt ? 'voltar ao plano atual' : 'back to the current plan'}
                </button>
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <div style={L}>{pt ? 'Plano' : 'Plan'}</div>
              <Select value={draft.planId} onChange={pickPlan} options={catalogOptions} placeholder={pt ? 'Escolha um plano' : 'Choose a plan'}
                searchable searchPlaceholder={pt ? 'Buscar plano…' : 'Search plans…'} />
              <FieldError text={errorFor(['missing_plan'])} />
              {seededFrom && (
                <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6, lineHeight: 1.5 }}>
                  <Sparkles size={12} style={{ flexShrink: 0, marginTop: 2 }} />{seededFrom}
                </div>
              )}
              {changingFrom && (
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
                  {pt
                    ? `Troca de plano: ${periodName(changingFrom) || modeLabel(changingFrom.mode, 'pt')} termina na véspera da data de início abaixo.`
                    : `Plan change: ${periodName(changingFrom) || modeLabel(changingFrom.mode, 'en')} ends the day before the start date below.`}
                </div>
              )}
              {/* Provenance, always: a prefilled amount with no stated origin reads as invented. */}
              {selectedEntry && livePrice(selectedEntry.id) && (
                <div style={{ fontSize: 11, color: 'var(--accent-green, #22c55e)', marginTop: 6, lineHeight: 1.5 }}>
                  {pt
                    ? `Valor lido hoje de ${livePrice(selectedEntry.id)!.source}. Confirme na sua fatura — cobrança anual, plano antigo ou imposto podem mudar o número.`
                    : `Read today from ${livePrice(selectedEntry.id)!.source}. Confirm against your invoice — annual billing, a grandfathered plan or tax can change it.`}
                </div>
              )}
              {selectedEntry && !livePrice(selectedEntry.id) && selectedEntry.monthly && (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6, lineHeight: 1.5 }}>
                  {pt
                    ? `Preço de tabela de ${fmtDay(selectedEntry.monthly.verifiedAt)}.`
                    : `List price as of ${fmtDay(selectedEntry.monthly.verifiedAt)}.`}
                </div>
              )}
            </div>

            {draft.planId === 'other' && (
              <>
                <FieldInput label={pt ? 'Nome do plano' : 'Plan name'} value={draft.label}
                  onChange={v => setDraft(d => (d ? { ...d, label: v } : d))} placeholder={pt ? 'Ex.: gateway da empresa' : 'e.g. company gateway'} />
                <FieldError text={errorFor(['missing_label'])} />
              </>
            )}

            {draft.planId !== '' && draftWantsPrice(draft) && (
              <>
                <MoneyField label={pt ? 'Valor por mês' : 'Amount per month'}
                  sub={pt ? 'O que aparece na sua fatura.' : 'What your invoice says.'}
                  amount={draft.amount} currency={draft.currency} monthSuffix={pt ? '/mês' : '/mo'}
                  onAmountChange={v => setDraft(d => (d ? { ...d, amount: v } : d))}
                  onCurrencyChange={c => setDraft(d => (d ? { ...d, currency: c } : d))} />
                <FieldError text={errorFor(['missing_price', 'non_positive_price', 'price_on_non_subscription'])} />
              </>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <DateField label={pt ? 'Começou em' : 'Started on'} value={draft.from} lang={pt ? 'pt' : 'en'}
                onChange={v => setDraft(d => (d ? { ...d, from: v } : d))} />
              {!draft.ongoing && (
                <DateField label={pt ? 'Terminou em' : 'Ended on'} value={draft.to} lang={pt ? 'pt' : 'en'}
                  onChange={v => setDraft(d => (d ? { ...d, to: v } : d))} />
              )}
            </div>
            <FieldError text={errorFor(['missing_from', 'bad_day', 'inverted_range'])} />
            <div style={{ marginBottom: 12 }}>
              <Checkbox checked={draft.ongoing} onChange={v => setDraft(d => (d ? { ...d, ongoing: v } : d))}
                label={pt ? 'Ainda pago este plano' : 'I still pay for this plan'} />
            </div>
            <FieldError text={errorFor(['overlap'])} />

            {current && draft.id === current.id && (
              <button type="button" style={{ ...linkBtn, color: 'var(--accent-red)' }} onClick={() => setConfirmDelete(current)}>
                {pt ? 'Remover este plano' : 'Remove this plan'}
              </button>
            )}

            {history.length > 0 && (
              <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                <div style={{ padding: '9px 14px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>
                  {pt ? `Planos anteriores (${history.length})` : `Earlier plans (${history.length})`}
                </div>
                {history.map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 14px', borderTop: '1px solid var(--border)', background: draft.id === p.id ? 'var(--bg-elevated)' : undefined }}>
                    {/* On a phone the dates take their own line: name, price, range and two icons do not fit one. */}
                    <div style={{ minWidth: 0, flex: 1, fontSize: 12, color: 'var(--text-tertiary)' }}>
                      <span style={{ display: isMobile ? 'block' : 'inline', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{periodName(p) || modeLabel(p.mode, pt ? 'pt' : 'en')}</b>
                        {p.price && ` · ${currencySymbol(p.price.currency)} ${formatAmountDisplay(String(p.price.amount), p.price.currency)}`}
                      </span>
                      <span style={{ display: isMobile ? 'block' : 'inline', whiteSpace: 'nowrap', marginTop: isMobile ? 2 : 0 }}>
                        {isMobile ? '' : ' · '}{fmtDay(p.from)} → {p.to ? fmtDay(p.to) : (pt ? 'em curso' : 'ongoing')}
                      </span>
                    </div>
                    <button type="button" onClick={() => openDraft(draftFromPeriod(p), nick)} style={iconBtn} title={pt ? 'Editar' : 'Edit'} aria-label={pt ? 'Editar' : 'Edit'}><Pencil size={14} /></button>
                    <button type="button" onClick={() => setConfirmDelete(p)} style={{ ...iconBtn, color: 'var(--accent-red)' }} title={pt ? 'Remover' : 'Remove'} aria-label={pt ? 'Remover' : 'Remove'}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Drawer>

      <ConfirmModal
        open={confirmDelete !== null}
        title={pt ? 'Remover plano' : 'Remove plan'}
        message={pt
          ? `Remover "${confirmDelete ? periodName(confirmDelete) || modeLabel(confirmDelete.mode, 'pt') : ''}"? Os dias que ele cobria deixam de contar para o custo do plano.`
          : `Remove “${confirmDelete ? periodName(confirmDelete) || modeLabel(confirmDelete.mode, 'en') : ''}”? The days it covered will stop counting towards the plan cost.`}
        confirmLabel={pt ? 'Remover' : 'Remove'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={async () => {
          const gone = confirmDelete
          setConfirmDelete(null)
          if (!gone) return
          const ok = await writePeriods(periods.filter(p => p.id !== gone.id))
          if (ok && draft?.id === gone.id) close()
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}

/** `yyyy-MM-dd` → `dd/MM/yyyy`, the same reading the date picker shows. */
const fmtDay = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d)

/**
 * Errors render inline under their field, never as a toast: on a phone this form is a full-screen
 * drawer, and a toast over it is read once and cannot be re-read.
 */
function FieldError({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <div style={{ fontSize: 11.5, color: 'var(--accent-red)', margin: '-6px 0 12px', lineHeight: 1.45 }}>
      {text}
    </div>
  )
}

/**
 * The amount field: currency symbol inside the box, live grouping, currency picker attached — so
 * "am I typing dollars or reais" is answerable without looking away from what you type. The stored
 * value stays canonical (dot decimal, no grouping); only the display is formatted.
 */
function MoneyField({ label, sub, amount, currency, monthSuffix, onAmountChange, onCurrencyChange }: {
  label: string
  sub?: string
  amount: string
  currency: BillingCurrency
  /** "/mo" or "/mês" — follows the language, not the currency. */
  monthSuffix: string
  onAmountChange: (v: string) => void
  onCurrencyChange: (c: BillingCurrency) => void
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 5, lineHeight: 1.45 }}>{sub}</div>}
      {/* Wraps rather than clips: at 390px inside the drawer the currency picker would fall off the edge. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{
          flex: '1 1 180px', display: 'flex', alignItems: 'center', gap: 6,
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          background: 'var(--bg-input)', padding: '0 11px',
        }}>
          <span style={{ color: 'var(--text-tertiary)', fontWeight: 600, flexShrink: 0 }}>{currencySymbol(currency)}</span>
          <input
            inputMode="decimal"
            value={formatAmountDisplay(amount, currency)}
            onChange={e => onAmountChange(parseAmountInput(e.target.value))}
            placeholder={currency === 'BRL' ? '540,00' : '100.00'}
            // No inline fontSize — the global >=16px guard in index.css stops iOS Safari zooming.
            style={{ flex: 1, minWidth: 0, padding: '9px 0', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontFamily: 'inherit' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>{monthSuffix}</span>
        </div>
        <div style={{ flexShrink: 0 }}>
          <TabSelect options={[{ value: 'USD', label: 'USD' }, { value: 'BRL', label: 'BRL' }]} value={currency}
            onChange={v => onCurrencyChange(v as BillingCurrency)} />
        </div>
      </div>
    </div>
  )
}

/** The app's own calendar (`DatePicker`, dd/mm/aaaa) in a field-shaped frame. No future days. */
function DateField({ label, value, lang, onChange }: { label: string; value: string; lang: 'pt' | 'en'; onChange: (v: string) => void }) {
  return (
    <span data-billing-date style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-input)', padding: '3px 4px' }}>
      <DatePicker value={value} onChange={onChange} label={label} placeholder={lang === 'pt' ? 'dd/mm/aaaa' : 'dd/mm/yyyy'} max={today()} lang={lang}
        labelStyle={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, fontWeight: 600, opacity: 1 }} />
    </span>
  )
}

/** The quiet secondary action: a link, not a second button competing with Save. */
const linkBtn: React.CSSProperties = {
  display: 'inline', padding: 0, border: 'none', background: 'none',
  color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
  textDecoration: 'underline',
}

const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 6,
  color: 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center',
}
