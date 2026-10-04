/**
 * ManageStatusesModal — the status VOCABULARY, editable.
 *
 * A dedicated, self-contained screen rather than an inline edit inside `SubtaskTable`/`TaskTable`/
 * the kanban columns: those still draw the board through `board.ts`'s fixed seven-status map (see
 * that file's own note — wiring the DYNAMIC list into row/kanban rendering is a follow-up piece of
 * work, done once, everywhere at once, rather than here). This modal only ever talks to
 * `/api/tasks/statuses` (`task-web.ts`'s `listStatuses`/`createStatus`/`editStatus`/`deleteStatus`);
 * it does not touch a task, a subtask, or anything the board currently renders.
 *
 * `todo` / `in_progress` / `blocked` / `done` (`protected: true`) can have their label and colour
 * edited exactly like any other status — only their id can never change, and deleting them is
 * refused regardless of usage (`canDeleteStatus`, `@agentistics/core`). Every other status — the
 * legacy `backlog`/`in_review`/`abandoned` a migrated machine may carry, and anything a person has
 * since created — is deletable the moment nothing on the board still points at it, and the delete
 * control is disabled with a reason BEFORE the click, not refused after it: `usageCount` travels
 * with the list precisely so this screen never has to guess.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Lock, Plus, Settings2, Trash2, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useDismissOverlay } from '../../lib/dismissOverlay'
import { overlayPadding } from '../../lib/mobileOverlay'
import {
  createTaskStatus, createTaskType, deleteTaskStatus, deleteTaskType, editTaskStatus, editTaskType,
  fetchTaskStatuses, fetchTaskTypes, type TaskStatusRow, type TaskTypeRow,
} from '../../lib/tasks'
import { button, field, microLabel, surface } from './board'
import { boardCopy, type Lang } from './copy'

/**
 * The modal edits ONE vocabulary, chosen by `kind` — the status list or the task-type list. The two
 * are the same shape (id, label, colour, usage) and the same gestures, so they share this screen
 * rather than a clone of it; what differs is the endpoint set, the words, and that only a status
 * can be `protected`.
 */
export type VocabKind = 'status' | 'type'
type VocabRow = (TaskStatusRow | TaskTypeRow) & { protected?: boolean }

interface VocabApi {
  fetch: () => Promise<VocabRow[]>
  create: (label: string, color: string) => Promise<{ ok: true; row: VocabRow } | { ok: false }>
  edit: (id: string, patch: { label?: string; color?: string }) => Promise<boolean>
  remove: (id: string) => Promise<{ ok: boolean }>
}

const API: Record<VocabKind, VocabApi> = {
  status: {
    fetch: fetchTaskStatuses,
    create: async (l, c) => { const o = await createTaskStatus(l, c); return o.ok ? { ok: true, row: o.status } : { ok: false } },
    edit: editTaskStatus,
    remove: deleteTaskStatus,
  },
  type: {
    fetch: fetchTaskTypes,
    create: async (l, c) => { const o = await createTaskType(l, c); return o.ok ? { ok: true, row: o.type } : { ok: false } },
    edit: editTaskType,
    remove: deleteTaskType,
  },
}

/** The same eight-swatch row `TagsPage.tsx` uses for a tag's colour, restated here — a status and a
 *  tag both want "pick one of a handful, or open the native picker for anything else", and the two
 *  screens are far enough apart in the tree that importing one from the other would be a stranger
 *  coupling than repeating eight hex strings. */
const SWATCHES: string[] = [
  '#3b82f6', '#e8703a', '#ef4444', '#22c55e',
  '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8',
]

function ColorPicker({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
      {SWATCHES.map(c => {
        const selected = color.toLowerCase() === c.toLowerCase()
        return (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={selected}
            onClick={() => onPick(c)}
            className="ag-tap-icon"
            style={{
              width: 30, height: 30, padding: 0, border: 'none', background: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{
              width: 20, height: 20, borderRadius: '50%', background: c, display: 'block',
              boxShadow: selected ? `0 0 0 2px var(--bg-card), 0 0 0 4px ${c}` : 'none',
              transition: 'box-shadow 0.15s, transform 0.15s',
              transform: selected ? 'scale(1)' : 'scale(0.9)',
            }} />
          </button>
        )
      })}
      <label
        title="Custom colour"
        className="ag-tap-icon"
        style={{
          width: 30, height: 30, cursor: 'pointer', position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}
      >
        <span style={{
          width: 20, height: 20, borderRadius: '50%', display: 'block',
          background: 'conic-gradient(#ef4444, #f59e0b, #84cc16, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444)',
        }} />
        <input
          type="color" value={color} onChange={e => onPick(e.target.value)}
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
        />
      </label>
    </div>
  )
}

/** Why a delete control is disabled, said in words rather than left to a tooltip nobody hovers on
 *  a touch screen. */
function deleteReason(row: VocabRow, lang: Lang, kind: VocabKind): string | null {
  if (kind === 'type') {
    return row.usageCount > 0 ? boardCopy(lang).types.inUse.replace('{n}', String(row.usageCount)) : null
  }
  if (row.protected) {
    return lang === 'pt'
      ? 'Este é um dos quatro status protegidos e nunca pode ser excluído.'
      : 'This is one of the four protected statuses and can never be deleted.'
  }
  if (row.usageCount > 0) {
    return lang === 'pt'
      ? `Em uso por ${row.usageCount} tarefa${row.usageCount === 1 ? '' : 's'}/subtarefa${row.usageCount === 1 ? '' : 's'} — remova-o de lá primeiro.`
      : `In use by ${row.usageCount} task${row.usageCount === 1 ? '' : 's'}/subtask${row.usageCount === 1 ? '' : 's'} — clear it there first.`
  }
  return null
}

function StatusRow({
  row, lang, kind, onSaved, onDeleted,
}: {
  row: VocabRow
  lang: Lang
  kind: VocabKind
  onSaved: (next: VocabRow) => void
  onDeleted: () => void
}) {
  const isMobile = useIsMobile()
  const [label, setLabel] = useState(row.label)
  const [color, setColor] = useState(row.color)
  const [pickingColor, setPickingColor] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const dirty = label.trim() !== row.label || color.toLowerCase() !== row.color.toLowerCase()
  const refusal = deleteReason(row, lang, kind)
  const api = API[kind]

  const save = async () => {
    const nextLabel = label.trim()
    if (!nextLabel) { setLabel(row.label); return }
    if (!dirty) return
    setBusy(true)
    const ok = await api.edit(row.id, { label: nextLabel, color })
    setBusy(false)
    if (ok) onSaved({ ...row, label: nextLabel, color })
    else { setLabel(row.label); setColor(row.color) }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setPickingColor(v => !v)}
          title={lang === 'pt' ? 'Cor' : 'Colour'}
          className="ag-tap-icon"
          style={{
            width: 26, height: 26, borderRadius: '50%', background: color, border: 'none',
            cursor: 'pointer', flexShrink: 0,
          }}
        />
        {pickingColor && (
          <div style={{
            position: 'absolute', top: 32, left: 0, zIndex: 10, ...surface,
            background: 'var(--bg-card)', padding: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
          }}>
            <ColorPicker
              color={color}
              onPick={c => {
                setColor(c)
                setPickingColor(false)
                // Colour is saved immediately — it needs no confirmation step the way the label
                // does (there is no "half-typed colour" the way there is a half-typed word), and
                // waiting for a blur the picker itself never causes would leave the swatch looking
                // changed while the server still held the old value.
                void api.edit(row.id, { color: c }).then(ok => { if (ok) onSaved({ ...row, color: c }) })
              }}
            />
          </div>
        )}
      </div>
      <input
        value={label}
        onChange={e => setLabel(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        style={{ ...field(isMobile), flex: 1, minWidth: 0, padding: isMobile ? '9px 10px' : '5px 8px' }}
        disabled={busy}
      />
      {dirty && !busy && (
        <button
          type="button" onClick={() => void save()} title={lang === 'pt' ? 'Salvar' : 'Save'}
          className="ag-tap-icon"
          style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'var(--accent-green-dim)', color: 'var(--accent-green)',
            borderRadius: 6, cursor: 'pointer', flexShrink: 0,
          }}
        ><Check size={14} /></button>
      )}
      {row.protected && (
        <span
          title={lang === 'pt' ? 'Status protegido' : 'Protected status'}
          style={{
            display: 'flex', alignItems: 'center', color: 'var(--text-tertiary)', flexShrink: 0,
          }}
        ><Lock size={13} /></span>
      )}
      {!row.protected && (
        confirmDelete ? (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button
              type="button" onClick={() => void (async () => {
                setBusy(true)
                const out = await api.remove(row.id)
                setBusy(false)
                setConfirmDelete(false)
                if (out.ok) onDeleted()
              })()}
              disabled={busy}
              style={{ ...button(isMobile), padding: '0 9px', height: 28, background: 'var(--accent-red)', color: '#fff', border: 'none' }}
            >{lang === 'pt' ? 'Excluir' : 'Delete'}</button>
            <button
              type="button" onClick={() => setConfirmDelete(false)}
              style={{ ...button(isMobile), padding: '0 9px', height: 28 }}
            >{lang === 'pt' ? 'Cancelar' : 'Cancel'}</button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={refusal !== null}
            title={refusal ?? (kind === 'type' ? boardCopy(lang).types.deleteTitle : lang === 'pt' ? 'Excluir status' : 'Delete status')}
            className="ag-tap-icon"
            style={{
              width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', background: 'transparent',
              color: refusal ? 'var(--text-tertiary)' : 'var(--accent-red)',
              opacity: refusal ? 0.45 : 1,
              cursor: refusal ? 'not-allowed' : 'pointer', borderRadius: 6, flexShrink: 0,
            }}
          ><Trash2 size={14} /></button>
        )
      )}
    </div>
  )
}

export interface ManageStatusesModalProps {
  lang: Lang
  onClose: () => void
  /** Which vocabulary this edits. Default `status`. */
  kind?: VocabKind
}

export function ManageStatusesModal({ lang, onClose, kind = 'status' }: ManageStatusesModalProps) {
  const api = API[kind]
  const T = boardCopy(lang).types
  const isMobile = useIsMobile()
  const dismiss = useDismissOverlay(onClose)
  const [rows, setRows] = useState<VocabRow[] | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState(SWATCHES[0]!)
  const [pickingNewColor, setPickingNewColor] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const reload = async () => setRows(await api.fetch())
  useEffect(() => { void reload() }, [kind])

  const onCreate = async () => {
    const label = newLabel.trim()
    if (!label) return
    setCreating(true)
    setCreateError(null)
    const out = await api.create(label, newColor)
    setCreating(false)
    if (out.ok) {
      setRows(r => [...(r ?? []), out.row])
      setNewLabel('')
    } else {
      setCreateError(kind === 'type' ? T.createError : lang === 'pt'
        ? 'Não foi possível criar o status. Tente novamente.'
        : 'Could not create the status. Try again.')
    }
  }

  return createPortal(
    <div
      {...dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
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
            : { width: '100%', maxWidth: 480, maxHeight: 'calc(82vh / var(--ag-zoom, 1))', borderRadius: 12, overflowY: 'auto' }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', padding: 8, borderRadius: 9,
            background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
          }}><Settings2 size={17} /></span>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>
            {kind === 'type' ? T.manage : lang === 'pt' ? 'Gerenciar status' : 'Manage statuses'}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              ...(isMobile ? { minWidth: 44, minHeight: 44 } : {}),
            }}
          ><X size={16} /></button>
        </div>

        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {kind === 'type' ? T.intro : lang === 'pt' ? (
            <>
              <strong style={{ color: 'var(--text-secondary)' }}>A fazer</strong>,{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>Em andamento</strong>,{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>Bloqueado</strong> e{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>Concluído</strong> (marcados com{' '}
              <Lock size={10} style={{ verticalAlign: -1 }} />) nunca podem ser excluídos, mas o nome e a
              cor de qualquer um podem mudar. Um status sem uso pode ser excluído a qualquer momento.
            </>
          ) : (
            <>
              <strong style={{ color: 'var(--text-secondary)' }}>To do</strong>,{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>In progress</strong>,{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>Blocked</strong> and{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>Done</strong> (marked with{' '}
              <Lock size={10} style={{ verticalAlign: -1 }} />) can never be deleted, but any status's
              name and colour can change. An unused status can be deleted at any time.
            </>
          )}
        </p>

        <div style={{ display: 'grid' }}>
          {rows === null && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 4px' }}>
              {lang === 'pt' ? 'Carregando…' : 'Loading…'}
            </div>
          )}
          {rows?.map(row => (
            <StatusRow
              key={row.id}
              row={row}
              lang={lang}
              kind={kind}
              onSaved={next => setRows(r => (r ?? []).map(x => (x.id === next.id ? next : x)))}
              onDeleted={() => setRows(r => (r ?? []).filter(x => x.id !== row.id))}
            />
          ))}
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>
            {kind === 'type' ? T.newLabel : lang === 'pt' ? 'Novo status' : 'New status'}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setPickingNewColor(v => !v)}
                title={lang === 'pt' ? 'Cor' : 'Colour'}
                className="ag-tap-icon"
                style={{
                  width: 30, height: 30, borderRadius: '50%', background: newColor, border: 'none',
                  cursor: 'pointer', flexShrink: 0,
                }}
              />
              {pickingNewColor && (
                <div style={{
                  position: 'absolute', bottom: 36, left: 0, zIndex: 10, ...surface,
                  background: 'var(--bg-card)', padding: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
                }}>
                  <ColorPicker color={newColor} onPick={setNewColor} />
                </div>
              )}
            </div>
            <input
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void onCreate() }}
              placeholder={kind === 'type' ? T.placeholder : lang === 'pt' ? 'ex.: Aguardando cliente' : 'e.g. Waiting on client'}
              style={{ ...field(isMobile), flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              onClick={() => void onCreate()}
              disabled={!newLabel.trim() || creating}
              style={{
                ...button(isMobile, 'primary'),
                ...(!newLabel.trim() ? { opacity: 0.55 } : {}),
              }}
            ><Plus size={14} /> {lang === 'pt' ? 'Adicionar' : 'Add'}</button>
          </div>
          {createError && (
            <span style={{ fontSize: 11, color: 'var(--accent-red)' }}>{createError}</span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
