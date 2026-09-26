import React, { useState, useRef, useEffect } from 'react'
import { AlertCircle, ShieldCheck } from 'lucide-react'
import { brandAsset, isCentralShell } from '../lib/brand'
import { Revealable, REVEAL_PAD } from './PasswordReveal'
import { RecoverPassword } from './RecoverPassword'

/** Central account login (email + password). Posts /api/iam/login; the server sets the session cookie. */
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<'wrong' | 'network' | 'rate' | null>(null)
  /** Set when the password stage succeeded but a second factor is still owed. */
  const [challenge, setChallenge] = useState<string | null>(null)
  const [recovering, setRecovering] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password || submitting) return
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/iam/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      if (res.status === 429) { setError('rate'); return }
      const data = (await res.json()) as { ok: boolean; mfaRequired?: boolean; challenge?: string }
      if (data.mfaRequired && data.challenge) { setChallenge(data.challenge); return }
      if (res.ok && data.ok) onAuthed()
      else setError('wrong')
    } catch { setError('network') } finally { setSubmitting(false) }
  }

  if (recovering) {
    return <RecoverPassword onDone={() => { setRecovering(false); setPassword('') }} onCancel={() => setRecovering(false)} />
  }

  if (challenge) {
    return <MfaChallenge challenge={challenge} onAuthed={onAuthed} onCancel={() => { setChallenge(null); setPassword('') }} />
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: 16 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 360, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          {/* The product's own mark — teal on a central — instead of a generic sign-in glyph. */}
          <img src={brandAsset('/minimalistLogo.png')} alt="" aria-hidden="true" style={{ width: 36, height: 36, objectFit: 'contain', display: 'block' }} />
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{isCentralShell() ? 'agentistics central' : 'agentistics'}</span>
        </div>
        <Field label="Email" type="email" value={email} onChange={setEmail} inputRef={ref} disabled={submitting} />
        <Field label="Password" type="password" value={password} onChange={setPassword} disabled={submitting} />
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 12 }}>
            <AlertCircle size={13} /> {
              error === 'wrong' ? 'Invalid email or password.'
                : error === 'rate' ? 'Too many attempts — wait a few minutes and try again.'
                  : 'Network error — try again.'
            }
          </div>
        )}
        <button type="submit" disabled={!email.trim() || !password || submitting}
          style={{ width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: (!email.trim() || !password || submitting) ? 'var(--bg-elevated)' : 'var(--anthropic-orange-dim)', color: (!email.trim() || !password || submitting) ? 'var(--text-tertiary)' : 'var(--anthropic-orange)', fontSize: 13, fontWeight: 600, cursor: (!email.trim() || !password || submitting) ? 'default' : 'pointer', fontFamily: 'inherit' }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" onClick={() => setRecovering(true)}
          style={{ width: '100%', marginTop: 10, padding: '6px 14px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
          Forgot your password?
        </button>
      </form>
    </div>
  )
}

/**
 * Second login stage. The password already verified; this exchanges the server's short-lived
 * challenge for a session by proving the second factor. A recovery code is accepted in the same
 * field — the server tries TOTP first, then burns a recovery code.
 */
function MfaChallenge({ challenge, onAuthed, onCancel }: {
  challenge: string; onAuthed: () => void; onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<'wrong' | 'expired' | 'rate' | 'network' | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!code.trim() || submitting) return
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/iam/login/mfa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code: code.trim() }),
      })
      if (res.status === 429) { setError('rate'); return }
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (res.ok && data.ok) onAuthed()
      else setError(data.error === 'challenge expired' ? 'expired' : 'wrong')
    } catch { setError('network') } finally { setSubmitting(false) }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: 16 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 360, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ display: 'inline-flex', padding: 9, borderRadius: 10, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}><ShieldCheck size={18} /></span>
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Two-factor</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
          Enter the 6-digit code from your authenticator app, or a recovery code.
        </div>
        <Field label="Code" type="text" value={code} onChange={setCode} inputRef={ref} disabled={submitting} />
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 12 }}>
            <AlertCircle size={13} /> {
              error === 'wrong' ? 'Invalid code.'
                : error === 'expired' ? 'Challenge expired — sign in again.'
                  : error === 'rate' ? 'Too many attempts — wait a few minutes.'
                    : 'Network error — try again.'
            }
          </div>
        )}
        <button type="submit" disabled={!code.trim() || submitting}
          style={{ width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: (!code.trim() || submitting) ? 'var(--bg-elevated)' : 'var(--anthropic-orange-dim)', color: (!code.trim() || submitting) ? 'var(--text-tertiary)' : 'var(--anthropic-orange)', fontSize: 13, fontWeight: 600, cursor: (!code.trim() || submitting) ? 'default' : 'pointer', fontFamily: 'inherit' }}>
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
        <button type="button" onClick={onCancel}
          style={{ width: '100%', marginTop: 8, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
          Back
        </button>
      </form>
    </div>
  )
}

/** Shared labelled input used by Login + OwnerSetup + both change-password flows. */
export function Field({ label, type, value, onChange, inputRef, disabled }: {
  label: string; type: string; value: string; onChange: (v: string) => void
  inputRef?: React.RefObject<HTMLInputElement | null>; disabled?: boolean
}) {
  // A password field gets a reveal: these forms are where a typo costs the most (owner setup
  // confirms a password you will need to sign in with, and a wrong one is only discovered later).
  const isPassword = type === 'password'
  const [shown, setShown] = useState(false)
  const effectiveType = isPassword && shown ? 'text' : type
  const field = (
    <input ref={inputRef} type={effectiveType} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 11px', paddingRight: isPassword ? REVEAL_PAD : 11, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit' }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
      onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }} />
  )
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: 5 }}>{label}</div>
      {isPassword
        ? <Revealable shown={shown} onToggle={() => setShown(v => !v)}>{field}</Revealable>
        : field}
    </div>
  )
}
