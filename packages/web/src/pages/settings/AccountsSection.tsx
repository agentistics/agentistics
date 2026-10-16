/**
 * AccountsSection — Settings → Accounts: one compact, collapsed row per assistant; opening a row
 * shows that assistant's accounts (state, limits, the Agents switch) and its "Add account".
 *
 * The disclosure is the app's shared `Disclosure` (the one RailSection uses too). One assistant is open at a time (`nextOpen`). Every figure on a collapsed row comes from
 * `summarizeHarnesses`, over the same list the expanded rows draw.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HARNESS_ORDER, type HarnessId, type PlanLimits } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { usePlanLimits } from '../../lib/planLimits'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Drawer } from '../../components/Drawer'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { PlanLimitBars, PlanLimitsBlock } from '../../components/PlanLimitMeter'
import { CenteredLoader } from '../../components/CenteredLoader'
import { MetricNote } from '../../components/MetricNote'
import { DialogActions, FieldInput, RowSwitch, ScopeNote, SectionHeader, StatusDot, Toggle, dialogButtonStyle } from './primitives'
import { Pill } from '../../components/Pill'
import { Disclosure } from '../../components/Disclosure'
import {
  accountKey, accountState, accountTitle, accountWhose, isUnidentified, nextOpen, summarizeHarnesses,
  type AccountRowData, type HarnessSummary,
} from './accountsSummary'
import { createAccountMutator, reconcileNickname } from './accountMutations'

type Lang = 'pt' | 'en'

export interface AccountsViewProps {
  lang: Lang
  accounts: AccountRowData[]
  limits: PlanLimits[] | null
  now: number
  pendingIds: ReadonlySet<string>
  failedIds: ReadonlySet<string>
  onToggle: (a: AccountRowData) => void
  onDetail: (a: AccountRowData) => void
  /** Absent → no "Add account" anywhere (the multi-account flag is off). */
  onAdd?: (harness: HarnessId) => void
  /** Harnesses that cannot keep a second account apart; they get a sentence instead of the button. */
  noSecondAccount?: ReadonlySet<HarnessId>
  initialOpen?: HarnessId | null
}

const T = (pt: boolean) => ({
  accounts: (n: number) => (pt ? `${n} ${n === 1 ? 'conta' : 'contas'}` : `${n} ${n === 1 ? 'account' : 'accounts'}`),
  agentsOn: (n: number) => (pt ? `${n} com Agentes` : `${n} with Agents`),
  hidden: (n: number) => (pt ? `${n} ${n === 1 ? 'oculta' : 'ocultas'}` : `${n} hidden`),
  noneHidden: pt ? 'nenhuma oculta' : 'none hidden',
  noMeter: pt ? 'Sem limites de uso informados' : 'No usage limits reported',
  noPlan: pt ? 'Plano não informado' : 'Plan not set',
  agents: pt ? 'Agentes' : 'Agents',
  hiddenChip: pt ? 'Oculta dos agentes' : 'Hidden from agents',
  signedIn: pt ? 'Logada' : 'Signed in',
  signedOut: pt ? 'Saiu desta máquina' : 'Signed out',
  unconfirmedRow: pt ? 'Login não confirmado' : 'Not confirmed',
  unconfirmedNote: pt ? 'O assistente não confirma qual conta está logada — entre nele para gerenciá-la aqui.' : 'The assistant does not confirm which account is signed in — sign in to it to manage it here.',
  unconfirmedHarness: (n: number) => (pt ? `${n} não confirmada${n === 1 ? '' : 's'}` : `${n} not confirmed`),
  saveFailed: (name: string) => (pt ? `Não foi possível salvar a conta “${name}”. Tente de novo.` : `Could not save the account “${name}”. Try again.`),
  add: pt ? 'Adicionar conta' : 'Add account',
  agy: pt ? 'O Antigravity ainda não permite manter uma segunda conta separada.' : 'Antigravity cannot keep a second account apart yet.',
  stateOk: pt ? 'Tudo certo' : 'All good',
  needsLogin: (n: number) => (pt ? `${n} precisa de login` : `${n} need${n === 1 ? 's' : ''} sign-in`),
  errors: (n: number) => (pt ? `${n} com erro` : `${n} with errors`),
  toggleAria: (name: string) => (pt ? `Agentes podem usar ${name}` : `Agents may use ${name}`),
})

function stateOf(s: HarnessSummary, t: ReturnType<typeof T>): { dot: 'ok' | 'warn' | 'error'; word: string } {
  if (s.state === 'error') return { dot: 'error', word: t.errors(s.failed) }
  if (s.state === 'unconfirmed') return { dot: 'warn', word: t.unconfirmedHarness(s.unconfirmed) }
  if (s.state === 'needs-login') return { dot: 'warn', word: t.needsLogin(s.signedOut) }
  return { dot: 'ok', word: t.stateOk }
}

const grid = (isMobile: boolean): React.CSSProperties => isMobile
  ? { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }
  : { display: 'grid', gridTemplateColumns: '20px minmax(0,1.5fr) minmax(0,1.3fr) 110px 170px', gap: 12, alignItems: 'center' }

function HarnessRow({ s, open, onToggleOpen, props, isMobile }: {
  s: HarnessSummary; open: boolean; onToggleOpen: () => void; props: AccountsViewProps; isMobile: boolean
}) {
  const pt = props.lang === 'pt'
  const t = T(pt)
  const label = HARNESS_LABELS[s.harness] ?? s.harness
  const st = stateOf(s, t)
  const mine = props.accounts.filter(a => a.harness === s.harness)
  const panelId = `accounts-panel-${s.harness}`
  return (
    <div data-accounts-harness={s.harness} style={{ borderTop: '1px solid var(--border)' }}>
      <Disclosure
        open={open}
        onToggle={onToggleOpen}
        panelId={panelId}
        panelLabel={label}
        keepMounted
        buttonStyle={{ ...grid(isMobile), fontFamily: 'inherit' }}
        panelStyle={{ background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)' }}
        header={chevron => (
          <>
            {!isMobile && chevron}
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              {isMobile && chevron}
              <HarnessMark harness={s.harness} size={24} />
              <span style={{ minWidth: 0 }}>
                <b style={{ display: 'block', fontSize: 13.5, color: 'var(--text-primary)' }}>{label}</b>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {t.accounts(s.total)} · {t.agentsOn(s.agentsOn)}
                </span>
              </span>
            </span>
            <div style={{ minWidth: 0, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {s.worst
                ? <PlanLimitBars limits={s.worst} now={props.now} lang={props.lang} />
                : t.noMeter}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{s.hidden > 0 ? t.hidden(s.hidden) : t.noneHidden}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
              <StatusDot state={st.dot} />{st.word}
            </div>
          </>
        )}
      >
        {mine.map(a => <AccountRow key={accountKey(a)} a={a} props={props} isMobile={isMobile} />)}
        <div style={{ padding: isMobile ? '10px 14px' : '10px 14px 12px', borderTop: '1px solid var(--border)' }}>
          {props.noSecondAccount?.has(s.harness)
            ? <MetricNote>{t.agy}</MetricNote>
            : props.onAdd && (
              <button type="button" style={dialogButtonStyle('secondary', isMobile)} onClick={() => props.onAdd?.(s.harness)}>
                {t.add}
              </button>
            )}
        </div>
      </Disclosure>
    </div>
  )
}

function AccountRow({ a, props, isMobile }: { a: AccountRowData; props: AccountsViewProps; isMobile: boolean }) {
  const pt = props.lang === 'pt'
  const t = T(pt)
  const label = HARNESS_LABELS[a.harness] ?? a.harness
  const title = accountTitle(a, label, pt)
  const whose = accountWhose(a, pt)
  const unconfirmed = isUnidentified(a)
  const limits = unconfirmed ? null : props.limits?.find(l => l.account === a.id) ?? null
  const busy = props.pendingIds.has(a.id)
  const st = accountState(a)
  const state = st === 'unconfirmed' ? { dot: 'warn' as const, word: t.unconfirmedRow }
    : st === 'signed-out' ? { dot: 'warn' as const, word: t.signedOut }
    : { dot: 'ok' as const, word: t.signedIn }
  return (
    <div data-account-row={accountKey(a)} style={{
      ...(isMobile ? { display: 'flex', flexDirection: 'column', gap: 8 } : { display: 'grid', gridTemplateColumns: '20px minmax(0,1.5fr) minmax(0,1.3fr) 110px 170px', gap: 12, alignItems: 'center' }),
      padding: '12px 14px', borderTop: '1px solid var(--border)',
    }}>
      <button type="button" onClick={() => props.onDetail(a)} style={{
        background: 'none', border: 'none', padding: isMobile ? 0 : '0 0 0 32px', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', minWidth: 0,
        minHeight: isMobile ? 44 : undefined, ...(isMobile ? {} : { gridColumn: '1 / 3' }),
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13, color: 'var(--text-primary)' }}>{title}</b>
          {!unconfirmed && !a.available && !a.retired && <Pill tone="neutral">{t.hiddenChip}</Pill>}
        </span>
        {whose && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)' }}>{whose}</span>}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {a.plan ?? t.noPlan} · <StatusDot state={state.dot} size={7} />{state.word}
        </span>
      </button>
      <div style={{ minWidth: 0, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {limits ? <PlanLimitBars limits={limits} now={props.now} lang={props.lang} /> : t.noMeter}
      </div>
      {unconfirmed
        ? <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', gridColumn: isMobile ? undefined : '4 / 6' }}>{t.unconfirmedNote}</span>
        : isMobile
        ? <RowSwitch on={a.available} onToggle={() => props.onToggle(a)} disabled={busy} label={`${t.agents} · ${title}`} />
        : <div style={{ display: 'flex', gap: 8, alignItems: 'center', gridColumn: '4 / 6' }}>
          <Toggle on={a.available} onToggle={() => props.onToggle(a)} disabled={busy} label={t.toggleAria(title)} />
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t.agents}</span>
        </div>}
      {props.failedIds.has(a.id) && !unconfirmed && (
        <p role="alert" style={{ gridColumn: '1 / -1', margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{t.saveFailed(title)}</p>
      )}
    </div>
  )
}

/** The presentational half: summary rows + in-place expansion. Deterministic, so it is testable. */
export function AccountsView(props: AccountsViewProps) {
  const isMobile = useIsMobile()
  const pt = props.lang === 'pt'
  const [open, setOpen] = useState<HarnessId | null>(props.initialOpen ?? null)
  const summaries = useMemo(
    () => summarizeHarnesses(props.accounts, props.limits, props.now, HARNESS_ORDER, props.failedIds),
    [props.accounts, props.limits, props.now, props.failedIds],
  )
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden', marginBottom: 24 }}>
      {!isMobile && (
        <div style={{ ...grid(false), padding: '8px 14px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', background: 'var(--bg-elevated)' }}>
          <span /><span>{pt ? 'Assistente' : 'Assistant'}</span><span>{pt ? 'Limites do plano' : 'Plan limits'}</span>
          <span>{pt ? 'Visibilidade' : 'Visibility'}</span><span>{pt ? 'Estado' : 'State'}</span>
        </div>
      )}
      {summaries.map(s => (
        <HarnessRow key={s.harness} s={s} open={open === s.harness} isMobile={isMobile} props={props}
          onToggleOpen={() => setOpen(cur => nextOpen(cur, s.harness))} />
      ))}
    </div>
  )
}

interface ApiAccount extends AccountRowData { firstSeen: number; lastSeen: number }

export default function AccountsSection({ lang }: { lang: Lang }) {
  const pt = lang === 'pt'
  const { limits, now } = usePlanLimits()
  const [accounts, setAccounts] = useState<ApiAccount[] | null>(null)
  const [error, setError] = useState(false)
  const [pendingIds, setPending] = useState<Set<string>>(new Set())
  const [failedIds, setFailed] = useState<Set<string>>(new Set())
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [nick, setNick] = useState('')
  const mutator = useRef(createAccountMutator<ApiAccount>((id, body) =>
    fetch(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))).current

  const load = useCallback(() => {
    setError(false)
    fetch('/api/accounts')
      .then(async r => { if (!r.ok) throw new Error('accounts'); return r.json() as Promise<{ accounts: ApiAccount[] }> })
      .then(b => setAccounts(b.accounts))
      .catch(() => setError(true))
  }, [])
  useEffect(() => { load() }, [load])

  const detail = accounts?.find(a => accountKey(a) === detailKey) ?? null
  const detailEditable = detail !== null && !isUnidentified(detail)
  useEffect(() => { setNick(detail?.nickname ?? '') }, [detailKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /** One PATCH at a time per account; a second request for a busy account is dropped, never raced. */
  const patch = async (a: AccountRowData, body: { available?: boolean; nickname?: string }) => {
    if (isUnidentified(a) || mutator.has(a.id)) return
    setPending(h => new Set(h).add(a.id))
    const res = await mutator.patch(a.id, body)
    setPending(h => { const n = new Set(h); n.delete(a.id); return n })
    if (res.status === 'ok') {
      setAccounts(h => (h ?? []).map(x => x.id === a.id ? res.account : x))
      setFailed(h => { const n = new Set(h); n.delete(a.id); return n })
      if (body.nickname !== undefined) setNick(d => reconcileNickname(d, body.nickname!, res.account.nickname))
    } else if (res.status === 'failed') {
      setFailed(h => new Set(h).add(a.id))
    }
  }

  const t = T(pt)

  return (
    <div>
      <SectionHeader label={pt ? 'Contas' : 'Accounts'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'Cada assistente pode ter mais de uma conta logada nesta máquina. Os agentes só usam as contas com “Agentes” ligado — as outras não aparecem para eles, nem no roteamento, nem nos limites. Desligar não desconecta: a conta continua logada e você ainda pode usá-la.'
          : 'Each assistant can have more than one account signed in on this machine. Agents only use accounts with “Agents” on — the others never reach them, routing or the limits. Turning it off does not sign out: the account stays signed in and you can still use it.'}
      </p>
      {error && (
        <p role="alert" style={{ fontSize: 12.5, color: 'var(--accent-red)' }}>
          {pt ? 'Não foi possível ler as contas agora. As suas contas não foram alteradas.' : 'Could not read the accounts right now. Your accounts were not changed.'}{' '}
          <button type="button" style={dialogButtonStyle('secondary', false)} onClick={load}>{pt ? 'Tentar de novo' : 'Try again'}</button>
        </p>
      )}
      {accounts === null && !error && <CenteredLoader placement="area" />}
      {accounts !== null && accounts.length === 0 && (
        <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {pt ? 'Nenhuma conta encontrada ainda — as contas aparecem sozinhas quando você entra num assistente.' : 'No accounts found yet — accounts appear on their own once you sign in to an assistant.'}
        </p>
      )}
      {accounts !== null && accounts.length > 0 && (
        <AccountsView lang={lang} accounts={accounts} limits={limits} now={now} pendingIds={pendingIds} failedIds={failedIds}
          onToggle={a => { void patch(a, { available: !a.available }) }}
          onDetail={a => setDetailKey(accountKey(a))}
          noSecondAccount={new Set<HarnessId>(['antigravity'])} />
      )}
      <Drawer open={detail !== null} lang={lang} onClose={() => setDetailKey(null)}
        title={detail ? accountTitle(detail, HARNESS_LABELS[detail.harness] ?? detail.harness, pt) : ''}
        dirty={detailEditable && nick.trim() !== (detail.nickname ?? '')}
        footer={detail && (
          <DialogActions>
            <button type="button" style={dialogButtonStyle('primary', false)}
              disabled={!detailEditable || pendingIds.has(detail.id) || nick.trim() === (detail.nickname ?? '')}
              onClick={() => { void patch(detail, { nickname: nick.trim() }) }}>{pt ? 'Salvar apelido' : 'Save nickname'}</button>
          </DialogActions>
        )}>
        {detail && (
          <div>
            {detailEditable
              ? <FieldInput label={pt ? 'Apelido' : 'Nickname'} value={nick} onChange={setNick} maxLength={40}
                sub={pt ? 'É só este nome que os agentes veem — nunca o e-mail.' : 'Agents only ever see this name — never the e-mail.'} />
              : <ScopeNote>{t.unconfirmedNote}</ScopeNote>}
            <p style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              {accountWhose({ label: detail.label }, pt) ?? detail.label} · {detail.plan ?? t.noPlan}
              {detail.root ? <><br />{detail.root}</> : null}
            </p>
            {(() => {
              const l = detailEditable ? limits?.find(x => x.account === detail.id) : null
              return l ? <PlanLimitsBlock limits={l} now={now} lang={lang} details /> : null
            })()}
            {detailEditable && <RowSwitch on={detail.available} onToggle={() => { void patch(detail, { available: !detail.available }) }}
              disabled={pendingIds.has(detail.id)} label={t.agents}
              sub={detail.available
                ? (pt ? 'Ligada: entra no roteamento e nos limites que os agentes leem.' : 'On: part of routing and of the limits agents read.')
                : (pt ? 'Desligada: continua logada para você; os agentes não a veem.' : 'Off: still signed in for you; agents do not see it.')} />}
            {failedIds.has(detail.id) && <p role="alert" style={{ fontSize: 12.5, color: 'var(--accent-red)' }}>{t.saveFailed(accountTitle(detail, HARNESS_LABELS[detail.harness] ?? detail.harness, pt))}</p>}
          </div>
        )}
      </Drawer>
    </div>
  )
}
