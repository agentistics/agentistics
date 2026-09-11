/**
 * SubtaskTable — the subtasks, as the SAME grid the table view expands inside a row.
 *
 * One component drawn in two places, deliberately: a subtask that shows five columns on the board
 * and a checkbox on the detail page is two different records as far as the reader is concerned, and
 * the one with fewer columns teaches people the fields do not exist. (`TaskTable.tsx`'s inline
 * subitem rows mirror the base columns but do NOT yet draw the two below — a gap worth closing
 * there too, tracked separately rather than done as a side effect of this file.)
 *
 * A subtask carries a SESSION — which piece of work is being done where — and now a ROLLUP of its
 * own: cost, rounds and tokens are still measured per SESSION, never stored on the subtask itself,
 * but the server's `subtaskViews()` (`task-report.ts`) sums a subtask's own sessions the same way
 * `attemptViews()` sums an attempt's, as a partition of the task's rows rather than a second count
 * of them — nothing here double-counts a session or invents a split the data does not record. See
 * docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.2.
 *
 * The Cost/Tokens columns below read `p.subtaskRollups`, keyed by subtask id, and render them with
 * the exact same formatters `TaskTable.tsx`'s own cost/tokens cells use (`useMoney()`, `fmtTokens`,
 * `NA`) — a second formatting rule here would be a second answer for the same figure. A subtask
 * with no session filed yet still gets a bucket from the server (`sessionsUsed: 0`, every metric
 * `null`), and `null` renders as `NA` — never a `0` pretending to be a measurement. The `id: null`
 * direct-branch bucket (sessions filed straight on the delivery) is deliberately NOT drawn as a row
 * here — that footer is `s-2cb8108f97`'s job, once this lands.
 */

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { COLUMN_ORDER, STATUS, fmtTokens, microLabel, numeric, surface, type BoardStatus } from './board'
import { SessionPicker } from './SessionPicker'
import { DatePicker } from '../DatePicker'
import { TaskProgressBar } from './TaskProgressBar'
import { subtaskSessions } from './SubtaskSessions'
import { SubtaskBlockedBy } from './SubtaskBlockedBy'
import { boardCopy, statusLabel, type Lang } from './copy'
import { useMoney } from './money'
import { costCaveat, costCellFor, subtaskRollupOf } from './subtaskRollup'
import type { Subtask, SubtaskView, TaskSessionRow, TaskStatus } from '../../lib/tasks'

function StatusPick({ value, lang, onPick }: {
  value: TaskStatus
  lang: Lang
  onPick: (s: TaskStatus) => void
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const s = STATUS[value as BoardStatus] ?? STATUS.todo
  return (
    <div style={{ position: 'relative' }}>
      <button className="ag-tap"
        onClick={() => setOpen(v => !v)}
        style={{
          border: `1px solid ${s.color}`, cursor: 'pointer', padding: '3px 9px', borderRadius: 5,
          background: s.dim, color: s.color, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
        }}
      >{statusLabel(value, lang)}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 31, marginTop: 4, minWidth: 128,
            ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)',
          }}>
            {COLUMN_ORDER.map(st => {
              const c = STATUS[st]
              return (
                <button
                  // A MENU ROW pays its 44px in PAINT. `.ag-tap` is for controls whose smallness
                  // is their meaning; these sit in a `gap: 2` list, where a projected box covers
                  // the row above and its bottom band selects the row below.
                  key={st} onClick={() => { setOpen(false); onPick(st) }}
                  style={{
                    border: 'none', cursor: 'pointer', textAlign: 'left', padding: '5px 9px',
                    minHeight: isMobile ? 44 : undefined,
                    borderRadius: 5, background: c.dim, color: c.color, fontSize: 10.5, fontWeight: 600,
                  }}
                >{statusLabel(st, lang)}</button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { padding: '7px 9px', borderTop: '1px solid var(--border)' }
const bare: React.CSSProperties = {
  width: '100%', background: 'transparent', border: 'none', outline: 'none',
  color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'inherit',
}

export interface SubtaskTableProps {
  subtasks: Subtask[]
  /** The DELIVERY's sessions. Each row shows the ones filed under it — see `SubtaskSessions`. */
  sessions: readonly TaskSessionRow[]
  /** One rollup per subtask (and the `id: null` direct-branch bucket this table does not draw
   *  yet) — `TaskDetail.subtaskRollups`, straight off the server's `subtaskViews()`. */
  subtaskRollups: readonly SubtaskView[]
  lang: Lang
  onAdd: (title: string) => void | Promise<void>
  onPatch: (id: string, patch: Partial<Subtask>) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  /** File a session under a subtask. */
  onAttach: (subtaskId: string, sessionId: string) => void | Promise<void>
  /** Take a session out of wherever it is filed. */
  onUnfile: (sessionId: string) => void | Promise<void>
  /** Open a session's own screen. Absent renders the reference as a label. */
  onOpenSession?: (sessionId: string) => void
}

export function SubtaskTable(p: SubtaskTableProps) {
  const isMobile = useIsMobile()
  const copy = boardCopy(p.lang)
  const money = useMoney()
  const [draft, setDraft] = useState('')
  const [linking, setLinking] = useState<string | null>(null)

  const done = p.subtasks.filter(t => t.done).length

  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={microLabel}>{copy.subtasks}</span>
        {/* The shared bar — it rounds DOWN, so this one cannot say 100% while the grid below it
            still shows an open row. That disagreement is exactly what one component prevents. */}
        <div style={{ flex: 1, maxWidth: 220 }}>
          <TaskProgressBar done={done} total={p.subtasks.length} />
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
        <thead>
          <tr>
            {[copy.subtasks, 'Status', copy.owner, copy.start, copy.due, copy.sessions, copy.cost, copy.tokens, ''].map((h, i) => (
              <th
                key={i}
                style={{
                  ...microLabel, padding: '6px 9px', fontWeight: 600,
                  textAlign: h === copy.cost || h === copy.tokens ? 'right' : 'left',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.subtasks.length === 0 && (
            <tr>
              <td colSpan={9} style={{ ...cell, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
                {copy.nothingBrokenOut}
              </td>
            </tr>
          )}
          {p.subtasks.map(t => {
            const r = subtaskRollupOf(p.subtaskRollups, t.id)
            const cost = costCellFor(r)
            return (
            <tr key={t.id}>
              <td style={{ ...cell, minWidth: 180 }}>
                <input
                  defaultValue={t.title}
                  onBlur={e => { if (e.target.value.trim() !== t.title) void p.onPatch(t.id, { title: e.target.value }) }}
                  style={{
                    ...bare,
                    color: t.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    textDecoration: t.done ? 'line-through' : 'none',
                    fontSize: 12.5,
                  }}
                />
              </td>
              {/* `minWidth` + `nowrap`: the status chip and the blocked-by badge are two small
                  controls meant to sit on ONE line — without a floor here `table-layout: auto`
                  could squeeze this column below their combined width and wrap the badge onto
                  its own row, which reads as a broken layout rather than two controls. */}
              <td style={{ ...cell, minWidth: 130, whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap' }}>
                  <StatusPick
                    value={t.status} lang={p.lang}
                    onPick={s => void p.onPatch(t.id, { status: s })}
                  />
                  {/* Blockers are SIBLINGS of this same delivery — `p.subtasks` already IS that
                      pool, so no second fetch is needed. */}
                  <SubtaskBlockedBy
                    subtaskId={t.id}
                    blockedBy={t.blockedBy ?? []}
                    siblings={p.subtasks}
                    lang={p.lang}
                    onChange={ids => p.onPatch(t.id, { blockedBy: ids })}
                  />
                </span>
              </td>
              <td style={cell}>
                <input
                  defaultValue={t.assignee ?? ''} placeholder="—"
                  onBlur={e => { if (e.target.value !== (t.assignee ?? '')) void p.onPatch(t.id, { assignee: e.target.value }) }}
                  style={bare}
                />
              </td>
              {/* The dashboard's own picker, not `<input type="date">`: one calendar in the app,
                  and a control that fits the column instead of overflowing it. The label is empty
                  because the column heading above already says which date this is. */}
              <td style={cell}>
                <DatePicker
                  value={t.startDate ?? ''} label="" placeholder="—" lang={p.lang}
                  onChange={v => void p.onPatch(t.id, { startDate: v })}
                />
              </td>
              <td style={cell}>
                <DatePicker
                  value={t.dueDate ?? ''} label="" placeholder="—" lang={p.lang}
                  min={t.startDate || undefined}
                  onChange={v => void p.onPatch(t.id, { dueDate: v })}
                />
              </td>
              <td style={{ ...cell, minWidth: 190 }}>
                {subtaskSessions({
                  subtaskId: t.id,
                  // The row's group siblings show the identical chip list — see
                  // docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §B.4.
                  subtaskIds: t.groupId
                    ? p.subtasks.filter(s => s.groupId === t.groupId).map(s => s.id)
                    : [t.id],
                  sessions: p.sessions,
                  lang: p.lang,
                  mobile: isMobile,
                  onLink: setLinking,
                  onUnfile: sid => void p.onUnfile(sid),
                  onOpen: p.onOpenSession,
                })}
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>
                {/* `r` absent (no bucket at all) reads exactly like an empty one — the "not
                    measured yet" answer for a subtask nobody has filed a session under. */}
                {cost.kind === 'credits' ? (
                  <span style={{ ...numeric, fontSize: 12 }}>{cost.premiumRequests} req</span>
                ) : (
                  <span
                    style={{
                      ...numeric, fontSize: 12,
                      color: cost.kind === 'na' || cost.usd === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)',
                    }}
                    title={costCaveat(r)}
                  >{money(cost.kind === 'money' ? cost.usd : null)}</span>
                )}
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>
                <span style={{ ...numeric, fontSize: 12, color: !r || r.tokens === null ? 'var(--text-tertiary)' : undefined }}>
                  {fmtTokens(r?.tokens ?? null)}
                </span>
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>
                <button
                  onClick={() => void p.onRemove(t.id)} title={copy.remove}
                  style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'inline-flex' }}
                ><Trash2 size={12} /></button>
              </td>
            </tr>
            )
          })}
          <tr>
            <td colSpan={9} style={{ ...cell }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' }}>
                <Plus size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <input
                  value={draft} placeholder={copy.addSubtask}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && draft.trim()) { void p.onAdd(draft.trim()); setDraft('') }
                  }}
                  style={{ ...bare, maxWidth: 340, minHeight: isMobile ? 34 : 20 }}
                />
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {linking && (
        <SessionPicker
          // MULTIPLE, because a subtask holds any number of sessions — and sequential on the way
          // out, since every attach read-modify-writes the same store.
          onPick={async ids => { for (const id of ids) await p.onAttach(linking, id) }}
          onClose={() => setLinking(null)}
        />
      )}
    </div>
  )
}
