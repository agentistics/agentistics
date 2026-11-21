/**
 * BrowserAddressBar — back / forward / reload and the editable address of the person's own browser
 * (NAVEGADOR S10, spec §3.2; prototype `.addr`). It holds no browser rule: it hands the typed text to
 * `onGo` and the verbs to `onBack` / `onForward` / `onReload`; the panel decides what they do. While the
 * field is focused the person's typing is never overwritten by a page that navigates underneath.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { displayUrl } from '../../lib/browserCard'
import { useIsMobile } from '../../hooks/useIsMobile'

export interface BrowserAddressBarProps {
  /** The address of the page now showing (empty = nothing open). */
  url: string
  pt: boolean
  /** Back/forward/reload need a page; with none they are disabled, never silently inert. */
  hasPage: boolean
  busy?: boolean
  onGo: (text: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  autoFocus?: boolean
  /** A session's browser (A1 window): the address is shown, never typed — the model drives where it goes. */
  readOnly?: boolean
}

export function BrowserAddressBar({ url, pt, hasPage, busy = false, onGo, onBack, onForward, onReload, autoFocus = false, readOnly = false }: BrowserAddressBarProps) {
  const mobile = useIsMobile()
  const shown = displayUrl(url)
  const [text, setText] = useState(shown)
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setText(shown) }, [shown])

  const nav = (label: string, disabled: boolean, onClick: () => void, icon: React.ReactNode) => (
    <button
      type="button" className="ag-tap-icon" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: mobile ? 44 : 28, height: mobile ? 44 : 28,
        padding: 0, border: 'none', borderRadius: 8, background: 'transparent', fontFamily: 'inherit',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer',
      }}
    >{icon}</button>
  )
  const field: CSSProperties = {
    flex: 1, minWidth: 0, height: mobile ? 36 : 26, boxSizing: 'border-box', padding: '0 12px', borderRadius: 999,
    border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-primary)', outline: 'none',
    fontFamily: 'inherit', fontSize: mobile ? 16 : 11.5,
  }
  return (
    <form
      data-browser-address
      onSubmit={e => { e.preventDefault(); if (!readOnly) onGo(text) }}
      style={{ display: 'flex', alignItems: 'center', gap: mobile ? 0 : 2, padding: mobile ? '0 8px' : '6px 8px', flexShrink: 0, minWidth: 0, background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}
    >
      {nav(pt ? 'Página anterior' : 'Previous page', !hasPage || busy, onBack, <ArrowLeft size={15} aria-hidden />)}
      {nav(pt ? 'Avançar' : 'Forward', !hasPage || busy, onForward, <ArrowRight size={15} aria-hidden />)}
      {nav(pt ? 'Recarregar' : 'Reload', !hasPage || busy, onReload, <RotateCw size={14} aria-hidden />)}
      <input
        data-browser-url-input
        type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus={autoFocus}
        aria-label={pt ? 'Endereço' : 'Address'}
        placeholder={pt ? 'Digite um endereço' : 'Type an address'}
        readOnly={readOnly}
        value={text}
        onFocus={e => { editing.current = true; e.currentTarget.select() }}
        onBlur={() => { editing.current = false; setText(shown) }}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { setText(shown); e.currentTarget.blur() } }}
        style={field}
      />
    </form>
  )
}
