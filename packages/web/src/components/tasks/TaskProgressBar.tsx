/**
 * TaskProgressBar — how much of a task its subtasks say is done.
 *
 * One component and one arithmetic (`taskProgress` in `@agentistics/core`), drawn on the card, in
 * the table, on the detail header and over the subtask grid. Four bars computing their own
 * percentage is four chances for the same task to read 66% in one place and 67% in another, which
 * is the kind of disagreement that makes a reader stop believing both.
 *
 * A task with NO subtasks draws nothing at all — not an empty bar. "Nobody broke this up" and
 * "nothing is done yet" are different facts, and a 0% bar on every unbroken task would make the bar
 * mean nothing anywhere.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { taskProgress, type TaskStatusDef } from '@agentistics/core'
import { microLabel, statusStyle } from './board'

export function TaskProgressBar({ done, total, inProgress = 0, blocked = 0, statuses = null, showPercent = true, height = 4, label }: {
  done: number
  total: number
  /** The number beside the bar. Off in the tightest cells, where the bar alone is the signal. */
  showPercent?: boolean
  height?: number
  inProgress?: number
  blocked?: number
  statuses?: readonly TaskStatusDef[] | null
  /** A word before the bar, when it is not obvious what is being counted. */
  label?: string
}) {
  const p = taskProgress(done, total, inProgress, blocked)
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const showTooltip = (text: string, e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltip({ text, x: rect.left, y: rect.top - 7 })
  }
  if (p.percent === null) return null
  const doneStatus = statusStyle(statuses, 'done')
  const inProgressStatus = statusStyle(statuses, 'in_progress')
  const blockedStatus = statusStyle(statuses, 'blocked')
  const statusText = (label: string, count: number) => `${label}: ${count}`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      {label && <span style={{ ...microLabel, fontSize: 9, flexShrink: 0 }}>{label}</span>}
      <div style={{
        flex: 1, minWidth: 24, height, borderRadius: height / 2,
        background: 'var(--bg-elevated)', overflow: 'visible', position: 'relative',
      }}>
        <div onMouseEnter={e => showTooltip(statusText(doneStatus.label, p.done), e)} onMouseLeave={() => setTooltip(null)} style={{
          position: 'relative',
          width: `${p.donePercent}%`, height: '100%', borderRadius: height / 2,
          background: doneStatus.color,
          transition: 'width 0.2s',
        }} aria-label={`${p.percent}% concluído · ${p.done} de ${p.total} subtarefas`} />
        {p.inProgressPercent != null && p.inProgressPercent > 0 && (
          <div onMouseEnter={e => showTooltip(statusText(inProgressStatus.label, p.inProgress ?? 0), e)} onMouseLeave={() => setTooltip(null)} style={{
            position: 'absolute', left: `${p.donePercent}%`, top: 0,
            width: `${p.inProgressPercent}%`, height: '100%', background: inProgressStatus.color,
            transition: 'left 0.2s, width 0.2s',
          }} aria-label={`${p.inProgress} em andamento`} />
        )}
        {p.blockedPercent != null && p.blockedPercent > 0 && (
          <div onMouseEnter={e => showTooltip(statusText(blockedStatus.label, p.blocked ?? 0), e)} onMouseLeave={() => setTooltip(null)} style={{
            position: 'absolute',
            left: `${(p.donePercent ?? 0) + (p.inProgressPercent ?? 0)}%`,
            top: 0,
            width: `${p.blockedPercent}%`,
            height: '100%',
            background: blockedStatus.color,
            transition: 'left 0.2s, width 0.2s',
          }} aria-label={statusText(blockedStatus.label, p.blocked ?? 0)} />
        )}
      </div>
      {showPercent && (
        <span style={{
          ...microLabel, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
          color: p.complete ? doneStatus.color : 'var(--text-tertiary)',
        }}>
          {p.percent}% · {p.done}/{p.total}
        </span>
      )}
      {tooltip && typeof document !== 'undefined' && createPortal(
        <span role="tooltip" style={{ position: 'fixed', left: tooltip.x, top: tooltip.y, transform: 'translateY(-100%)', zIndex: 4000, pointerEvents: 'none', whiteSpace: 'nowrap', padding: '4px 7px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 10, boxShadow: '0 3px 12px rgba(0,0,0,.25)' }}>{tooltip.text}</span>,
        document.body,
      )}
    </div>
  )
}
