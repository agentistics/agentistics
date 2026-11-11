/**
 * The vault's OWN password (COFRE.DESBLOQUEIO, owner 2026-11-07) — three pieces, all built from the
 * app's existing parts (the `RevealButton` every password field uses, `PasswordHint` for the live rules,
 * `Disclosure` for the folded explanation, the shared modal styles):
 *
 *  - `VaultPasswordInput`  one field, with show/hide;
 *  - `VaultPasswordSetup`  choosing it: live checklist of the four rules, a "type it again", a random
 *                          generator (CSPRNG, shown once, with copy), and the minimized "how your
 *                          password is protected" block;
 *  - `VaultPasswordPrompt` the ONE prompt the app mounts: when the service answers `password-required`
 *                          for any vault request, `vaultApi` asks here and sends the request again.
 *
 * A password lives in component state only for as long as it is typed, and is dropped on submit,
 * cancel and unmount. It is never logged, never stored and never put in a URL.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type React from 'react'
import { Copy, KeyRound, Shuffle } from 'lucide-react'
import { checkVaultPassword, generateVaultPassword } from '@agentistics/core'
import { RevealButton, REVEAL_PAD } from '../PasswordReveal'
import { PasswordHint } from '../PasswordHint'
import { Disclosure } from '../Disclosure'
import { Err, card, input, overlay, primaryBtn } from '../dialogStyles'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useEscapeOwner } from '../../lib/overlayStack'
import { setVaultPasswordPrompt, type PasswordAsk } from '../../lib/vaultApi'
import { vt } from '../../lib/vaultText'

type Lang = 'en' | 'pt'

export function VaultPasswordInput({ value, onChange, label, lang, autoFocus, autoComplete = 'current-password', invalid, id, onEnter }: {
  value: string; onChange: (v: string) => void; label: string; lang: Lang; autoFocus?: boolean
  autoComplete?: 'current-password' | 'new-password'; invalid?: boolean; id?: string; onEnter?: () => void
}) {
  const [shown, setShown] = useState(false)
  const isMobile = useIsMobile()
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</span>
      <span style={{ position: 'relative', display: 'block' }}>
        <input
          id={id} type={shown ? 'text' : 'password'} value={value} autoFocus={autoFocus} autoComplete={autoComplete}
          spellCheck={false} autoCapitalize="none" aria-invalid={invalid || undefined}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter() } }}
          // ≥ 16px on a phone (index.css guards it too): iOS zooms the page for anything smaller.
          style={{ ...input, marginBottom: 0, letterSpacing: 'normal', width: '100%', boxSizing: 'border-box', paddingRight: REVEAL_PAD, minHeight: isMobile ? 44 : undefined }}
        />
        <RevealButton shown={shown} onToggle={() => setShown(s => !s)} lang={lang} />
      </span>
    </label>
  )
}

/** The minimized "how your password is protected" block — the app's `Disclosure`, closed by default. */
export function PasswordProtectedHow({ lang, defaultOpen = false }: { lang: Lang; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  return (
    <div data-vault-pw-how style={{ border: '1px solid var(--border)', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
      <Disclosure
        open={open} onToggle={() => setOpen(o => !o)} panelId={panelId} panelLabel={vt('wiz_pw_how_title', lang)}
        header={chevron => <>{chevron}<span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{vt('wiz_pw_how_title', lang)}</span></>}
        panelStyle={{ padding: '0 14px 12px 36px' }}
      >
        <ul style={{ margin: 0, padding: 0, listStyle: 'disc', display: 'grid', gap: 6, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {(['wiz_pw_how_1', 'wiz_pw_how_2', 'wiz_pw_how_3', 'wiz_pw_how_4'] as const).map(k => <li key={k}>{vt(k, lang)}</li>)}
        </ul>
      </Disclosure>
    </div>
  )
}

/**
 * Choosing the vault password. `onSubmit` receives it only once every rule passes AND both fields
 * agree (the server checks the same rules again — the page is never the last word).
 */
export function VaultPasswordSetup({ lang, busy, onSubmit, error, howOpen, before, blocked }: {
  lang: Lang; busy?: boolean; onSubmit: (password: string) => void; error?: string | null
  /** Screenshots and the first visit may show the explanation unfolded; it is closed otherwise. */
  howOpen?: boolean
  /** Drawn INSIDE the form, above the fields (the wizard's setup-code field), so Enter submits it too. */
  before?: React.ReactNode
  /** Something outside the password still owes an answer (an incomplete setup code): the button waits. */
  blocked?: boolean
}) {
  const isMobile = useIsMobile()
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [generated, setGenerated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => () => { setPw(''); setAgain(''); setGenerated(null) }, [])
  const check = checkVaultPassword(pw)
  const matches = pw.length > 0 && pw === again
  const ready = check.ok && matches && !busy && !blocked
  const generate = () => {
    const g = generateVaultPassword()
    setGenerated(g); setPw(g); setAgain(g); setCopied(false)
  }
  const copy = async () => {
    if (!generated) return
    try { await navigator.clipboard.writeText(generated); setCopied(true) } catch { setCopied(false) }
  }
  const submit = () => { if (ready) { const p = pw; setPw(''); setAgain(''); setGenerated(null); onSubmit(p) } }
  return (
    <form onSubmit={e => { e.preventDefault(); submit() }} data-vault-pw-setup>
      {before}
      <VaultPasswordInput value={pw} onChange={v => { setPw(v); if (generated && v !== generated) setGenerated(null) }} label={vt('wiz_pw_label', lang)} lang={lang} autoComplete="new-password" autoFocus={!isMobile} invalid={pw.length > 0 && !check.ok} />
      <PasswordHint value={pw} lang={lang} rules="vault" />
      <VaultPasswordInput value={again} onChange={setAgain} label={vt('wiz_pw_again', lang)} lang={lang} autoComplete="new-password" invalid={again.length > 0 && !matches} />
      {again.length > 0 && !matches && <div role="status" style={{ fontSize: 12, color: 'var(--accent-orange, #f59e0b)', margin: '-4px 0 10px' }}>{vt('wiz_pw_mismatch', lang)}</div>}
      <button type="button" onClick={generate}
        style={{ ...primaryBtn, width: 'auto', color: 'var(--text-primary)', borderColor: 'var(--border)', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10, minHeight: isMobile ? 44 : undefined }}>
        <Shuffle size={14} /> {vt('wiz_pw_generate', lang)}
      </button>
      {generated && (
        <div role="status" data-vault-pw-generated style={{ border: '1px solid var(--anthropic-orange)', borderRadius: 10, padding: '10px 12px', marginBottom: 12, background: 'var(--anthropic-orange-dim)' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>{vt('wiz_pw_generated', lang)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: isMobile ? 16 : 14, wordBreak: 'break-all', flex: 1, minWidth: 0, userSelect: 'all' }}>{generated}</code>
            <button type="button" onClick={() => { void copy() }} aria-label={vt('wiz_pw_copy', lang)}
              style={{ ...primaryBtn, width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: isMobile ? 44 : undefined }}>
              <Copy size={13} /> {copied ? vt('wiz_pw_copied', lang) : vt('wiz_pw_copy', lang)}
            </button>
          </div>
        </div>
      )}
      <PasswordProtectedHow lang={lang} defaultOpen={howOpen} />
      {error && <Err text={error} />}
      <button type="submit" disabled={!ready} style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <KeyRound size={14} /> {vt('wiz_pw_go', lang)}
      </button>
    </form>
  )
}

type Pending = { ask: PasswordAsk; resolve: (pw: string | null) => void }

/**
 * The ONE prompt for the vault password, mounted once by the app. `vaultApi` calls it when the service
 * answers `password-required` / `password-wrong`; the request is then sent again with what was typed.
 */
export function VaultPasswordPrompt({ lang, enabled }: { lang: Lang; enabled: boolean }) {
  const isMobile = useIsMobile()
  const [pending, setPending] = useState<Pending | null>(null)
  const [pw, setPw] = useState('')
  const ref = useRef<Pending | null>(null)
  ref.current = pending
  useEffect(() => {
    if (!enabled) return
    setVaultPasswordPrompt(ask => new Promise<string | null>(resolve => {
      // A second ask while one is open answers the first with "cancelled" — never two prompts at once.
      ref.current?.resolve(null)
      setPw('')
      setPending({ ask, resolve })
    }))
    return () => { setVaultPasswordPrompt(null); ref.current?.resolve(null) }
  }, [enabled])
  const close = (value: string | null) => { const p = ref.current; setPending(null); setPw(''); p?.resolve(value) }
  useEscapeOwner(!!pending, () => close(null))
  if (!pending) return null
  const o: React.CSSProperties = isMobile ? { ...overlay, padding: 0, zIndex: 3300 } : { ...overlay, zIndex: 3300 }
  const c: React.CSSProperties = isMobile
    ? { ...card, maxWidth: 'none', width: '100%', height: 'calc(100dvh / var(--ui-zoom, 1))', borderRadius: 0, border: 'none', boxSizing: 'border-box', overflowY: 'auto' }
    : { ...card, maxWidth: 400 }
  return (
    <div style={o} role="dialog" aria-modal="true" aria-label={vt('pw_prompt_title', lang)} onClick={() => close(null)}>
      <form style={c} onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (pw) close(pw) }} data-vault-pw-prompt>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{vt('pw_prompt_title', lang)}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>{vt('pw_prompt_body', lang)}</div>
        <VaultPasswordInput value={pw} onChange={setPw} label={vt('wiz_pw_label', lang)} lang={lang} autoFocus invalid={pending.ask.retry} />
        {pending.ask.retry && <Err text={pending.ask.sentence || vt('pw_prompt_wrong', lang)} />}
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 10 }}>{vt('pw_forgot', lang)}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => close(null)} style={{ ...primaryBtn, color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent', minHeight: isMobile ? 44 : undefined }}>{vt('cancel', lang)}</button>
          <button type="submit" disabled={!pw} style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }}>{vt('pw_prompt_go', lang)}</button>
        </div>
      </form>
    </div>
  )
}
