/**
 * BILLING.SIMPLE phase 1 — a dev-only render of Settings → Billing: the CURRENT page (with fetch
 * stubbed) and three layout options built from the app's existing components. Not shipped.
 *
 * Query: ?view=before|A|B|C &n=1|3 &theme=dark|light &lang=pt|en &drawer=1
 */
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import '../../src/index.css'
import {
  findPlan, normalizeBillingSettings, plansForHarness, sortPeriods,
  type BillingSettings as BillingShape, type HarnessId, type PlanLimits,
} from '@agentistics/core'
import BillingSettings from '../../src/pages/settings/BillingSettings'
import { HARNESS_LABELS } from '../../src/lib/harness'
import { useIsMobile } from '../../src/hooks/useIsMobile'
import { HarnessMark } from '../../src/components/sessions/HarnessMark'
import { PlanLimitBars } from '../../src/components/PlanLimitMeter'
import { Pill } from '../../src/components/Pill'
import { Drawer } from '../../src/components/Drawer'
import {
  Checkbox, FieldInput, RecordCard, RecordCardAction, RowSwitch, SectionHeader, Select, TabSelect, Toggle, dialogButtonStyle,
} from '../../src/pages/settings/primitives'
import { accountTitle, isPlaceholderName } from '../../src/pages/settings/accountsSummary'
import { ownPeriods, type BillingAccount } from '../../src/pages/settings/accountBilling'
import { currencySymbol, formatAmountDisplay, periodName, splitTimeline } from '../../src/pages/settings/billingForm'

const q = new URLSearchParams(location.search)
const view = q.get('view') ?? 'A'
const REAL = q.get('n') === 'real'
const n = REAL ? 3 : Number(q.get('n') ?? '3')
const lang = (q.get('lang') ?? 'pt') as 'pt' | 'en'
const pt = lang === 'pt'
const drawerOpen = q.get('drawer') === '1'
if (q.get('theme') === 'light') document.documentElement.dataset.theme = 'light'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
const NOW = Date.now()
const H = 3600_000
const TODAY = new Date(NOW).toISOString().slice(0, 10)
const ALL_ACCOUNTS: BillingAccount[] = [
  { id: 'acc_c1', harness: 'claude', key: 'c1', label: 'zlucason1@gmail.com', root: null, available: true, firstSeen: Date.parse('2026-08-01T12:00:00Z') },
  { id: 'acc_c2', harness: 'claude', key: 'c2', label: 'lucas@empresa.com.br', nickname: 'Trabalho', root: '/home/u/.claude-work', available: false, firstSeen: Date.parse('2026-08-20T12:00:00Z') },
  { id: 'acc_x1', harness: 'codex', key: 'x1', label: 'zlucas@outlook.com', root: null, available: true, firstSeen: Date.parse('2026-09-15T12:00:00Z') },
]
// The owner's real shape (fix round 2): 8 registry rows for 6 accounts — gemini and antigravity each
// registered twice under their `root:` fallback key, as a second home sees them.
const SEEN = Date.parse('2026-10-13T12:00:00Z')
const fb = (id: string, harness: HarnessId, root: string): BillingAccount =>
  ({ id, harness, key: `root:${root}`, label: 'Default account', root: null, available: true, firstSeen: SEEN })
const REAL_ACCOUNTS: BillingAccount[] = [
  { id: 'acc_5dfb', harness: 'claude', key: 'd3c3:zlucason1@gmail.com', label: 'zlucason1@gmail.com', nickname: 'Principal', root: null, available: true, firstSeen: SEEN },
  { id: 'acc_8933', harness: 'codex', key: '1a58', label: 'ChatGPT 1a583a5f', nickname: 'Principal', root: null, available: true, firstSeen: SEEN },
  fb('acc_g1', 'gemini', '1721'), fb('acc_g2', 'gemini', '9a0b'),
  { id: 'acc_e527', harness: 'copilot', key: 'gh:blpsoares', label: 'blpsoares', root: null, available: true, firstSeen: SEEN },
  fb('acc_a1', 'antigravity', 'e317'), fb('acc_a2', 'antigravity', '77c1'),
  fb('acc_k1', 'kimi', 'f5c6'),
]
const ACCOUNTS = REAL ? REAL_ACCOUNTS : n === 1 ? ALL_ACCOUNTS.slice(0, 1) : ALL_ACCOUNTS
const win = (kind: '5h' | 'week', usedPct: number, inH: number) => ({ kind, usedPct, resetsAt: NOW + inH * H })
const ALL_LIMITS: PlanLimits[] = [
  { harness: 'claude', account: 'acc_c1', windows: [win('5h', 47, 2.3), win('week', 58, 70)], updatedAt: NOW, source: 'claude-usage-api' },
  { harness: 'claude', account: 'acc_c2', windows: [win('5h', 12, 4), win('week', 31, 120)], updatedAt: NOW, source: 'claude-usage-api' },
  { harness: 'codex', account: 'acc_x1', windows: [win('5h', 8, 3.1), win('week', 22, 96)], updatedAt: NOW, source: 'codex-rollout' },
]
const LIMITS = REAL ? [
  { harness: 'claude', account: 'acc_5dfb', windows: [win('5h', 67, 2.3), win('week', 60, 70)], updatedAt: NOW, source: 'claude-usage-api' },
  { harness: 'codex', account: 'acc_8933', windows: [win('5h', 56, 3.1), win('week', 62, 96)], updatedAt: NOW, source: 'codex-rollout' },
] as PlanLimits[] : ALL_LIMITS.filter(l => ACCOUNTS.some(a => a.id === l.account))
const unk = (id: string) => ({ periods: [{ id: `bp_${id}`, mode: 'unknown' as const, from: '2026-10-13' }] })
const BILLING: BillingShape = REAL ? normalizeBillingSettings({
  profiles: { claude: { periods: [{ id: 'bp_cl', mode: 'subscription', planId: 'anthropic-max-5x', price: { amount: 550, currency: 'BRL' }, from: '2026-10-01' }] } },
  accountProfiles: {
    acc_8933: { periods: [
      { id: 'bp_x0', mode: 'subscription', planId: 'openai-plus', price: { amount: 20, currency: 'USD' }, from: '2026-10-04', to: '2026-10-16' },
      { id: 'bp_x1', mode: 'subscription', planId: 'openai-plus', price: { amount: 110.5, currency: 'BRL' }, from: '2026-10-17' },
    ] },
    acc_g1: unk('g1'), acc_e527: unk('p'), acc_a1: unk('a1'), acc_k1: unk('k1'),
  },
}) : normalizeBillingSettings({
  profiles: { claude: { periods: [{ id: 'bp_def', mode: 'subscription', planId: 'anthropic-max-5x', price: { amount: 100, currency: 'USD' }, from: '2026-08-01' }] } },
  accountProfiles: n === 1 ? {} : {
    acc_c2: { periods: [
      { id: 'bp_w0', mode: 'subscription', planId: 'anthropic-pro', price: { amount: 20, currency: 'USD' }, from: '2026-05-01', to: '2026-08-31' },
      { id: 'bp_w1', mode: 'subscription', planId: 'anthropic-max-5x', price: { amount: 100, currency: 'USD' }, from: '2026-09-01' },
    ] },
  },
})
const HARNESSES: HarnessId[] = REAL ? ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi'] : n === 1 ? ['claude'] : ['claude', 'codex']

// ── the row model every option draws from: ONE row per account ───────────────────────────────
interface Row {
  a: BillingAccount
  harnessLabel: string
  /** Nickname, else the login. */
  title: string
  /** The harness — plus the login only when a nickname took the title. Never the same text twice. */
  sub: string
  plan: { name: string; price: string | null; since: string } | null
  limits: PlanLimits | null
}
function rowsOf(accounts: BillingAccount[]): Row[] {
  return accounts.map(a => {
    const harnessLabel = HARNESS_LABELS[a.harness] ?? a.harness
    const nick = a.nickname && !isPlaceholderName(a.nickname)
    const own = ownPeriods(BILLING, a.id)
    const periods = own.length > 0 ? own : (BILLING.profiles[a.harness]?.periods ?? [])
    const cur = splitTimeline(sortPeriods(periods), TODAY).current
    return {
      a, harnessLabel,
      title: accountTitle(a, harnessLabel, pt),
      sub: nick ? `${harnessLabel} · ${a.label}` : harnessLabel,
      plan: cur ? {
        name: periodName(cur) || (pt ? 'Sem plano' : 'No plan'),
        price: cur.price ? `${currencySymbol(cur.price.currency)} ${formatAmountDisplay(String(cur.price.amount), cur.price.currency)}${pt ? '/mês' : '/mo'}` : null,
        since: cur.from,
      } : null,
      limits: LIMITS.find(l => l.account === a.id) ?? null,
    }
  })
}

const t = {
  title: pt ? 'Assinaturas e uso' : 'Subscriptions & usage',
  intro: pt
    ? 'Uma linha por conta logada nesta máquina: o plano que você paga e quanto dos limites já usou. Os custos do app passam a refletir o que você realmente paga.'
    : 'One row per account signed in on this machine: the plan you pay for and how much of its limits you have used. The app’s costs then reflect what you actually pay.',
  account: pt ? 'Conta' : 'Account', plan: pt ? 'Plano' : 'Plan', usage: pt ? 'Uso' : 'Usage', agents: pt ? 'Agentes' : 'Agents',
  edit: pt ? 'Editar' : 'Edit', setPlan: pt ? 'Definir plano' : 'Set plan', noPlan: pt ? 'Sem plano' : 'No plan',
  noUsage: pt ? 'Não informado' : 'Not reported',
  accounts: (k: number) => (pt ? `${k} ${k === 1 ? 'conta' : 'contas'}` : `${k} ${k === 1 ? 'account' : 'accounts'}`),
}

function Summary({ rows }: { rows: Row[] }) {
  const priced = rows.filter(r => r.plan)
  return (
    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 10px' }}>
      {pt ? `${priced.length} de ${rows.length} com plano` : `${priced.length} of ${rows.length} with a plan`}
    </div>
  )
}

function PlanCell({ r }: { r: Row }) {
  if (!r.plan) return <span style={{ justifySelf: 'start', alignSelf: 'center' }}><Pill tone="warn" nowrap>{t.noPlan}</Pill></span>
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.plan.name}</div>
      {r.plan.price && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{r.plan.price}</div>}
    </div>
  )
}
const Usage = ({ r }: { r: Row }) => r.limits
  ? <PlanLimitBars limits={r.limits} now={NOW} lang={lang} />
  : <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t.noUsage}</span>

function AccountName({ r, mark = true }: { r: Row; mark?: boolean }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {mark && <HarnessMark harness={r.a.harness} size={22} />}
      <span style={{ minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</b>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sub}</span>
      </span>
    </span>
  )
}
const ActionBtn = ({ r, onEdit }: { r: Row; onEdit: (r: Row) => void }) => (
  <button type="button" style={{ ...dialogButtonStyle(r.plan ? 'secondary' : 'primary', false), whiteSpace: 'nowrap', width: '100%' }} onClick={() => onEdit(r)}>
    {r.plan ? t.edit : t.setPlan}
  </button>
)

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden' }

// ── Option A: one flat list, one row per account ─────────────────────────────────────────────
const gridA = 'minmax(0,1.5fr) minmax(0,1.1fr) minmax(170px,1fr) 64px 118px'
function OptionA({ onEdit }: { onEdit: (r: Row) => void }) {
  const isMobile = useIsMobile()
  const rows = rowsOf(ACCOUNTS)
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map(r => [r.a.id, r.a.available])))
  if (isMobile) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Summary rows={rows} />
      {rows.map(r => (
        <RecordCard key={r.a.id}
          leading={<HarnessMark harness={r.a.harness} size={22} />}
          title={r.title} subtitle={r.sub}
          fields={[
            { label: t.plan, value: r.plan ? `${r.plan.name}${r.plan.price ? ` · ${r.plan.price}` : ''}` : <Pill tone="warn" nowrap>{t.noPlan}</Pill> },
            { label: t.usage, value: <Usage r={r} /> },
          ]}
          actions={<>
            <RowSwitchCell on={on[r.a.id]} label={`${t.agents} · ${r.title}`} onToggle={() => setOn(s => ({ ...s, [r.a.id]: !s[r.a.id] }))} />
            <RecordCardAction label={`${r.plan ? t.edit : t.setPlan} · ${r.title}`} onClick={() => onEdit(r)}>{r.plan ? t.edit : t.setPlan}</RecordCardAction>
          </>}
        />
      ))}
    </div>
  )
  return (
    <>
      <Summary rows={rows} />
      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: gridA, gap: 14, padding: '8px 14px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', background: 'var(--bg-elevated)' }}>
          <span>{t.account}</span><span>{t.plan}</span><span>{t.usage}</span><span>{t.agents}</span><span />
        </div>
        {rows.map(r => (
          <div key={r.a.id} data-billing-account={r.a.id} style={{ display: 'grid', gridTemplateColumns: gridA, gap: 14, alignItems: 'center', padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
            <AccountName r={r} />
            <PlanCell r={r} />
            <Usage r={r} />
            <Toggle on={on[r.a.id]} label={`${t.agents} · ${r.title}`} onToggle={() => setOn(s => ({ ...s, [r.a.id]: !s[r.a.id] }))} />
            <ActionBtn r={r} onEdit={onEdit} />
          </div>
        ))}
      </div>
    </>
  )
}
/** The Agents switch as a RecordCard footer cell: same share and height as RecordCardAction. */
function RowSwitchCell({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <div style={{ flex: 1, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'var(--bg-card)', fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
      <Toggle on={on} onToggle={onToggle} label={label} />{t.agents}
    </div>
  )
}

// ── Option B: one card per assistant, accounts inside ───────────────────────────────────────
function OptionB({ onEdit }: { onEdit: (r: Row) => void }) {
  const isMobile = useIsMobile()
  const rows = rowsOf(ACCOUNTS)
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map(r => [r.a.id, r.a.available])))
  return (
    <>
      <Summary rows={rows} />
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12, alignItems: 'start' }}>
        {HARNESSES.map(h => {
          const mine = rows.filter(r => r.a.harness === h)
          return (
            <div key={h} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'var(--bg-elevated)' }}>
                <HarnessMark harness={h} size={24} />
                <b style={{ fontSize: 13.5, color: 'var(--text-primary)', flex: 1 }}>{HARNESS_LABELS[h]}</b>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t.accounts(mine.length)}</span>
              </div>
              {mine.map(r => (
                <div key={r.a.id} style={{ padding: '12px 14px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <b style={{ display: 'block', fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</b>
                      {r.a.nickname && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.a.label}</span>}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                      {t.agents}<Toggle on={on[r.a.id]} label={`${t.agents} · ${r.title}`} onToggle={() => setOn(s => ({ ...s, [r.a.id]: !s[r.a.id] }))} />
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 12, alignItems: 'center' }}>
                    <PlanCell r={r} />
                    <button type="button" style={{ ...dialogButtonStyle(r.plan ? 'secondary' : 'primary', false), whiteSpace: 'nowrap' }} onClick={() => onEdit(r)}>{r.plan ? t.edit : t.setPlan}</button>
                  </div>
                  <Usage r={r} />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── Option C: assistant tabs, the chosen assistant's accounts with the full meters ───────────
function OptionC({ onEdit }: { onEdit: (r: Row) => void }) {
  const isMobile = useIsMobile()
  const [h, setH] = useState<HarnessId>(HARNESSES[0])
  const rows = rowsOf(ACCOUNTS)
  const mine = rows.filter(r => r.a.harness === h)
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map(r => [r.a.id, r.a.available])))
  return (
    <>
      {HARNESSES.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <TabSelect options={HARNESSES.map(x => ({ value: x, label: `${HARNESS_LABELS[x]} · ${rows.filter(r => r.a.harness === x).length}` }))} value={h} onChange={setH} />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {mine.map(r => (
          <div key={r.a.id} style={{ ...card, padding: '14px 16px', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1.1fr)', gap: 14, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <AccountName r={{ ...r, sub: r.a.nickname ? r.a.label : '' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1, minWidth: 0 }}><PlanCell r={r} /></span>
                <button type="button" style={{ ...dialogButtonStyle(r.plan ? 'secondary' : 'primary', false), whiteSpace: 'nowrap' }} onClick={() => onEdit(r)}>{r.plan ? t.edit : t.setPlan}</button>
              </div>
              <RowSwitch on={on[r.a.id]} label={t.agents} sub={on[r.a.id] ? (pt ? 'Agentes podem usar esta conta' : 'Agents may use this account') : (pt ? 'Oculta dos agentes' : 'Hidden from agents')}
                onToggle={() => setOn(s => ({ ...s, [r.a.id]: !s[r.a.id] }))} />
            </div>
            <div style={{ minWidth: 0 }}>
              {r.limits ? <PlanLimitBars limits={r.limits} now={NOW} lang={lang} /> : <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t.noUsage}</span>}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ── the ONE editor every option opens: nickname + plan + dates + history + Agents ────────────
function EditDrawer({ r, onClose }: { r: Row | null; onClose: () => void }) {
  const isMobile = useIsMobile()
  const [nick, setNick] = useState(r?.a.nickname ?? '')
  const own = r ? ownPeriods(BILLING, r.a.id) : []
  const periods = r ? (own.length > 0 ? own : (BILLING.profiles[r.a.harness]?.periods ?? [])) : []
  const { current, history } = splitTimeline(sortPeriods(periods), TODAY)
  const [planId, setPlanId] = useState(current?.planId ?? '')
  const entry = planId ? findPlan(planId) : undefined
  const [ongoing, setOngoing] = useState(true)
  const [showHist, setShowHist] = useState(true)
  const options = r ? plansForHarness(r.a.harness).map(e => ({ value: e.id, label: e.label, hint: e.monthly ? `${e.monthly.currency} ${e.monthly.amount}/${pt ? 'mês' : 'mo'}` : (pt ? 'sem valor publicado' : 'no published price') })) : []
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }
  const input: React.CSSProperties = { width: '100%', padding: '9px 11px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', boxSizing: 'border-box' }
  return (
    <Drawer open={r !== null} lang={lang} onClose={onClose} title={r ? r.title : ''}
      footer={<button type="button" style={{ ...dialogButtonStyle('primary', isMobile), width: '100%' }} onClick={onClose}>{pt ? 'Salvar' : 'Save'}</button>}>
      {r && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <HarnessMark harness={r.a.harness} size={22} />
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{r.harnessLabel} · {r.a.label}</span>
          </div>
          <FieldInput label={pt ? 'Apelido' : 'Nickname'} value={nick} onChange={setNick} maxLength={40}
            sub={pt ? 'É só este nome que os agentes veem — nunca o e-mail.' : 'Agents only ever see this name — never the e-mail.'} />
          <div style={{ marginBottom: 14 }}>
            <div style={label}>{t.plan}</div>
            <Select value={planId} onChange={setPlanId} options={options} searchable placeholder={pt ? 'Escolha um plano' : 'Choose a plan'} />
          </div>
          {entry?.mode === 'subscription' && (
            <div style={{ marginBottom: 14 }}>
              <div style={label}>{pt ? 'Valor por mês' : 'Amount per month'}</div>
              <input style={input} defaultValue={entry.monthly ? `${currencySymbol(entry.monthly.currency)} ${entry.monthly.amount}` : ''} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 150px', marginBottom: 14 }}>
              <div style={label}>{pt ? 'Começou em' : 'Started on'}</div>
              <input type="date" style={input} defaultValue={current?.from ?? TODAY} />
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <Checkbox checked={ongoing} onChange={setOngoing} label={pt ? 'Ainda pago este plano' : 'I still pay for this plan'} />
          </div>
          {history.length > 0 && (
            <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
              <button type="button" onClick={() => setShowHist(v => !v)} style={{ width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
                {pt ? `Planos anteriores (${history.length})` : `Earlier plans (${history.length})`}
              </button>
              {showHist && history.map(p => (
                <div key={p.id} style={{ padding: '9px 14px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-tertiary)' }}>
                  <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{periodName(p)}</b>
                  {p.price && ` · ${currencySymbol(p.price.currency)} ${p.price.amount}`} · {p.from} → {p.to ?? (pt ? 'em curso' : 'ongoing')}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}

function Options() {
  const rows = rowsOf(ACCOUNTS)
  const [editing, setEditing] = useState<Row | null>(drawerOpen ? rows[rows.length > 1 ? 1 : 0] : null)
  const Body = view === 'B' ? OptionB : view === 'C' ? OptionC : OptionA
  return (
    <div className="ag-settings" style={{ maxWidth: 1100 }}>
      <SectionHeader label={t.title} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>{t.intro}</p>
      <Body onEdit={setEditing} />
      <EditDrawer key={editing?.a.id ?? 'none'} r={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

// ── "before": the real page, network stubbed ─────────────────────────────────────────────────
function stubFetch() {
  const real = window.fetch.bind(window)
  const json = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input)
    if (u.includes('/api/accounts')) return json({ accounts: [
      ...ACCOUNTS.map(a => ({ ...a, lastSeen: NOW, firstSeen: a.firstSeen })),
      // The registry's reserve row for codex: the same login said twice. The page must not draw it.
      ...(n === 3 ? [{ id: '', harness: 'codex', key: 'default', label: 'Conta padrão', root: null, available: true }] : []),
    ] })
    if (u.includes('/api/plan-limits')) return json({ limits: LIMITS, registered: [] })
    if (u.includes('/api/billing/plan-prices')) return json({ prices: [] })
    if (u.includes('/api/billing/detect')) return json({ detections: [] })
    if (u.startsWith('/api')) return json({})
    return real(input, init)
  }) as typeof fetch
}
function Before() {
  const [billing, setBilling] = useState(BILLING)
  const ctx = {
    lang, data: { harnesses: HARNESSES }, billing,
    // Records what the page writes, for the flow check in flow.ts.
    saveBilling: async (next: BillingShape | ((cur: BillingShape) => BillingShape)) => {
      setBilling(cur => { const v = typeof next === 'function' ? next(cur) : next; (window as unknown as { __saved: unknown }).__saved = v; return v })
    },
  }
  return (
    <MemoryRouter>
      <Routes>
        <Route element={<div className="ag-settings" style={{ maxWidth: 1100 }}><Outlet context={ctx} /></div>}>
          <Route path="/" element={<BillingSettings />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

if (view === 'before' || view === 'final') stubFetch()
ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 'clamp(16px, 3vw, 32px)', minHeight: '100vh', boxSizing: 'border-box' }}>
    {view === 'before' || view === 'final' ? <Before /> : <Options />}
  </div>,
)
