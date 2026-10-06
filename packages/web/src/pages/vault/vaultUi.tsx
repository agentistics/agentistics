/**
 * The `/vault` page's layout pieces (VAULT v4, the approved prototype `cofre-v4-aprovado.html`): an
 * area header (15px title + ONE short line, actions right), a row (icon? + 13px title + 12px line +
 * status pill + one action), a quiet "Saiba mais" link, and the page's dialog shell. Composed only of
 * the app's own tokens and primitives — `dialogButtonStyle`, `DialogActions`, `MfaSetup`'s card — so
 * the vault reads like the rest of the product. Type scale: 20 page, 15 area, 13 body, 12 secondary, 11 labels.
 */
import { useEffect } from 'react'
import { Info, X } from 'lucide-react'
import { card, overlay } from '../../components/MfaSetup'
import { dialogButtonStyle } from '../settings/primitives'

/** The page's outlined button (elevated, 12px) — 44px on mobile. */
export function pageBtn(isMobile: boolean): React.CSSProperties {
  return {
    padding: isMobile ? '10px 14px' : '6px 11px', minHeight: isMobile ? 44 : 32, borderRadius: 8, fontSize: 12,
    border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', boxSizing: 'border-box', whiteSpace: 'nowrap',
  }
}
/** The orange primary of the page (the app's dialog primary), sized like `pageBtn`. */
export function hotBtn(isMobile: boolean): React.CSSProperties {
  return { ...dialogButtonStyle('primary', isMobile), width: undefined, minHeight: isMobile ? 44 : 32, padding: isMobile ? '10px 14px' : '6px 11px', fontSize: 12 }
}
/** A destructive outline (Remover, Apagar) — red words, no red fill until the confirmation. */
export function dangerOutline(isMobile: boolean): React.CSSProperties {
  return { ...pageBtn(isMobile), background: 'transparent', color: 'var(--accent-red, #ef4444)', borderColor: 'color-mix(in srgb, var(--accent-red, #ef4444) 40%, transparent)' }
}
/** A row's icon action (reveal, copy): a bare glyph, the tap target projected by `.ag-tap-icon`. */
export const iconBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--text-secondary)', padding: 6, borderRadius: 6, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
}

export function AreaHead({ title, desc, actions, isMobile }: { title: string; desc: string; actions?: React.ReactNode; isMobile: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', gap: 10, marginBottom: 12, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
      <div style={{ minWidth: 0, flex: isMobile ? '1 1 100%' : '1 1 auto' }}>
        <h2 style={{ fontSize: 15, fontWeight: 650, margin: 0, color: 'var(--text-primary)' }}>{title}</h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 0' }}>{desc}</p>
      </div>
      {actions && (
        <div data-area-actions style={{ display: 'flex', gap: 7, flexShrink: 0, width: isMobile ? '100%' : undefined }}>{actions}</div>
      )}
    </div>
  )
}

type Tone = 'ok' | 'warn' | 'bad' | 'off'
const TONE: Record<Tone, string> = {
  ok: 'var(--accent-green, #10b981)', warn: 'var(--anthropic-orange)', bad: 'var(--accent-red, #ef4444)', off: 'var(--text-tertiary)',
}
/** A status in a pill: the word always, the colour never alone. */
export function Pill({ tone, text }: { tone: Tone; text: string }) {
  const c = TONE[tone]
  return (
    <span data-pill={tone} style={{
      fontSize: 11, color: c, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)`, borderRadius: 999, padding: '2px 7px',
      whiteSpace: 'nowrap', flexShrink: 0, lineHeight: 1.4,
    }}>{text}</span>
  )
}

/** One row: icon? + title + one line, then the status and the ONE action. */
export function VaultRow({ icon, title, desc, status, children, isMobile, extra, data }: {
  icon?: React.ReactNode; title: React.ReactNode; desc?: React.ReactNode; status?: React.ReactNode; children?: React.ReactNode
  isMobile: boolean; extra?: React.ReactNode; data?: string
}) {
  return (
    <div data-vault-row={data} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', gap: 12, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
        {icon && <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--text-secondary)', marginTop: isMobile ? 2 : 0 }}>{icon}</span>}
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{title}</div>
          {desc && <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{desc}</div>}
        </div>
        {(status || children) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {status}
            {children}
          </div>
        )}
      </div>
      {extra}
    </div>
  )
}

export function Rows({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{children}</div>
}

/** The quiet section break under the rows (a toggle row, a "Saiba mais"). */
export function AfterRows({ children }: { children: React.ReactNode }) {
  return <div style={{ borderTop: '1px solid var(--border)', paddingTop: 15, marginTop: 18 }}>{children}</div>
}

/** "Saiba mais" instead of a paragraph: a quiet link that opens the explanation. */
export function LearnMore({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...iconBtn, gap: 6, fontSize: 12, padding: '4px 0', color: 'var(--text-secondary)' }}>
      <Info size={13} aria-hidden /> {label}
    </button>
  )
}

/** A small text button inside a line of meta (Lixeira · Grupos). */
export function TextButton({ onClick, children, pressed }: { onClick: () => void; children: React.ReactNode; pressed?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={pressed}
      style={{ ...iconBtn, padding: '2px 0', fontSize: 12, color: pressed ? 'var(--anthropic-orange)' : 'var(--text-secondary)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
      {children}
    </button>
  )
}

/** The page's dialog shell: the app's card, a title row with ×, the body, then a `DialogActions` footer. */
export function Sheet({ closeLabel, isMobile, title, onClose, children, wide, footer }: {
  closeLabel: string; isMobile: boolean; title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; footer?: React.ReactNode
}) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  const o: React.CSSProperties = isMobile ? { ...overlay, padding: 0, zIndex: 3000 } : { ...overlay, zIndex: 3000 }
  const c: React.CSSProperties = isMobile
    ? { ...card, maxWidth: 'none', width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' }
    : { ...card, maxWidth: wide ? 640 : 500, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 12px 48px rgba(0,0,0,0.5)' }
  return (
    <div style={o} role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div style={c} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>{title}</span>
          <button type="button" className="ag-tap-icon" aria-label={closeLabel} onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 4, display: 'inline-flex' }}><X size={16} /></button>
        </div>
        {children}
        {footer}
      </div>
    </div>
  )
}

/** An explanation behind a "Saiba mais": titled paragraphs, nothing to act on. */
export function InfoBlocks({ blocks }: { blocks: readonly { h?: string; body: React.ReactNode }[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {blocks.map((b, i) => (
        <div key={i}>
          {b.h && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{b.h}</div>}
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: b.h ? 3 : 0 }}>{b.body}</div>
        </div>
      ))}
    </div>
  )
}
