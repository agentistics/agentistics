import React from 'react'

export type SessionRole = 'leader' | 'worker'

/** The outlined chip shape a session's own facts wear (its role, its away mode) — one shape for all. */
export const SESSION_CHIP_STYLE = { display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, border: '1px solid currentColor', borderRadius: 5, padding: '2px 6px', fontSize: 11, lineHeight: 1.2, whiteSpace: 'nowrap' } as const

export function SessionChip({ children, color = 'var(--text-tertiary)' }: { children: React.ReactNode; color?: string }) {
  return <span style={{ ...SESSION_CHIP_STYLE, color }}>{children}</span>
}

export function RoleChip({ role, pt = false }: { role: SessionRole | undefined; pt?: boolean }) {
  const color = role === 'leader' ? 'var(--accent-purple)' : role === 'worker' ? 'var(--accent-cyan)' : 'var(--text-tertiary)'
  const label = role === 'leader' ? (pt ? 'Líder' : 'Leader') : role === 'worker' ? 'Worker' : (pt ? 'Automático' : 'Automatic')
  return <SessionChip color={color}><span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />{label}</SessionChip>
}
