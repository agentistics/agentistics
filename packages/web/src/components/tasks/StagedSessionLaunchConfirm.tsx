/**
 * StagedSessionLaunchConfirm — the consent gate a staged draft's "Fire" click must pass through
 * before it spends money (t-918cc82233). Mirrors `PresetLaunchConfirm.tsx`'s own gate exactly (the
 * same "a click on a small control starts a real assistant" reasoning), reached only when the draft
 * already names BOTH a harness and a folder — one missing either opens the ordinary wizard instead,
 * pre-filled (see `NewSessionModal`'s `initialPreset`/`initialSubtaskId`).
 */

import { X } from 'lucide-react'
import type { StagedSessionDraft } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from '../sessions/HarnessMark'
import { HARNESS_LABELS } from '../../lib/harness'
import { boardCopy, type Lang } from './copy'

export interface StagedSessionLaunchConfirmProps {
  lang: Lang
  subtaskTitle: string
  draft: StagedSessionDraft
  /** Names of the attachments that will be materialized into the new session — display only. */
  attachmentNames: string[]
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function StagedSessionLaunchConfirm({
  lang, subtaskTitle, draft, attachmentNames, busy, error, onCancel, onConfirm,
}: StagedSessionLaunchConfirmProps) {
  const pt = lang === 'pt'
  const copy = boardCopy(lang).staged
  const isMobile = useIsMobile()
  const harness = draft.harness!

  return (
    <div
      role="dialog" aria-modal="true" aria-label={copy.launchTitle}
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 440,
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
          <HarnessMark harness={harness} size={20} />
          <h2 style={{
            margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1,
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {subtaskTitle}
          </h2>
          <button
            onClick={onCancel} disabled={busy} aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: busy ? 'not-allowed' : 'pointer', flexShrink: 0,
            }}
          ><X size={16} /></button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {copy.launchIntro}
          </p>

          <Row label={pt ? 'Assistente' : 'Assistant'} value={(HARNESS_LABELS as Record<string, string>)[harness] ?? harness} />
          <Row label={pt ? 'Onde' : 'Where'} value={draft.cwd!} mono />
          {draft.model && <Row label={pt ? 'Modelo' : 'Model'} value={draft.model} />}
          {draft.effort && <Row label={pt ? 'Esforço' : 'Effort'} value={draft.effort} />}
          {attachmentNames.length > 0 && (
            <Row label={copy.attachments} value={attachmentNames.join(', ')} />
          )}

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>
              {copy.prompt}
            </div>
            <div style={{
              maxHeight: 140, overflowY: 'auto', padding: '9px 11px', borderRadius: 8,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
              fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {draft.prompt}
            </div>
          </div>

          {error && <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{error}</p>}
        </div>

        <div style={{
          display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border)',
          justifyContent: 'flex-end', flexDirection: isMobile ? 'column-reverse' : 'row',
        }}>
          <button
            type="button" onClick={onCancel} disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined,
              borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >{copy.cancel}</button>
          <button
            type="button" onClick={onConfirm} disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined,
              borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
              color: '#1a1008', fontSize: 13, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', opacity: busy ? 0.75 : 1,
            }}
          >{busy ? copy.launching : copy.launch}</button>
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
