import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert, AlertCircle } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { setStepUpPrompter } from '../lib/stepup'
import type { StepUpAsk } from '../lib/stepup'
import { useIsMobile } from '../hooks/useIsMobile'
import { Revealable, REVEAL_PAD } from './PasswordReveal'
import { useEscapeOwner } from '../lib/overlayStack'

/**
 * Re-authentication dialog for destructive operations. Mounted once by App; `stepUpFetch`
 * opens it on demand through the prompter registered here, so no call site has to know it
 * exists — they just use stepUpFetch instead of fetch.
 *
 * The FACTOR is not the user's choice: once an account has a second factor enrolled the server
 * takes nothing else, so the dialog opens straight into code mode and does not offer a password
 * it knows will be refused. A refused answer reopens the dialog saying so — closing silently on
 * a 401 is what made this look like a button that does nothing.
 */
export function StepUpPrompt({ lang }: { lang: Lang }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [useCode, setUseCode] = useState(false)
  // Enrolled: the password is not an option here, so the "use password instead" escape is hidden.
  const [codeOnly, setCodeOnly] = useState(false)
  const [shown, setShown] = useState(false)
  const [error, setError] = useState(false)
  const resolver = useRef<((v: { password?: string; code?: string } | null) => void) | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const finish = useCallback((v: { password?: string; code?: string } | null) => {
    resolver.current?.(v)
    resolver.current = null
    setOpen(false)
    setValue('')
    setError(false)
  }, [])

  useEffect(() => {
    setStepUpPrompter((ask: StepUpAsk) => new Promise(resolve => {
      resolver.current = resolve
      setCodeOnly(ask.needsCode)
      setUseCode(ask.needsCode)
      setError(ask.retry)
      setValue('')
      setOpen(true)
      setTimeout(() => inputRef.current?.focus(), 50)
    }))
    return () => setStepUpPrompter(null)
  }, [])

  // A cancelled dialog must resolve, or the awaiting request would hang forever.
  useEscapeOwner(open, () => finish(null))

  if (!open) return null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    finish(useCode ? { code: value.trim() } : { password: value })
  }

  // Portalled to <body>: a z-index only competes INSIDE its stacking context, so rendering in
  // place left this at the mercy of whatever positioned ancestor happened to enclose it. The
  // portal is what makes the z-index below mean what it says.
  return createPortal(
    <div onClick={() => finish(null)} style={overlay}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ display: 'inline-flex', padding: 8, borderRadius: 9, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}>
            <ShieldAlert size={16} />
          </span>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Confirme que é você' : 'Confirm it is you'}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 14px' }}>
          {codeOnly
            ? (pt
              ? 'Esta ação apaga dados ou emite uma credencial. Confirme com o código do autenticador — ou um código de recuperação, se você não tiver o aplicativo.'
              : 'This action deletes data or mints a credential. Confirm with your authenticator code — or a recovery code, if you no longer have the app.')
            : (pt
              ? 'Esta ação apaga dados ou emite uma credencial. Confirme com sua senha para continuar.'
              : 'This action deletes data or mints a credential. Confirm with your password to continue.')}
        </div>
        <Revealable shown={shown} onToggle={() => setShown(v => !v)} lang={lang} disabled={useCode}>
          <input
            ref={inputRef}
            type={useCode || shown ? 'text' : 'password'}
            value={value}
            onChange={e => { setValue(e.target.value); setError(false) }}
            placeholder={useCode ? '123456' : '••••••••'}
            autoComplete={useCode ? 'one-time-code' : 'current-password'}
            style={{ ...input, paddingRight: useCode ? 11 : REVEAL_PAD, ...(isMobile ? { minHeight: TOUCH } : null) }}
          />
        </Revealable>
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', marginBottom: 10 }}>
            <AlertCircle size={13} /> {pt ? 'Não confere.' : 'Does not match.'}
          </div>
        )}
        <button type="submit" disabled={!value.trim()} style={{ ...primaryBtn, ...(isMobile ? { minHeight: TOUCH } : null), opacity: value.trim() ? 1 : 0.5 }}>
          {pt ? 'Confirmar' : 'Confirm'}
        </button>
        <div style={{ display: 'flex', justifyContent: codeOnly ? 'flex-end' : 'space-between', gap: 8, marginTop: 10 }}>
          {/* Offered only when the password is genuinely accepted — an enrolled account that
              typed it would simply be refused, which is the failure this dialog had. */}
          {!codeOnly && (
            <button type="button" onClick={() => { setUseCode(v => !v); setValue('') }} style={{ ...linkBtn, ...(isMobile ? touchLink : null) }}>
              {useCode
                ? (pt ? 'Usar a senha' : 'Use password')
                : (pt ? 'Usar código do autenticador' : 'Use authenticator code')}
            </button>
          )}
          <button type="button" onClick={() => finish(null)} style={{ ...linkBtn, ...(isMobile ? touchLink : null) }}>
            {pt ? 'Cancelar' : 'Cancel'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

/**
 * Above EVERY surface that can ask for it. This prompt is always raised BY something already on
 * screen — a settings drawer (2000), a modal (9999/10000), a popover (99999) — so any value that
 * merely looks large is a bug waiting for the one caller that outranks it. It was 1100, i.e.
 * behind the very drawer whose "create team" button opened it: the action appeared to hang while
 * the password box sat underneath, invisible.
 */
const Z_STEPUP = 2_000_000

/** Minimum comfortable touch target — applied on mobile ONLY; on a pointer it just bloats the card. */
const TOUCH = 44
const touchLink: React.CSSProperties = { minHeight: TOUCH, display: 'inline-flex', alignItems: 'center' }

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: Z_STEPUP, padding: 16,
}
const card: React.CSSProperties = {
  width: '100%', maxWidth: 360, background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)', padding: 22,
}
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: 'var(--bg-elevated)',
  border: '1px solid var(--border)', borderRadius: 8, fontSize: 16, color: 'var(--text-primary)',
  outline: 'none', fontFamily: 'inherit', marginBottom: 12,
}
const primaryBtn: React.CSSProperties = {
  width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)',
  background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', fontSize: 13,
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const linkBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 12,
  cursor: 'pointer', fontFamily: 'inherit', padding: 4,
}
