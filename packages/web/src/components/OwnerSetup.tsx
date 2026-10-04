// packages/web/src/components/OwnerSetup.tsx
import React, { useState } from 'react'
import { AlertCircle, ShieldCheck } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { Field } from './Login'
import { PasswordHint } from './PasswordHint'
import { MfaSetup } from './MfaSetup'

/**
 * First-boot owner creation. Requires the one-time setup token printed to the central's logs.
 * Posts /api/iam/bootstrap; on success the server sets the session cookie — but the flow is not
 * over: enrolling the authenticator is part of CREATING the account, not an optional step
 * afterwards, so this renders the mandatory `MfaSetup` overlay next and only calls `onDone` once
 * that finishes (recovery codes shown, and confirmed saved). Without this step the account exists
 * fully privileged and un-recoverable-by-anyone-but-the-host for as long as the owner puts off
 * signing back in — the mandatory gate elsewhere in the app only catches that on the NEXT visit.
 */
export function OwnerSetup({ onDone, lang = 'en' }: { onDone: () => void; lang?: Lang }) {
  const pt = lang === 'pt'
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Flips once the account exists; the MFA step then owns the screen until it finishes.
  const [accountCreated, setAccountCreated] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    if (password !== confirm) { setError(pt ? 'As senhas não coincidem.' : 'Passwords do not match.'); return }
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/iam/bootstrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), name: name.trim(), email: email.trim(), password, confirm }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (res.ok && data.ok) setAccountCreated(true)
      else setError(data.error || (pt ? 'Falha na configuração.' : 'Setup failed.'))
    } catch { setError(pt ? 'Erro de rede — tente de novo.' : 'Network error — try again.') } finally { setSubmitting(false) }
  }

  // The account exists and the session cookie is already set (the bootstrap response set it), so
  // the authenticated /api/iam/mfa/* routes work here. `required` keeps the overlay from being
  // dismissed and `canDisable={false}` matches the server, which refuses DELETE for an owner
  // outright — an owner account is never shown an action the route will not perform.
  if (accountCreated) {
    return <MfaSetup lang={lang} required canDisable={false} onClose={onDone} />
  }

  return (
    <div style={{ minHeight: 'calc(100vh / var(--ag-zoom, 1))', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: 16 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 400, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ display: 'inline-flex', padding: 9, borderRadius: 10, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}><ShieldCheck size={18} /></span>
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Criar conta owner' : 'Create owner account'}</span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '0 0 12px' }}>
          {pt
            ? 'Primeira configuração. Cole o token de configuração único dos logs do central, depois crie a conta owner.'
            : "First-time setup. Paste the one-time setup token from the central's logs, then create the owner account."}
        </p>
        {/* The explicit rule the product owner asked for, stated where the account is created —
            not discovered later as a locked screen. An owner reaches every team's data and every
            admin route, so this is not a suggestion: the next step of THIS SAME flow enrols the
            authenticator, and there is no "skip for now". */}
        <div style={{
          fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)',
          background: 'var(--anthropic-orange-dim)', border: '1px solid var(--anthropic-orange)44',
          borderRadius: 8, padding: '9px 11px', margin: '0 0 18px',
        }}>
          {pt
            ? <>Contas <b>owner</b> exigem um app autenticador (verificação em duas etapas). Depois de criar a conta, você vai registrar o autenticador e <b>guardar os códigos de recuperação</b> — eles são a única forma de recuperar esta conta, já que ela <b>não pode ser recuperada por e-mail</b>. Não é possível pular esta etapa.</>
            : <>Owner accounts require an authenticator app (two-factor verification). After the account is created you will enrol the authenticator and <b>save the recovery codes</b> — they are the only way to recover this account, since it <b>cannot be recovered by e-mail</b>. This step cannot be skipped.</>}
        </div>
        <Field label={pt ? 'Token de configuração' : 'Setup token'} type="text" value={token} onChange={setToken} disabled={submitting} />
        <Field label={pt ? 'Nome' : 'Name'} type="text" value={name} onChange={setName} disabled={submitting} />
        <Field label="Email" type="email" value={email} onChange={setEmail} disabled={submitting} />
        <Field label={pt ? 'Senha' : 'Password'} type="password" value={password} onChange={setPassword} disabled={submitting} />
        <PasswordHint value={password} lang={lang} />
        <Field label={pt ? 'Confirmar senha' : 'Confirm password'} type="password" value={confirm} onChange={setConfirm} disabled={submitting} />
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 12 }}>
            <AlertCircle size={13} /> {error}
          </div>
        )}
        <button type="submit" disabled={submitting || !token.trim() || !name.trim() || !email.trim() || password.length < 8 || password !== confirm}
          style={{ width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: (submitting || !token.trim() || !name.trim() || !email.trim() || password.length < 8 || password !== confirm) ? 0.6 : 1 }}>
          {submitting ? (pt ? 'Criando…' : 'Creating…') : (pt ? 'Criar owner e continuar' : 'Create owner & continue')}
        </button>
      </form>
    </div>
  )
}
