/**
 * CommentThreadDialog + CommentCountButton — a row's comment thread, reachable from the TABLE.
 *
 * Every row of the board's table (a task, a subtask GROUP, a subtask) carries a count and a button;
 * pressing it opens that row's thread here without leaving the table. The thread itself is the one
 * `CommentsTab` the open view draws, so reading and writing behave identically on both surfaces and
 * the aggregation rule (`@agentistics/core`'s `commentThread`: a group shows its own comments plus
 * its members', the task shows everything) is applied exactly once.
 *
 * The dialog fetches the task's detail ITSELF (`useTaskDetail`) instead of borrowing the table's
 * cached copy: a task row that was never expanded has no detail, and a cached one can be stale. A
 * write reloads it, then tells the caller (`onChanged`) so the counts on the table follow.
 *
 * On a phone it is full-screen (CLAUDE.md: centred fixed-width dialogs are pushed off-screen by iOS
 * Safari); every control's 44px mobile hit area is projected by `.ag-tap-icon`, not painted.
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTaskDetail } from '../../lib/tasks'
import { microLabel, surface } from './board'
import { CommentsTab } from './DeliveryDetail'
import type { Lang } from './copy'

export function CommentThreadDialog({ taskId, target, title, lang, onClose, onChanged }: {
  taskId: string
  /** The subtask or group id; null = the task's own thread. */
  target: string | null
  /** What the thread is about — the row's own name, shown in the header. */
  title: string
  lang: Lang
  onClose: () => void
  onChanged?: () => unknown
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const { detail, error, reload } = useTaskDetail(taskId)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 998 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={pt ? `Comentários: ${title}` : `Comments: ${title}`}
        style={{
          position: 'fixed', zIndex: 999, ...surface, background: 'var(--bg-elevated)',
          boxShadow: 'var(--shadow-elevated)', display: 'grid', gridTemplateRows: 'auto 1fr',
          ...(isMobile
            ? { inset: 0, width: '100%', height: '100%', borderRadius: 0, padding: '12px 16px' }
            : { inset: 0, margin: 'auto', width: 'min(620px, calc(92vw / var(--ag-zoom, 1)))', height: 'min(720px, calc(86vh / var(--ag-zoom, 1)))', padding: 14 }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginBottom: 10 }}>
          <MessageSquare size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <span style={microLabel}>{pt ? 'Comentários' : 'Comments'}</span>
          <span style={{
            fontSize: 13, color: 'var(--text-primary)', fontWeight: 600, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }} title={title}>{title}</span>
          <button
            onClick={onClose}
            aria-label={pt ? 'Fechar' : 'Close'}
            className="ag-tap-icon"
            style={{
              background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              // 30 + 2 x 7px of `.ag-tap-icon` growth = a 44px target on a phone.
              minWidth: isMobile ? 30 : 24, minHeight: isMobile ? 30 : 24,
            }}
          ><X size={16} /></button>
        </div>
        <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0 }}>
          {detail
            ? (
              <CommentsTab
                id={taskId}
                detail={detail}
                target={target}
                lang={lang}
                onChanged={async () => { await reload(); await onChanged?.() }}
              />
            )
            : (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: 8 }}>
                {error
                  ? (pt ? 'Não foi possível ler esta tarefa.' : 'This task could not be read.')
                  : (pt ? 'Carregando…' : 'Loading…')}
              </div>
            )}
        </div>
      </div>
    </>,
    document.body,
  )
}

/**
 * The count a row shows, as the control that opens its thread. Zero still renders a (quiet) button —
 * a row with nothing said yet is exactly where somebody needs a way to say the first thing.
 */
export function CommentCountButton({ count, label, mobile, onOpen }: {
  count: number
  /** The accessible name — names the row, e.g. "Comments on Login form". */
  label: string
  mobile: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onOpen() }}
      aria-label={`${label} (${count})`}
      title={label}
      className="ag-tap-icon"
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0,
        color: count > 0 ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        // `.ag-tap-icon` grows the hit area by `--ag-tap-grow` (7px) per side on a phone, so a 30px
        // painted box is a 44px target — without painting the 44x44 square touchTarget.lint refuses.
        minWidth: mobile ? 30 : 22, minHeight: mobile ? 30 : 18,
      }}
    >
      <MessageSquare size={11} />{count > 0 ? count : ''}
    </button>
  )
}
