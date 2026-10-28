import React, { useEffect, useState } from 'react'
import { AlertCircle, Check, ExternalLink, Loader2, X } from 'lucide-react'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { ConfirmModal, DialogActions, FieldInput, dialogButtonStyle } from './primitives'
import { ADD_COPY, pendingCardState, type Lang, type LoginInfoView, type RootRowView } from './addAccountLogic'

type StepState = 'todo' | 'active' | 'done'

/** One numbered step: a badge, a short title and whatever that step asks for. */
function Step({ n, state, title, note, last, children }: {
  n: number; state: StepState; title: string; note?: string; last?: boolean; children?: React.ReactNode
}) {
  const on = state === 'active'
  return <div data-step={n} data-step-state={state} style={{ display: 'flex', gap: 12 }}>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
      <span aria-hidden style={{
        width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12.5, fontWeight: 700, boxSizing: 'border-box',
        border: `1.5px solid ${state === 'todo' ? 'var(--border)' : 'var(--anthropic-orange)'}`,
        background: state === 'done' ? 'var(--anthropic-orange)' : on ? 'var(--anthropic-orange-dim)' : 'transparent',
        color: state === 'done' ? '#fff' : on ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
      }}>{state === 'done' ? <Check size={14} strokeWidth={3} /> : n}</span>
      {!last && <span aria-hidden style={{ flex: 1, width: 1.5, minHeight: 12, marginTop: 4, background: state === 'done' ? 'var(--anthropic-orange)' : 'var(--border)' }} />}
    </div>
    <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '26px', color: state === 'todo' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{title}</div>
      {note && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{note}</div>}
      {children && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  </div>
}

const Spin = ({ size = 15 }: { size?: number }) => <Loader2 size={size} aria-hidden style={{ animation: 'ag-working-spin 1s linear infinite', flexShrink: 0 }} />

export function AccountLoginModal({ harness, lang, login, bound, busy, submitted, error, expired = false, onSubmit, onCancel, onRetry, onVerify, errorCode }: {
  harness: HarnessId; lang: Lang; login?: LoginInfoView; bound?: RootRowView
  busy: boolean; submitted: boolean; error: string | null
  /** The attempt is over (timed out, failed, or the server dropped it): only "Try again" moves on. */
  expired?: boolean
  onSubmit: (code: string) => void; onCancel: () => void; onRetry?: () => void; onVerify?: () => void; errorCode?: string
}) {
  const t = ADD_COPY(lang === 'pt'), mobile = useIsMobile(), name = HARNESS_LABELS[harness] ?? harness
  const [code, setCode] = useState(''), [copied, setCopied] = useState(false), [opened, setOpened] = useState(false), [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer) }, [copied])
  const button = (kind: 'primary' | 'secondary', disabled = false) => dialogButtonStyle(kind, mobile, disabled)
  const send = () => { onSubmit(code); setCode('') }
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); setCopied(true) } catch { setCopied(false) } }
  const paste = login?.kind === 'paste'
  const canSend = !busy && !submitted && !!code.trim()
  const minutes = login ? Math.max(0, Math.ceil((login.expiresAt - now) / 60000)) : 0
  // Which step is current: the link until it was opened or copied, then the code, then the wait.
  const step1: StepState = bound || opened || submitted ? 'done' : 'active'
  const step2: StepState = bound || submitted ? 'done' : opened ? 'active' : 'todo'
  const step3: StepState = bound ? 'done' : submitted || (!paste && opened) ? 'active' : 'todo'
  const cancelLink = <button type="button" onClick={onCancel} style={{
    background: 'transparent', border: '1px solid transparent', padding: mobile ? '12px 4px' : '8px 4px', minHeight: mobile ? 44 : undefined,
    color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3,
  }}>{t.cancelPending}</button>
  const footer = bound
    ? <DialogActions><button type="button" style={button('primary')} onClick={onCancel}>{t.finish}</button></DialogActions>
    : errorCode === 'login_unreadable'
      ? <DialogActions start={cancelLink}><button type="button" data-login-verify style={button('primary', busy)} disabled={busy} onClick={onVerify}>{busy ? <Spin /> : t.verifyAgain}</button></DialogActions>
    : expired
      ? <DialogActions start={cancelLink}><button type="button" data-login-retry style={button('primary')} onClick={onRetry}>{t.retry}</button></DialogActions>
      : <DialogActions>{cancelLink}</DialogActions>
  const status = (icon: React.ReactNode, text: string, tone: 'muted' | 'error' = 'muted', role: 'status' | 'alert' = 'status') =>
    <div role={role} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: tone === 'error' ? 'var(--accent-red)' : 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
      {icon && <span style={{ display: 'inline-flex', marginTop: 1 }}>{icon}</span>}<span>{text}</span>
    </div>
  return <ConfirmModal open tone="default" maxWidth={520} closeLabel={t.close}
    title={t.title(name)} message="" icon={<HarnessMark harness={harness} size={22} />}
    confirmLabel={t.submit} cancelLabel={t.cancelPending} onConfirm={() => {}} onCancel={onCancel} footer={footer}>
    {bound ? <div role="status" data-login-step="done" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '4px 0' }}>
      <span aria-hidden style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--anthropic-orange)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Check size={18} strokeWidth={3} /></span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{t.done}</div>
        <div style={{ fontSize: 14, marginTop: 4, overflowWrap: 'anywhere' }}>{`${name} · ${bound.label ?? t.noPlan}`}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{`${t.plan}: ${bound.plan ?? t.noPlan}`}</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '10px 0 0' }}>{t.doneNote}</p>
      </div>
    </div> : expired ? <div data-login-step="expired" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '4px 0' }}>
      <AlertCircle size={22} aria-hidden style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
      <div role="alert" style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{t.expired}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, overflowWrap: 'anywhere' }}>{error ?? t.expiredNote}</div>
      </div>
    </div> : login ? <div style={{ paddingTop: 4 }}>
      <Step n={1} state={step1} title={t.stepOpen} note={t.stepOpenNote}>
        <div data-login-step="link" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flexDirection: mobile ? 'column' : 'row' }}>
          <a data-login-url href={login.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}
            style={{ ...button(step1 === 'active' ? 'primary' : 'secondary'), textDecoration: 'none' }}><ExternalLink size={14} aria-hidden />{t.openLink}</a>
          <button type="button" style={button('secondary')} onClick={() => { setOpened(true); void copy(login.url) }}>{copied ? <><Check size={14} aria-hidden />{t.copied}</> : t.copyLink}</button>
        </div>
      </Step>
      <Step n={2} state={step2} title={paste ? t.stepPaste : t.stepDevice} note={paste ? t.pasteStep : (harness === 'kimi' ? t.kimiStep : t.deviceStep)}>
        <div data-login-step={login.kind}>
          {paste ? <div onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && canSend) { e.preventDefault(); send() } }}
            style={{ display: 'flex', gap: 8, alignItems: mobile ? 'stretch' : 'center', flexDirection: mobile ? 'column' : 'row' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <FieldInput label={t.pasteStep} hideLabel value={code} onChange={setCode} type="text" masked mono maxLength={8192} autoComplete="one-time-code" spellCheck={false} minHeight={mobile ? 44 : 36} disabled={submitted || busy} />
            </div>
            <button type="button" disabled={!canSend} style={{ ...button(step2 === 'active' ? 'primary' : 'secondary', !canSend), minHeight: mobile ? 44 : 36 }} onClick={send}>{t.submit}</button>
          </div> : <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong style={{ fontFamily: 'monospace', fontSize: 24, letterSpacing: '.12em', overflowWrap: 'anywhere' }}>{login.code}</strong>
            <button type="button" style={button('secondary')} onClick={() => { void copy(login.code ?? '') }}>{t.copyCode}</button>
          </div>}
        </div>
      </Step>
      <Step n={3} state={step3} title={t.stepDone} last>
        {error ? status(<AlertCircle size={15} />, error, 'error', 'alert')
          : status(submitted || (!paste && opened) ? <Spin /> : null,
            `${paste && !submitted ? t.awaitingCode : t.submitted} ${t.expires(minutes)}`)}
      </Step>
    </div> : error ? status(<AlertCircle size={15} />, error, 'error', 'alert') : status(<Spin />, t.workingNote)}
  </ConfirmModal>
}

/** A sign-in still waiting in Settings: one row, the status in words with an icon, ONE primary action
 *  (continue a live sign-in, or start again when it can no longer finish) and Cancel as a quiet ×. */
export function PendingLoginCard({ row, lang, mobile, own, busy, onResume, onRetry, onCancel }: {
  row: RootRowView; lang: Lang; mobile: boolean; own: boolean; busy: boolean
  onResume: () => void; onRetry: () => void; onCancel: () => void
}) {
  const t = ADD_COPY(lang === 'pt'), state = pendingCardState(row), name = HARNESS_LABELS[row.harness] ?? row.harness
  const cancel = <button type="button" aria-label={t.cancelAria(name)} title={t.cancelPending} disabled={busy} onClick={onCancel}
    style={{ width: mobile ? 44 : 32, height: mobile ? 44 : 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: 'transparent', border: '1px solid transparent', color: 'var(--text-secondary)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.45 : 1, flexShrink: 0 }}><X size={mobile ? 18 : 16} /></button>
  return <div data-pending-card={state} style={{
    display: 'flex', alignItems: mobile ? 'stretch' : 'center', flexDirection: mobile ? 'column' : 'row', gap: mobile ? 10 : 12,
    padding: '12px 14px', marginBottom: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
      <HarnessMark harness={row.harness} size={20} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 2, color: state === 'expired' ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
          {state === 'expired' ? <AlertCircle size={13} aria-hidden /> : <Spin size={13} />}
          {state === 'expired' ? t.expired : t.waiting}
        </div>
      </div>
      {mobile && !own && cancel}
    </div>
    {!own && <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <button type="button" style={dialogButtonStyle('primary', mobile, busy)} disabled={busy} onClick={state === 'live' ? onResume : onRetry}>{state === 'live' ? t.continueLogin : t.retry}</button>
      {!mobile && cancel}
    </div>}
  </div>
}
