import React, { useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}

export function ChartModal({ title, onClose, children }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px 28px',
          width: '100%',
          maxWidth: 1100,
          maxHeight: 'calc(90vh / var(--ag-zoom, 1))',
          overflow: 'auto',
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {title}
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              transition: 'all 0.15s',
              padding: 0,
            }}
            onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)' }}
          >
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
