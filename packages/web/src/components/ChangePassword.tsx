// packages/web/src/components/ChangePassword.tsx
import React, { useState, useRef, useEffect } from 'react'
import { AlertCircle, KeyRound } from 'lucide-react'
function Field({ label, type, value, onChange, inputRef, disabled }: { label: string; type: string; value: string; onChange: (value: string) => void; inputRef?: React.RefObject<HTMLInputElement | null>; disabled?: boolean }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>{label}<input ref={inputRef} type={type} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13 }} /></label>
}
import { PasswordHint } from './PasswordHint'
import { stepUpFetch } from '../lib/stepup'

/** Blocking first-login password change (mustChangePassword). Forced flow — the server does not
 *  require the current password in the BODY, but the route is step-up-protected, so the change is
 *  still proven with the temporary password (or the second factor) through `stepUpFetch`. `App`
 *  mounts `StepUpPrompt` beside this screen for exactly that: it is returned before the app tree
 *  that normally carries the prompter. Posts /api/iam/change-password; the server re-issues the
 *  cookie.
 *  `onDone` re-runs the IAM gate (used both after a successful change and after logout). */
export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  async function logout() {
    if (loggingOut) return
    setLoggingOut(true)
    try { await fetch('/api/iam/logout', { method: 'POST' }) } catch { /* ignore */ }
    onDone() // re-runs reloadIam → not authed → Login screen
  }

  const tooShort = password.length < 8
  const mismatch = confirm.length > 0 && password !== confirm
  const disabled = submitting || tooShort || password !== confirm

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (disabled) return
    setSubmitting(true); setError(null)
    try {
      const res = await stepUpFetch('/api/iam/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (res.ok && data.ok) onDone()
      else setError(data.error || `HTTP ${res.status}`)
    } catch { setError('Network error — try again.') } finally { setSubmitting(false) }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: 16 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 380, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ display: 'inline-flex', padding: 9, borderRadius: 10, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}><KeyRound size={18} /></span>
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Set a new password</span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '0 0 18px' }}>
          Your account was created with a temporary password. Choose a new one to continue.
        </p>
        <Field label="New password" type="password" value={password} onChange={setPassword} inputRef={ref} disabled={submitting} />
        <PasswordHint value={password} />
        <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm} disabled={submitting} />
        {(mismatch || error) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 12 }}>
            <AlertCircle size={13} /> {mismatch ? 'Passwords do not match.' : error}
          </div>
        )}
        <button type="submit" disabled={disabled}
          style={{ width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: disabled ? 'var(--bg-elevated)' : 'var(--anthropic-orange-dim)', color: disabled ? 'var(--text-tertiary)' : 'var(--anthropic-orange)', fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit' }}>
          {submitting ? 'Saving…' : 'Save & continue'}
        </button>
        <button type="button" onClick={() => void logout()} disabled={loggingOut}
          style={{ width: '100%', marginTop: 10, padding: '8px 14px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 12.5, fontWeight: 600, cursor: loggingOut ? 'default' : 'pointer', fontFamily: 'inherit' }}>
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </form>
    </div>
  )
}
