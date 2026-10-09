// packages/web/src/components/ChangePasswordSelf.tsx
import React, { useState, useRef, useEffect } from 'react'
import { AlertCircle, KeyRound, X, CheckCircle } from 'lucide-react'
import type { Lang } from '@agentistics/core'
function Field({ label, type, value, onChange, inputRef, disabled }: { label: string; type: string; value: string; onChange: (value: string) => void; inputRef?: React.RefObject<HTMLInputElement | null>; disabled?: boolean }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>{label}<input ref={inputRef} type={type} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13 }} /></label>
}
import { PasswordHint } from './PasswordHint'
import { stepUpFetch } from '../lib/stepup'

/** Self-service, dismissible change-password modal (requires the current password, and — through
 *  `stepUpFetch` — a fresh step-up grant: for an MFA-enrolled account that means the CODE, which
 *  is the whole point of gating this route. A thief holding the browser profile usually holds the
 *  password too).
 *  Posts /api/iam/change-password { currentPassword, newPassword }; the server re-issues the
 *  session cookie, so no reload is needed. Escape / backdrop / close button dismiss it. */
export function ChangePasswordSelf({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const pt = lang === 'pt'
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tooShort = password.length < 8
  const mismatch = confirm.length > 0 && password !== confirm
  const disabled = submitting || done || current.length === 0 || tooShort || password !== confirm

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (disabled) return
    setSubmitting(true); setError(null)
    try {
      const res = await stepUpFetch('/api/iam/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: password }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (res.ok && data.ok) {
        setDone(true)
        setTimeout(onClose, 1200)
      } else setError(data.error || `HTTP ${res.status}`)
    } catch { setError(pt ? 'Erro de rede — tente novamente.' : 'Network error — try again.') }
    finally { setSubmitting(false) }
  }

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)', padding: 16 }}>
      <form onSubmit={submit} onMouseDown={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 380, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, boxShadow: '0 12px 40px rgba(0,0,0,0.35)', position: 'relative' }}>
        <button type="button" onClick={onClose} aria-label={pt ? 'Fechar' : 'Close'}
          style={{ position: 'absolute', top: 14, right: 14, display: 'inline-flex', padding: 6, borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)' }}>
          <X size={16} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ display: 'inline-flex', padding: 9, borderRadius: 10, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}><KeyRound size={18} /></span>
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Trocar senha' : 'Change password'}</span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '0 0 18px' }}>
          {pt
            ? 'Informe sua senha atual e escolha uma nova.'
            : 'Enter your current password and choose a new one.'}
        </p>
        {done ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--anthropic-orange)', padding: '10px 0' }}>
            <CheckCircle size={16} /> {pt ? 'Senha atualizada.' : 'Password updated.'}
          </div>
        ) : (
          <>
            <Field label={pt ? 'Senha atual' : 'Current password'} type="password" value={current} onChange={setCurrent} inputRef={ref} disabled={submitting} />
            <Field label={pt ? 'Nova senha' : 'New password'} type="password" value={password} onChange={setPassword} disabled={submitting} />
            <PasswordHint value={password} lang={lang} />
            <Field label={pt ? 'Confirmar senha' : 'Confirm password'} type="password" value={confirm} onChange={setConfirm} disabled={submitting} />
            {(mismatch || error) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 12 }}>
                <AlertCircle size={13} /> {mismatch ? (pt ? 'As senhas não coincidem.' : 'Passwords do not match.') : error}
              </div>
            )}
            <button type="submit" disabled={disabled}
              style={{ width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: disabled ? 'var(--bg-elevated)' : 'var(--anthropic-orange-dim)', color: disabled ? 'var(--text-tertiary)' : 'var(--anthropic-orange)', fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit' }}>
              {submitting ? (pt ? 'Salvando…' : 'Saving…') : (pt ? 'Salvar' : 'Save')}
            </button>
          </>
        )}
      </form>
    </div>
  )
}
