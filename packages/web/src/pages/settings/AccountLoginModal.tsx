import React, { useEffect, useState } from 'react'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { ConfirmModal, FieldInput, RecordCard, dialogButtonStyle } from './primitives'
import { ADD_COPY, type Lang, type LoginInfoView, type RootRowView } from './addAccountLogic'

export function AccountLoginModal({ harness, lang, login, bound, busy, submitted, error, onSubmit, onCancel }: {
  harness: HarnessId; lang: Lang; login?: LoginInfoView; bound?: RootRowView
  busy: boolean; submitted: boolean; error: string | null
  onSubmit: (code: string) => void; onCancel: () => void
}) {
  const t = ADD_COPY(lang === 'pt'), mobile = useIsMobile()
  const [code, setCode] = useState(''), [copied, setCopied] = useState<string | null>(null), [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const button = (primary = false) => dialogButtonStyle(primary ? 'primary' : 'secondary', mobile)
  const copy = async (value: string, which: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(which) } catch { setCopied(null) }
  }
  const footer = <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
    {!bound && login?.kind === 'paste' && !submitted && <button type="button" disabled={busy || !code.trim()} style={button(true)} onClick={() => { onSubmit(code); setCode('') }}>{t.submit}</button>}
    <button type="button" style={button(!!bound)} onClick={onCancel}>{bound ? t.finish : t.cancelPending}</button>
  </div>
  return <ConfirmModal open tone="default" maxWidth={560} closeLabel={t.close}
    title={t.title(HARNESS_LABELS[harness] ?? harness)} message="" icon={<HarnessMark harness={harness} size={22} />}
    confirmLabel={t.submit} cancelLabel={t.cancelPending} onConfirm={() => {}} onCancel={onCancel} footer={footer}>
    {bound ? <div role="status" data-login-step="done">
      <RecordCard wrapTitle title={t.done} fields={[
        { label: t.account, value: <span style={{ overflowWrap: 'anywhere' }}>{`${HARNESS_LABELS[harness] ?? harness} · ${bound.label ?? t.noPlan}`}</span> },
        { label: t.plan, value: bound.plan ?? t.noPlan },
      ]} />
      <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{t.doneNote}</p>
    </div> : login ? <>
      <div data-login-step="link">
        <div style={{ fontSize: 14, fontWeight: 600 }}>{`1 · ${t.linkStep}`}</div>
        <div data-login-url style={{ display: 'block', width: '100%', minWidth: 0, boxSizing: 'border-box', overflowWrap: 'anywhere', whiteSpace: 'normal', fontFamily: 'monospace', fontSize: 12, padding: '10px 0', textAlign: 'left' }}>{login.url}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <a href={login.url} target="_blank" rel="noopener noreferrer" style={{ ...button(true), textDecoration: 'none' }}>{t.openLink}</a>
          <button type="button" style={button()} onClick={() => { void copy(login.url, 'link') }}>{copied === 'link' ? t.copied : t.copyLink}</button>
        </div>
      </div>
      <div data-login-step={login.kind}>
        {login.kind === 'paste' ? <FieldInput label={`2 · ${t.pasteStep}`} value={code} onChange={setCode} type="password" hideReveal maxLength={8192} autoComplete="off" spellCheck={false} minHeight={mobile ? 44 : undefined} disabled={submitted || busy} /> : <>
          <p style={{ fontSize: 14 }}>{`2 · ${harness === 'kimi' ? t.kimiStep : t.deviceStep}`}</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong style={{ fontFamily: 'monospace', fontSize: 26, letterSpacing: '.12em', overflowWrap: 'anywhere' }}>{login.code}</strong>
            <button type="button" style={button()} onClick={() => { void copy(login.code ?? '', 'code') }}>{copied === 'code' ? t.copied : t.copyCode}</button>
          </div>
        </>}
        {!error && <p role="status" style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{login.kind === 'paste' && !submitted ? t.awaitingCode : t.submitted} {t.expires(Math.max(0, Math.ceil((login.expiresAt - now) / 60000)))}</p>}
      </div>
    </> : !error && <p role="status">{t.workingNote}</p>}
    {error && <p role="alert" style={{ color: 'var(--accent-red)', overflowWrap: 'anywhere' }}>{error}</p>}
  </ConfirmModal>
}
