/**
 * StagedSessionView — a READ-ONLY summary of a subtask's staged session draft (t-918cc82233).
 *
 * Direct product ask: "e apos pre criada a sessao devo ter a opcao de VER essa sessao pre criada" —
 * a person composes a draft, comes back days later, and cannot remember what it said or what it
 * pointed at without going through `StagedSessionCompose`'s own edit flow (which, being a form,
 * invites changing something by accident). This is the same content laid out the way
 * `NewSessionModal`'s own review step lays out its answers — one row per question, the honest word
 * for anything left unset — but it never opens a text field: every control here is `onClick` on an
 * attachment chip, plus an `Edit` button that hands off to the real compose dialog.
 *
 * Attachments open the exact same `AttachmentLightbox` the compose dialog uses, through the same
 * `fileLightboxPath`/`fileIdFromLightboxPath` pair, so "what's in that file" never requires opening
 * Edit at all — the product ask names PDFs, screenshots and long pasted text by name as the reason
 * this needed to exist: nobody remembers what a chip held after enough time has passed.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, Pencil, X } from 'lucide-react'
import type { StagedSessionDraft } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useDismissOverlay } from '../../lib/dismissOverlay'
import { overlayPadding } from '../../lib/mobileOverlay'
import { HARNESS_LABELS } from '../../lib/harness'
import { HarnessMark } from '../sessions/HarnessMark'
import { AttachmentLightbox } from '../sessions/AttachmentLightbox'
import { fileIdFromLightboxPath, fileLightboxPath, fileUrl, type TaskFile } from '../../lib/tasks'
import { pill } from './board'
import { boardCopy, type Lang } from './copy'

export interface StagedSessionViewProps {
  lang: Lang
  subtaskTitle: string
  draft: StagedSessionDraft
  taskFiles: readonly TaskFile[]
  /** Absent hides the Edit shortcut — every current caller has one, but a future read-only surface
   *  (a shared/central view, say) should not be forced to invent one. */
  onEdit?: () => void
  onClose: () => void
}

function Row({ label, value, muted, mono }: {
  label: string
  value: React.ReactNode | null
  muted?: string
  mono?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '9px 0', borderBottom: '1px solid var(--border-subtle)',
    }}>
      <span style={{
        minWidth: 110, flexShrink: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3,
        textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 1,
      }}>{label}</span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5,
        color: value ? 'var(--text-primary)' : 'var(--text-tertiary)',
        fontStyle: value ? 'normal' : 'italic',
        fontFamily: mono && value ? 'var(--font-mono, ui-monospace, monospace)' : 'inherit',
        wordBreak: 'break-word', whiteSpace: 'pre-wrap',
      }}>{value ?? muted ?? '—'}</span>
    </div>
  )
}

export function StagedSessionView(p: StagedSessionViewProps) {
  const pt = p.lang === 'pt'
  const copy = boardCopy(p.lang).staged
  const isMobile = useIsMobile()
  const dismiss = useDismissOverlay(p.onClose)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const attached = useMemo(
    () => (p.draft.attachmentIds ?? [])
      .map(id => p.taskFiles.find(f => f.id === id))
      .filter((f): f is TaskFile => !!f),
    [p.draft.attachmentIds, p.taskFiles],
  )

  const harnessLabel = p.draft.harness
    ? ((HARNESS_LABELS as Record<string, string>)[p.draft.harness] ?? p.draft.harness)
    : null

  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-label={copy.view}
      {...dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 420,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: overlayPadding(isMobile, 20),
      }}
    >
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        ...(isMobile
          ? { width: '100%', height: '100%', borderRadius: 0 }
          : { borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: 'calc(86vh / var(--ag-zoom, 1))' }),
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{
            margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1,
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {copy.view} — {p.subtaskTitle}
          </h2>
          <button
            onClick={p.onClose} aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
            }}
          ><X size={16} /></button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 20px 16px' }}>
          <Row label={copy.prompt} value={p.draft.prompt || null} />
          <Row
            label={copy.harness}
            value={harnessLabel ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <HarnessMark harness={p.draft.harness!} size={16} />
                {harnessLabel}
              </span>
            ) : null}
            muted={pt ? 'Perguntado ao disparar' : 'Asked when fired'}
          />
          {p.draft.model && <Row label={copy.model} value={p.draft.model} mono />}
          {p.draft.effort && <Row label={copy.effort} value={p.draft.effort} />}
          <Row
            label={copy.cwd}
            value={p.draft.cwd || null}
            muted={pt ? 'Perguntada ao disparar' : 'Asked when fired'}
            mono
          />
          <Row
            label={copy.attachments}
            value={attached.length > 0 ? (
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {attached.map((f, i) => (
                  <button
                    key={f.id} type="button" onClick={() => setLightboxIndex(i)}
                    style={{
                      ...pill(), display: 'inline-flex', alignItems: 'center', gap: 5,
                      cursor: 'pointer', font: 'inherit', maxWidth: 220,
                    }}
                  >
                    <Paperclip size={10} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  </button>
                ))}
              </span>
            ) : null}
            muted={copy.noFiles}
          />
        </div>

        {p.onEdit && (
          <div style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            padding: '14px 20px', borderTop: '1px solid var(--border)',
          }}>
            <button
              type="button" onClick={p.onEdit}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
                width: isMobile ? '100%' : undefined,
                borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'transparent',
                color: 'var(--anthropic-orange)', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                fontFamily: 'inherit', justifyContent: 'center',
              }}
            ><Pencil size={13} /> {p.lang === 'pt' ? 'Editar' : 'Edit'}</button>
          </div>
        )}
      </div>

      {lightboxIndex !== null && attached.length > 0 && (
        <AttachmentLightbox
          paths={attached.map(fileLightboxPath)}
          index={Math.min(lightboxIndex, attached.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          lang={p.lang}
          srcFor={path => fileUrl(fileIdFromLightboxPath(path))}
        />
      )}
    </div>,
    document.body,
  )
}
