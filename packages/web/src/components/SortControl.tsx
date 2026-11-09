import React, { useState, useRef, useEffect } from 'react'
import { ArrowUpDown, ChevronDown, ArrowDown, ArrowUp, Check } from 'lucide-react'
import type { Lang } from '@agentistics/core'

export interface SortOption<K extends string = string> { key: K; label: string }

/** Compact sort control: a single "Sort: <field>" dropdown + an asc/desc toggle. Reused across
 *  the Repositories list, the Actions view, and repo-detail session lists so sorting looks and
 *  behaves the same everywhere (replaces the old spread-out row of pills). */
export function SortControl<K extends string>({ options, sortKey, dir, onKey, onDir, lang }: {
  options: SortOption<K>[]
  sortKey: K
  dir: 'asc' | 'desc'
  onKey: (k: K) => void
  onDir: () => void
  lang: Lang
}) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const current = options.find(o => o.key === sortKey)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 9px',
            borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)', fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          <ArrowUpDown size={12} style={{ color: 'var(--text-tertiary)' }} />
          <span style={{ color: 'var(--text-tertiary)' }}>{pt ? 'Ordenar' : 'Sort'}</span>
          <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{current?.label}</strong>
          <ChevronDown size={12} style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
        </button>
        {open && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 1000,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)', padding: 5, minWidth: 160,
          }}>
            {options.map(o => {
              const on = o.key === sortKey
              return (
                <button
                  key={o.key}
                  onClick={() => { onKey(o.key); setOpen(false) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 9px',
                    borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                    textAlign: 'left', background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                    color: on ? 'var(--anthropic-orange)' : 'var(--text-secondary)', fontWeight: on ? 600 : 500,
                  }}
                  onMouseEnter={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-card-hover)' }}
                  onMouseLeave={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                >
                  <span style={{ flex: 1 }}>{o.label}</span>
                  {on && <Check size={13} strokeWidth={3} />}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <button
        onClick={onDir}
        title={dir === 'desc' ? (pt ? 'Decrescente (maior → menor)' : 'Descending') : (pt ? 'Crescente (menor → maior)' : 'Ascending')}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
          borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        {dir === 'desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
      </button>
    </div>
  )
}
