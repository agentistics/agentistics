/**
 * PresetLaunchConfirm — the consent gate a preset click must pass through before it spends money.
 *
 * "DISPARAR GASTA DINHEIRO" (board note, s-d85c7d9d9d): a click on a shelf of 44px cards standing
 * side by side starts a real, billable assistant — the same gate the ceiling modal's own button
 * uses (the click highlights, this confirms), never a bare click-and-go. Only reached for a preset
 * that already has a `cwd` — one without opens the ordinary new-session wizard pre-filled instead,
 * whose own review step is this same gate.
 */

import { X } from 'lucide-react'
import type { SessionPreset } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { HarnessMark } from './HarnessMark'
import { useIsMobile } from '../../hooks/useIsMobile'

export interface PresetLaunchConfirmProps {
  lang: 'pt' | 'en'
  preset: SessionPreset
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function PresetLaunchConfirm({ lang, preset, busy, error, onCancel, onConfirm }: PresetLaunchConfirmProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pt ? 'Disparar sessão pré-configurada' : 'Launch preset session'}
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 410,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 16, width: '100%', maxWidth: 460, maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <HarnessMark harness={preset.harness} size={20} />
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preset.label}
          </h2>
          <button
            onClick={onCancel}
            disabled={busy}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: busy ? 'not-allowed' : 'pointer', flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {pt
              ? 'Isso inicia um assistente de verdade agora, cobrado como qualquer outra sessão.'
              : 'This starts a real assistant now, billed like any other session.'}
          </p>

          <Row label={pt ? 'Assistente' : 'Assistant'} value={(HARNESS_LABELS as Record<string, string>)[preset.harness] ?? preset.harness} />
          {preset.cwd && <Row label={pt ? 'Onde' : 'Where'} value={preset.cwd} mono />}
          {preset.model && <Row label={pt ? 'Modelo' : 'Model'} value={preset.model} />}
          {preset.effort && <Row label={pt ? 'Esforço' : 'Effort'} value={preset.effort} />}

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>
              {pt ? 'Primeira mensagem' : 'First message'}
            </div>
            <div style={{
              maxHeight: 140, overflowY: 'auto', padding: '9px 11px', borderRadius: 8,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
              fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {preset.promptTemplate}
            </div>
          </div>

          {error && <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{error}</p>}
        </div>

        <div style={{
          display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border)',
          justifyContent: 'flex-end', flexDirection: isMobile ? 'column-reverse' : 'row',
        }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined,
              borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {pt ? 'Cancelar' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined,
              borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
              color: '#fff', fontSize: 13, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', opacity: busy ? 0.75 : 1,
            }}
          >
            {busy ? (pt ? 'Iniciando…' : 'Starting…') : (pt ? 'Disparar' : 'Launch')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 78, flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: 12.5, color: 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit',
        overflowWrap: 'break-word', minWidth: 0,
      }}>
        {value}
      </span>
    </div>
  )
}
