import React, { useEffect, useRef, useState } from 'react'
import { Cpu, Check, ChevronDown } from 'lucide-react'
import type { SurfaceHarnessId } from '@agentistics/core'
import { HARNESS_LABELS } from '../lib/harness'

interface Props {
  harnesses: SurfaceHarnessId[]
  selected: SurfaceHarnessId[]
  onChange: (harnesses: SurfaceHarnessId[]) => void
  lang: 'pt' | 'en'
}

const T = {
  pt: { all: 'Todos os harnesses', selected: 'harnesses', selectAll: 'Selecionar tudo', clear: 'Limpar' },
  en: { all: 'All harnesses', selected: 'harnesses', selectAll: 'Select all', clear: 'Clear' },
} as const

/** Multi-select harness filter pill. Renders only when harnesses.length > 1. */
export function HarnessFilter({ harnesses, selected, onChange, lang }: Props) {
  const t = T[lang]
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [])

  // Only show when there are multiple harnesses in the data
  if (harnesses.length <= 1) return null

  function toggle(harness: SurfaceHarnessId) {
    if (selected.includes(harness)) onChange(selected.filter(h => h !== harness))
    else onChange([...selected, harness])
  }

  const label = selected.length === 0 ? t.all : `${selected.length} ${t.selected}`
  const active = selected.length > 0
  // Tooltip lists exactly which harnesses are selected (or "all" when none is).
  const tip = selected.length === 0 ? t.all : selected.map(h => HARNESS_LABELS[h]).join(', ')

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={tip}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 8,
          border: '1px solid var(--border)',
          background: active ? 'var(--anthropic-orange-dim, rgba(205,93,56,0.12))' : 'var(--bg-elevated)',
          color: active ? 'var(--anthropic-orange, #cd5d38)' : 'var(--text-secondary)',
          fontSize: 12, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
        }}
      >
        <Cpu size={14} />
        <span>{label}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 600,
          minWidth: 200, maxHeight: 320, overflowY: 'auto',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 10, boxShadow: '0 16px 40px rgba(0,0,0,0.4)', padding: 6,
        }}>
          <div style={{ display: 'flex', gap: 6, padding: '4px 6px 8px' }}>
            <button
              onClick={() => onChange([...harnesses])}
              style={miniBtn}
            >{t.selectAll}</button>
            <button
              onClick={() => onChange([])}
              style={miniBtn}
            >{t.clear}</button>
          </div>
          {harnesses.map(harness => {
            const isSel = selected.includes(harness)
            return (
              <div
                key={harness}
                onClick={() => toggle(harness)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                  background: isSel ? 'var(--anthropic-orange-dim, rgba(205,93,56,0.07))' : 'transparent',
                }}
                onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-elevated)' }}
                onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <div style={{
                  width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: isSel ? '1.5px solid var(--anthropic-orange, #cd5d38)' : '1.5px solid var(--border)',
                  background: isSel ? 'var(--anthropic-orange, #cd5d38)' : 'transparent',
                }}>
                  {isSel && <Check size={11} color="#fff" strokeWidth={3} />}
                </div>
                <span style={{
                  fontSize: 13, color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{HARNESS_LABELS[harness]}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const miniBtn: React.CSSProperties = {
  flex: 1, padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)', fontSize: 11, fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
