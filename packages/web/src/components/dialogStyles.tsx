import React from 'react'
import { AlertCircle } from 'lucide-react'

export function Err({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', margin: '8px 0' }}>
      <AlertCircle size={13} /> {text}
    </div>
  )
}

export const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
}
export const card: React.CSSProperties = {
  width: '100%', maxWidth: 380, background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)', padding: 22,
}
export const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 11px', background: 'var(--bg-elevated)',
  border: '1px solid var(--border)', borderRadius: 8, fontSize: 16, color: 'var(--text-primary)',
  outline: 'none', fontFamily: 'inherit', marginBottom: 10, letterSpacing: '0.15em',
}
export const codeBlock: React.CSSProperties = {
  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
  padding: '10px 12px', fontSize: 13, color: 'var(--text-primary)', overflowX: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', marginBottom: 12,
}
export const primaryBtn: React.CSSProperties = {
  width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)',
  background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', fontSize: 13,
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
export const dangerBtn: React.CSSProperties ={ ...primaryBtn, borderColor: '#ef4444', background: 'transparent', color: '#ef4444' }
// A module object cannot read `useIsMobile()`, so the 44 it used to carry was a DESKTOP 44 as
// well — a copy button three times the height of the field beside it. The finger target is
// `.ag-tap-icon`'s invisible box on the consumer.
export const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px',
  minWidth: 32, minHeight: 32, borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer',
}
