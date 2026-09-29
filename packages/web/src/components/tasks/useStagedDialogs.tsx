/**
 * useStagedDialogs — the staged-session draft's own dialogs (compose / edit, the read-only view, the
 * delete confirmation, and the refusal notice), shared by every surface whose subtask gear offers
 * them: the delivery's own grid (`SubtaskTable`) and the board table's inline rows (`TaskTable`).
 * Firing is `useStagedFire`'s. One implementation, because a draft composed in one place and edited
 * in another through a different form is two forms for one record.
 */

import { useState, type ReactNode } from 'react'
import type { StagedSessionDraft } from '@agentistics/core'
import { ConfirmModal } from '../../pages/settings/primitives'
import { StagedSessionCompose } from './StagedSessionCompose'
import { StagedSessionView } from './StagedSessionView'
import { boardCopy, type Lang } from './copy'
import type { StagedSessionWriteResult, Subtask, TaskFile } from '../../lib/tasks'

export interface StagedTarget {
  subtask: Subtask
  files: readonly TaskFile[]
}

export function useStagedDialogs<T extends StagedTarget>(lang: Lang, h: {
  save: (t: T, draft: StagedSessionDraft) => Promise<StagedSessionWriteResult>
  clear: (t: T) => void | Promise<void>
  upload: (t: T, file: File) => Promise<string | null>
}): { compose: (t: T) => void; view: (t: T) => void; remove: (t: T) => void; element: ReactNode } {
  const staged = boardCopy(lang).staged
  const [composing, setComposing] = useState<T | null>(null)
  const [viewing, setViewing] = useState<T | null>(null)
  const [deleting, setDeleting] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  const element = (
    <>
      {composing && (
        <StagedSessionCompose
          lang={lang}
          subtaskTitle={composing.subtask.title}
          {...(composing.subtask.stagedSession ? { initial: composing.subtask.stagedSession } : {})}
          taskFiles={composing.files}
          onUpload={f => h.upload(composing, f)}
          onSave={async d => {
            const result = await h.save(composing, d)
            // The control is withheld on a member row, so a refusal here is defence in depth — but it
            // is SAID, never read as the dialog's close meaning success.
            if (!result.ok) {
              setError(result.reason === 'subtask_in_group'
                ? (lang === 'pt'
                  ? 'Esta subtarefa pertence a um grupo e não pode receber uma sessão em espera.'
                  : 'This subtask belongs to a group and cannot hold a staged session.')
                : staged.networkError)
            }
          }}
          {...(composing.subtask.stagedSession ? { onDiscard: () => void h.clear(composing) } : {})}
          onClose={() => setComposing(null)}
        />
      )}

      {viewing && viewing.subtask.stagedSession && (
        <StagedSessionView
          lang={lang}
          subtaskTitle={viewing.subtask.title}
          draft={viewing.subtask.stagedSession}
          taskFiles={viewing.files}
          onEdit={() => { const t = viewing; setViewing(null); setComposing(t) }}
          onClose={() => setViewing(null)}
        />
      )}

      {/* Destructive, so it confirms — the same `ConfirmModal` every other destructive act uses. */}
      <ConfirmModal
        open={deleting !== null}
        title={staged.discardTitle}
        message={staged.discardMessage}
        confirmLabel={staged.discard}
        cancelLabel={staged.cancel}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          void h.clear(deleting)
          setDeleting(null)
        }}
      />

      {error && (
        <div
          role="alertdialog" aria-modal="true"
          onClick={e => { if (e.target === e.currentTarget) setError(null) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 435, background: 'var(--ag-scrim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14,
            width: '100%', maxWidth: 380, padding: 18, display: 'grid', gap: 12,
          }}>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.5 }}>{error}</p>
            <button
              type="button" onClick={() => setError(null)}
              style={{
                justifySelf: 'flex-end', padding: '7px 14px', borderRadius: 7,
                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
                fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >OK</button>
          </div>
        </div>
      )}
    </>
  )

  return { compose: setComposing, view: setViewing, remove: setDeleting, element }
}
