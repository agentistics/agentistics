/**
 * Pill — the small tinted status pill (11px/700, radius 20) the harness status badges are drawn
 * with. Extracted from `HarnessStatusBadge` so every chip of this shape shares one definition.
 * Tint tokens are the badge's own: ok = green 12% fill / 28% border; warn, error and neutral use
 * a 30% border; `muted` is the flat elevated chip ("Not installed").
 */
import React from 'react'

export type PillTone = 'ok' | 'warn' | 'error' | 'neutral' | 'muted'

const COLOR: Record<Exclude<PillTone, 'muted'>, string> = {
  ok: 'var(--accent-green)', warn: 'var(--anthropic-orange)', error: 'var(--accent-red)', neutral: 'var(--text-secondary)',
}

export function Pill({ tone, children, nowrap = false }: { tone: PillTone; children: React.ReactNode; nowrap?: boolean }) {
  const tint: React.CSSProperties = tone === 'muted'
    ? { color: 'var(--text-tertiary)', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }
    : {
      color: COLOR[tone],
      background: `color-mix(in srgb, ${COLOR[tone]} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${COLOR[tone]} ${tone === 'ok' ? 28 : 30}%, transparent)`,
    }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700,
      ...tint, padding: '2px 8px', borderRadius: 20, whiteSpace: nowrap ? 'nowrap' : undefined,
    }}>{children}</span>
  )
}
