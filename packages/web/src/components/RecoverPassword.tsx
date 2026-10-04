import React, { useState } from 'react'
import { AlertCircle, KeyRound, MailQuestion } from 'lucide-react'
import { Field } from './Login'
import { PasswordHint } from './PasswordHint'

/**
 * "Forgot my password", for an owner.
 *
 * There is no e-mail step and no link: a self-hosted central has no mail server, so the proof is
 * something the owner already holds — a live authenticator code, or one of the single-use
 * recovery codes issued when they enrolled. Both go in the same field; the server tries the
 * authenticator first and burns a recovery code only if that fails.
 *
 * The server answers identically for an unknown e-mail, a non-owner account and a wrong code, so
 * this screen must not try to be more specific than it is — the one exception is a clock skew,
 * which is the failure a user cannot otherwise diagnose.
 */
export function RecoverPassword({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [asking, setAsking] = useState(false)
  if (asking) return <RequestReset onBack={() => setAsking(false)} onCancel={onCancel} />
  return <OwnerRecovery onDone={onDone} onCancel={onCancel} onAsk={() => setAsking(true)} />
}

function OwnerRecovery({ onDone, onCancel, onAsk }: { onDone: () => void; onCancel: () => void; onAsk: () => void }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState<number | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/iam/recover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim(), newPassword: password }),
      })
      if (res.status === 429) { setError('Too many attempts — wait a few minutes and try again.'); return }
      const d = (await res.json()) as { ok?: boolean; error?: string; skewSeconds?: number; usedRecovery?: boolean; recoveryCodesLeft?: number }
      if (res.ok && d.ok) {
        if (d.usedRecovery) setLeft(d.recoveryCodesLeft ?? null)
        else return onDone()
        return
      }
      if (d.error === 'clock_skew' && typeof d.skewSeconds === 'number') {
        const mins = Math.max(1, Math.round(Math.abs(d.skewSeconds) / 60))
        setError(`The code is right, but this server's clock is ~${mins} min ${d.skewSeconds > 0 ? 'behind' : 'ahead of'} your device. Fix the server clock, or use a recovery code.`)
      } else {
        setError(d.error && d.error !== 'invalid email or code' ? d.error : 'That e-mail and code do not match an owner account.')
      }
    } catch { setError('Network error — try again.') } finally { setSubmitting(false) }
  }

  // A burned recovery code deserves a beat of its own: the count left is the only warning anyone
  // gets before the last one goes.
  if (left !== null) {
    return (
      <Shell>
        <Head icon={<KeyRound size={18} />} title="Password changed" />
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '10px 0 16px', lineHeight: 1.6 }}>
          A recovery code was used, so it no longer works. You have <b>{left}</b> left — generate a
          fresh set from the two-factor settings once you are back in.
        </div>
        <Primary onClick={onDone}>Sign in</Primary>
      </Shell>
    )
  }

  return (
    <Shell onSubmit={submit}>
      <Head icon={<KeyRound size={18} />} title="Recover your account" />
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '8px 0 16px', lineHeight: 1.6 }}>
        Owner accounts recover with their second factor. Enter the 6-digit code from your
        authenticator, or one of your recovery codes.
      </div>
      <Field label="Email" type="email" value={email} onChange={setEmail} disabled={submitting} />
      <Field label="Authenticator or recovery code" type="text" value={code} onChange={setCode} disabled={submitting} />
      <Field label="New password" type="password" value={password} onChange={setPassword} disabled={submitting} />
      <PasswordHint value={password} />
      <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm} disabled={submitting} />
      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 12, lineHeight: 1.5 }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} /> {error}
        </div>
      )}
      <Primary disabled={!email.trim() || !code.trim() || !password || submitting}>
        {submitting ? 'Checking…' : 'Set new password'}
      </Primary>
      <button type="button" onClick={onCancel}
        style={{ width: '100%', marginTop: 8, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
        Back to sign in
      </button>
      <button type="button" onClick={onAsk}
        style={{ width: '100%', marginTop: 12, padding: '6px 14px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
        No authenticator? Ask an admin to reset it
      </button>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 12, lineHeight: 1.6 }}>
        Lost the authenticator <i>and</i> the recovery codes? An owner's password can still be
        reset from the machine itself with <code>agentop central reset-password</code>.
      </div>
    </Shell>
  )
}

function Shell({ children, onSubmit }: { children: React.ReactNode; onSubmit?: (e: React.FormEvent) => void }) {
  const inner = (
    <div style={{ width: '100%', maxWidth: 360, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
      {children}
    </div>
  )
  return (
    <div style={{ minHeight: 'calc(100vh / var(--ag-zoom, 1))', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: 16 }}>
      {onSubmit ? <form onSubmit={onSubmit} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>{inner}</form> : inner}
    </div>
  )
}

function Head({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <span style={{ display: 'inline-flex', padding: 9, borderRadius: 10, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}>{icon}</span>
      <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
    </div>
  )
}

function Primary({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button type={onClick ? 'button' : 'submit'} onClick={onClick} disabled={disabled}
      style={{ width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: disabled ? 'var(--bg-elevated)' : 'var(--anthropic-orange-dim)', color: disabled ? 'var(--text-tertiary)' : 'var(--anthropic-orange)', fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit' }}>
      {children}
    </button>
  )
}

/**
 * The member's side: ask the people who can already reset this account to do it.
 *
 * It grants nothing, so it can afford to be friendly — and it must not be more informative than
 * it is: the server answers the same whether or not the address has an account, and this screen
 * says the same back. Telling the visitor "no such user" would turn the form into a directory.
 */
function RequestReset({ onBack, onCancel }: { onBack: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || submitting) return
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/iam/reset-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), reason: reason.trim() || undefined }),
      })
      if (res.status === 429) { setError('Too many requests — wait a few minutes and try again.'); return }
      setSent(true)
    } catch { setError('Network error — try again.') } finally { setSubmitting(false) }
  }

  if (sent) {
    return (
      <Shell>
        <Head icon={<MailQuestion size={18} />} title="Request sent" />
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '10px 0 16px', lineHeight: 1.6 }}>
          If that address has an account, the people who can reset it now see your request. They
          will give you a temporary password — you will be asked to choose a new one when you
          sign in with it.
        </div>
        <Primary onClick={onCancel}>Back to sign in</Primary>
      </Shell>
    )
  }

  return (
    <Shell onSubmit={submit}>
      <Head icon={<MailQuestion size={18} />} title="Ask for a reset" />
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '8px 0 16px', lineHeight: 1.6 }}>
        An owner — or a manager of your team — can reset your password. This tells them you need it.
      </div>
      <Field label="Email" type="email" value={email} onChange={setEmail} disabled={submitting} />
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: 5 }}>
          Reason (optional)
        </div>
        <textarea value={reason} onChange={e => setReason(e.target.value.slice(0, 280))} disabled={submitting}
          rows={3} placeholder="New phone, lost the codes…"
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 11px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', resize: 'vertical' }} />
        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 4 }}>{reason.length}/280</div>
      </div>
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 12 }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}
      <Primary disabled={!email.trim() || submitting}>{submitting ? 'Sending…' : 'Send request'}</Primary>
      <button type="button" onClick={onBack}
        style={{ width: '100%', marginTop: 8, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
        Back
      </button>
    </Shell>
  )
}
