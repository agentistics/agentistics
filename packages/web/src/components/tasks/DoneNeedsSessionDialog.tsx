/**
 * DoneNeedsSessionDialog — the question `done` asks before it will be recorded, when nothing is
 * filed under the task or subtask yet.
 *
 * Same refusal shape as `BlockedDialog`, and the same reason for existing: the server refuses a
 * transition into `done` with no session filed (`done_needs_session`, `task-web.ts`'s
 * `patchSubtask`/`setSubtaskDone`/`markTask`) — a task or subtask carries cost, rounds and tokens
 * only through the sessions filed under it, so a `done` with none would be delivered work nobody
 * can account for. A bare 422 read as a toast that disappears names nothing to do about it; this
 * names the rule and hands over the one action that resolves it.
 *
 * Unlike `blocked`, there is nothing to type or pick — the fix is always the same gesture (file a
 * session), so this is an acknowledgement plus a one-click shortcut rather than a form. The
 * shortcut itself is the CALLER's: a subtask's own "filiar" control (`SubtaskSessions`) when this
 * fired from a subtask row, or the Subtasks tab — where every filing control lives — when it fired
 * from the delivery's own status chip.
 */

import { createPortal } from 'react-dom'
import { AlertTriangle, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useDismissOverlay } from '../../lib/dismissOverlay'
import { overlayPadding } from '../../lib/mobileOverlay'
import { button, surface } from './board'
import type { Lang } from './copy'

export interface DoneNeedsSessionDialogProps {
  /** The subtask or delivery title, named so the refusal reads as an answer about IT. */
  title: string
  /** Only the wording changes between the two — a subtask's fix is filing right there; a
   *  delivery's is filing under one of its subtasks (or directly on it). */
  scope: 'task' | 'subtask'
  lang: Lang
  onCancel: () => void
  /** File a session now — the caller opens whatever filing control fits where this was asked. */
  onFile: () => void
}

export function DoneNeedsSessionDialog(p: DoneNeedsSessionDialogProps) {
  const isMobile = useIsMobile()
  const dismiss = useDismissOverlay(() => p.onCancel())
  const pt = p.lang === 'pt'

  return createPortal(
    <div
      // See `dismissOverlay.ts`: a bare click handler here would close the dialog on a selection
      // that started inside it and was released outside.
      {...dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
        // The shared rule, not a bare 0: a full-screen mobile overlay that pads with zero puts its
        // own close button under the status bar, where taps do not reach it.
        padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          ...surface, background: 'var(--bg-card)', boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          display: 'grid', gap: 13, padding: 20,
          ...(isMobile
            ? { width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto', alignContent: 'start' }
            : { width: '100%', maxWidth: 420, borderRadius: 12 }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', padding: 8, borderRadius: 9,
            background: 'var(--accent-red-dim)', color: 'var(--accent-red)',
          }}><AlertTriangle size={17} /></span>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>
            {pt ? 'Nada filiado ainda' : 'Nothing filed yet'}
          </span>
          <button
            onClick={p.onCancel}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              // The glyph stays 16px; the PADDING is the thumb's target.
              ...(isMobile ? { minWidth: 44, minHeight: 44 } : {}),
            }}
          ><X size={16} /></button>
        </div>

        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {p.scope === 'subtask'
            ? (pt
              ? <>
                  “<strong style={{ color: 'var(--text-primary)' }}>{p.title}</strong>” precisa de
                  uma sessão filiada antes de ser marcada como entregue — o custo e o tempo de uma
                  subtarefa vêm das sessões filiadas a ela, e nenhuma foi ainda.
                </>
              : <>
                  “<strong style={{ color: 'var(--text-primary)' }}>{p.title}</strong>” needs a
                  session filed under it before it can be marked delivered — a subtask's cost and
                  time come from the sessions filed under it, and none is yet.
                </>)
            : (pt
              ? <>
                  “<strong style={{ color: 'var(--text-primary)' }}>{p.title}</strong>” precisa de
                  uma sessão filiada — direto na entrega, ou em uma de suas subtarefas — antes de
                  ser marcada como entregue.
                </>
              : <>
                  “<strong style={{ color: 'var(--text-primary)' }}>{p.title}</strong>” needs a
                  session filed — directly on the delivery, or under one of its subtasks — before
                  it can be marked delivered.
                </>)}
        </p>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button style={button(isMobile)} onClick={p.onCancel}>{pt ? 'Cancelar' : 'Cancel'}</button>
          <button style={button(isMobile, 'primary')} onClick={p.onFile}>
            {pt ? 'Filiar uma sessão' : 'File a session'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
