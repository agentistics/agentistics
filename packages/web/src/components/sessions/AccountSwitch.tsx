/**
 * CONTA.TROCA — continue a session on another account: of its own harness (the same conversation
 * continues) or of another harness (a new conversation there, briefed with a summary — v2).
 *
 * Two entries, ONE dialog: the notice above the composer when the conversation's last turn was
 * refused by the account's usage limit, and "Switch account" in the session's own menu, any time.
 * Both show the SAME picker (CONTA.LIMITES): every account as a "Plan usage" row with its rings, also
 * reachable inline from the session panel's "Usage limits" card. Built from the app's own pieces:
 * `ConfirmModal`, `Checkbox`, `DialogActions`/`dialogButtonStyle` (settings primitives), the plan
 * list's `PlanUsageRowCells`, and the handoff band's notice styling (`handoffWarning.css`).
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Users, X } from 'lucide-react'
import type { PlanLimits } from '@agentistics/core'
import { Checkbox, ConfirmModal, DialogActions, dialogButtonStyle } from '../../pages/settings/primitives'
import { PLAN_ROW_GRID, PlanUsageRowCells } from '../PlanLimitMeter'
import { usePlanLimits, subscriptionName } from '../../lib/planLimits'
import { defaultPick, pickerRows } from '../../lib/accountPicker'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  canSwitch, fetchSwitchInfo, harnessName, noticeTitle, postSwitch, resetPhrase, showLimitNotice, type SwitchInfo,
} from '../../lib/accountSwitch'
import { pushNotification } from '../../lib/notifications'
import './handoffWarning.css'

/** How often an open session asks whether its last turn hit a limit. A transcript tail read. */
const POLL_MS = 15_000

/** The switch info for one session, re-read while it is on screen and the tab is visible. */
export function useSwitchInfo(id: string | undefined, lang: string, enabled = true): [SwitchInfo | null, () => void] {
  const [info, setInfo] = useState<SwitchInfo | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick(t => t + 1), [])
  useEffect(() => {
    setInfo(null)
    if (!id || !enabled) return
    let alive = true
    let t: ReturnType<typeof setInterval> | undefined
    const read = () => {
      if (document.visibilityState === 'hidden') return
      void fetchSwitchInfo(id, lang).then(i => {
        if (!alive) return
        setInfo(i)
        // Multiple accounts off, or a harness that cannot switch: nothing to watch for on this row.
        if (i && !i.supported && t) { clearInterval(t); t = undefined }
      })
    }
    read()
    t = setInterval(read, POLL_MS)
    return () => { alive = false; if (t) clearInterval(t) }
  }, [id, lang, enabled, tick])
  return [info, reload]
}

/**
 * The switch's whole state — the pick, the re-send flag, the call — shared by the dialog (menu +
 * limit notice) and the inline picker in the session panel's "Usage limits" card, so the two can
 * never disagree about what a confirm does.
 */
function useSwitchFlow({ open, sessionId, info, lang, fromLimit, onDone }: {
  open: boolean; sessionId: string; info: SwitchInfo; lang: string; fromLimit: boolean
  onDone: (newId: string | undefined) => void
}) {
  const pt = lang === 'pt'
  const plan = usePlanLimits()
  const rows = pickerRows(info, plan.limits, plan.now, pt ? 'pt' : 'en')
  const [pick, setPick] = useState('')
  const pending = fromLimit ? info.limit?.pendingPreview : undefined
  const [resend, setResend] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Reset on OPEN and when the set of pickable rows really changes — never on a poll that returns the
  // same list as a new array, or the person's pick snaps back to the default while they are choosing.
  const pickable = rows.filter(r => r.kind === 'option').map(r => r.key)
  const optionsKey = pickable.join(',')
  useEffect(() => {
    if (!open) return
    setResend(true); setError(null); setBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open) return
    setPick(p => (p && pickable.includes(p) ? p : defaultPick(rows)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, optionsKey])
  const chosen = rows.find(r => r.key === pick && r.kind === 'option')
  const handoff = !!chosen?.handoff
  const message = !chosen
    ? (pt ? 'Escolha uma conta disponível na lista.' : 'Pick an available account from the list.')
    : handoff
      ? (pt
        ? `Outro harness começa uma conversa NOVA em ${harnessName(chosen.harness)}, na mesma pasta, tarefa e papel, com um resumo desta (objetivo, estado, últimos turnos, arquivos tocados). Esta sessão só é encerrada depois que a nova estiver rodando.`
        : `Another harness starts a NEW conversation on ${harnessName(chosen.harness)}, in the same folder, task and role, briefed with a summary of this one (goal, state, last turns, files touched). This session is ended only once the new one is running.`)
      : (pt
        ? `A sessão é encerrada e a mesma conversa continua na conta ${chosen.label}. A conversa é copiada, não movida: o histórico na conta atual continua lá.`
        : `The session is ended and the same conversation continues on ${chosen.label}. The conversation is copied, not moved: the history on the current account stays there.`)
  async function confirm() {
    if (!chosen) return
    setBusy(true); setError(null)
    const out = await postSwitch(sessionId, chosen.id, !!pending && resend, lang, handoff ? chosen.harness : undefined)
    setBusy(false)
    if (!out.ok) { setError(out.message); return }
    pushNotification({ type: 'success', title: handoff ? (pt ? 'Continuado em outro harness' : 'Continued on another harness') : (pt ? 'Conta trocada' : 'Account switched'), message: out.message })
    onDone(out.id)
  }
  const confirmLabel = busy
    ? (handoff ? (pt ? 'Iniciando…' : 'Starting…') : (pt ? 'Trocando…' : 'Switching…'))
    : (handoff ? (pt ? `Continuar em ${harnessName(chosen?.harness)}` : `Continue on ${harnessName(chosen?.harness)}`) : (pt ? 'Confirmar troca' : 'Confirm switch'))
  return { rows, plan, pick, setPick, chosen, message, pending, resend, setResend, busy, error, confirm, confirmLabel }
}

type SwitchFlow = ReturnType<typeof useSwitchFlow>

/**
 * The picker: every account as a "Plan usage" row (same cells, `PlanUsageRowCells`), the current one
 * marked and not pickable, the ones that cannot be picked dimmed with the reason in words.
 */
export function AccountPicker({ flow, lang }: { flow: SwitchFlow; lang: string }) {
  const pt = lang === 'pt'
  const l = pt ? 'pt' : 'en'
  const chip = (text: string, tone: string) => (
    <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, color: tone, border: `1px solid ${tone}`, whiteSpace: 'nowrap' }}>{text}</span>
  )
  return (
    <div role="radiogroup" aria-label={pt ? 'Contas' : 'Accounts'} data-account-picker style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {flow.rows.map(r => {
        const name = subscriptionName(r.harness as PlanLimits['harness'], r.label || undefined)
        const cells = (
          <PlanUsageRowCells
            harness={r.harness as PlanLimits['harness']} name={name} plan={r.plan} limits={r.limits} now={flow.plan.now} lang={l}
            {...(r.reason ? { note: r.reason } : {})}
            {...(r.kind === 'current' ? { tag: chip(pt ? 'Agora' : 'Current', 'var(--text-secondary)') }
              : r.recommended && r.kind === 'option' ? { tag: chip(pt ? 'com folga' : 'has room', 'var(--accent-green)') } : {})}
          />
        )
        const box: CSSProperties = { ...PLAN_ROW_GRID, padding: '8px 10px', borderRadius: 10, minHeight: 44, boxSizing: 'border-box', width: '100%', border: '1px solid var(--border)', textAlign: 'left', fontFamily: 'inherit', color: 'inherit' }
        if (r.kind !== 'option') {
          return (
            <div key={r.key} data-account-row={r.key} data-account-row-kind={r.kind} aria-disabled
              {...(r.kind === 'current' ? { 'data-account-switch-current': '' } : {})}
              style={{ ...box, background: 'transparent', opacity: r.kind === 'current' ? 0.85 : 0.55 }}>
              {cells}
            </div>
          )
        }
        const on = flow.pick === r.key
        return (
          <button key={r.key} type="button" role="radio" aria-checked={on} data-account-row={r.key} data-account-row-kind="option"
            disabled={flow.busy} onClick={() => flow.setPick(r.key)}
            style={{ ...box, cursor: flow.busy ? 'default' : 'pointer', background: on ? 'var(--anthropic-orange-dim)' : 'var(--ag-tint-2)', borderColor: on ? 'var(--anthropic-orange)' : 'var(--border)' }}>
            {cells}
          </button>
        )
      })}
    </div>
  )
}

/** What sits under the picker on both surfaces: the re-send choice and the server's refusal. */
function SwitchExtras({ flow, lang }: { flow: SwitchFlow; lang: string }) {
  const pt = lang === 'pt'
  return <>
    {flow.pending && (
      <>
        <Checkbox checked={flow.resend} onChange={flow.setResend} label={pt ? 'Reenviar a última mensagem na nova conta' : 'Re-send the last message on the new account'} />
        {flow.resend && (
          <blockquote style={{ margin: 0, padding: '6px 10px', borderLeft: '3px solid var(--border)', color: 'var(--text-secondary)', fontSize: 12, overflowWrap: 'anywhere' }}>
            {flow.pending}
          </blockquote>
        )}
      </>
    )}
    {flow.error && <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--accent-red)', overflowWrap: 'anywhere' }}>{flow.error}</p>}
  </>
}

export function AccountSwitchDialog({ open, sessionId, info, lang, fromLimit, onClose, onSwitched }: {
  open: boolean
  sessionId: string
  info: SwitchInfo
  lang: string
  /** Opened from the limit notice: offers to re-send the refused message. */
  fromLimit: boolean
  onClose: () => void
  /** The NEW session id: the switch retires this row and mints its continuation. */
  onSwitched: (newId: string) => void
}) {
  const pt = lang === 'pt'
  const flow = useSwitchFlow({ open, sessionId, info, lang, fromLimit, onDone: id => { onClose(); if (id) onSwitched(id) } })
  return (
    <ConfirmModal
      open={open}
      tone="default"
      icon={<Users size={18} />}
      title={pt ? 'Continuar em outra conta' : 'Continue on another account'}
      message={flow.message}
      confirmLabel={flow.confirmLabel}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'}
      onConfirm={() => { void flow.confirm() }}
      onCancel={onClose}
      busy={flow.busy || !flow.chosen}
      mobileSheet
      maxWidth={460}
    >
      <div data-account-switch style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
        <AccountPicker flow={flow} lang={lang} />
        <SwitchExtras flow={flow} lang={lang} />
      </div>
    </ConfirmModal>
  )
}

/**
 * CONTA.LIMITES — the session panel's "Usage limits" card. Shows `children` (the plan-usage list)
 * plus a "Switch account in this session" button; the button turns the list into the picker, with
 * "Confirm switch" / "Cancel" under it. Absent button when there is nowhere to go.
 */
export function AccountSwitchInline({ sessionId, lang, onSwitched, children }: {
  sessionId: string; lang: string; onSwitched: (newId: string) => void; children: ReactNode
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [picking, setPicking] = useState(false)
  const [info] = useSwitchInfo(sessionId, lang)
  useEffect(() => { setPicking(false) }, [sessionId])
  if (!picking || !info) {
    return <>
      {children}
      {canSwitch(info) && (
        <button type="button" data-account-switch-open onClick={() => setPicking(true)}
          style={{ ...dialogButtonStyle('secondary', isMobile), width: '100%', marginTop: 8, gap: 8 }}>
          <Users size={15} />{pt ? 'Trocar de conta nesta sessão' : 'Switch account in this session'}
        </button>
      )}
    </>
  }
  return <InlinePicker sessionId={sessionId} info={info} lang={lang} onCancel={() => setPicking(false)} onSwitched={id => { setPicking(false); if (id) onSwitched(id) }} />
}

function InlinePicker({ sessionId, info, lang, onCancel, onSwitched }: { sessionId: string; info: SwitchInfo; lang: string; onCancel: () => void; onSwitched: (id: string | undefined) => void }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const flow = useSwitchFlow({ open: true, sessionId, info, lang, fromLimit: !!info.limit, onDone: onSwitched })
  return (
    <div data-account-switch data-account-switch-inline style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600 }}>{pt ? 'Escolha a conta para esta sessão' : 'Choose the account for this session'}</p>
      <AccountPicker flow={flow} lang={lang} />
      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{flow.message}</p>
      <SwitchExtras flow={flow} lang={lang} />
      <DialogActions>
        <button type="button" onClick={onCancel} disabled={flow.busy} style={dialogButtonStyle('secondary', isMobile, flow.busy)}>{pt ? 'Cancelar' : 'Cancel'}</button>
        <button type="button" data-account-switch-confirm onClick={() => { void flow.confirm() }} disabled={flow.busy || !flow.chosen}
          style={dialogButtonStyle('primary', isMobile, flow.busy || !flow.chosen)}>{flow.confirmLabel}</button>
      </DialogActions>
    </div>
  )
}

/** The notice above the composer. Absent unless the last turn hit a limit AND another account can take it. */
export function AccountLimitBand({ sessionId, lang, onSwitched }: { sessionId: string; lang: string; onSwitched: (newId: string) => void }) {
  const pt = lang === 'pt'
  const [info] = useSwitchInfo(sessionId, lang)
  const [open, setOpen] = useState(false)
  // A dismissal holds for THIS limit only: the next one (a new reset time) shows again. It is kept
  // per session in localStorage so a reload or re-entering the session does not bring it back.
  const key = info?.limit ? `${info.limit.resetsAt ?? ''}:${info.limit.pendingPreview ?? ''}` : ''
  const storeKey = `agentistics.accountLimitDismissed.${sessionId}`
  const [dismissed, setDismissedState] = useState<string | null>(() => {
    try { return localStorage.getItem(storeKey) } catch { return null }
  })
  const setDismissed = (k: string) => {
    setDismissedState(k)
    try { localStorage.setItem(storeKey, k) } catch { /* private mode: the dismissal lasts this view only */ }
  }
  const visible = showLimitNotice(info) && dismissed !== key
  return (
    <>
      <div className={`handoff-band-wrap ${visible ? 'visible' : ''}`} inert={!visible} aria-hidden={!visible} data-account-limit-band>
        <div className="handoff-band-clip">
          <div className="handoff-band" role="status" style={{ '--handoff-tone': 'var(--anthropic-orange)' } as CSSProperties}>
            <div className="handoff-band-copy">
              <strong>{info ? noticeTitle(info, pt) : ''}</strong>
              <span>{[info?.current?.label, resetPhrase(info?.limit?.resetsAt, pt)].filter(Boolean).join(' · ') || (pt ? 'Escolha a conta e o harness para continuar.' : 'Choose the account and harness to carry on.')}</span>
            </div>
            <div className="handoff-actions">
              <button type="button" className="primary" onClick={() => setOpen(true)}>{pt ? 'Continuar na outra conta' : 'Continue on the other account'}</button>
              <button type="button" className="icon" aria-label={pt ? 'Dispensar' : 'Dismiss'} onClick={() => setDismissed(key)}><X size={16} /></button>
            </div>
          </div>
        </div>
      </div>
      {info && <AccountSwitchDialog open={open} sessionId={sessionId} info={info} lang={lang} fromLimit onClose={() => setOpen(false)} onSwitched={onSwitched} />}
    </>
  )
}
