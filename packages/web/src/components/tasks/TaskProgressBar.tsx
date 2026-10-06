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
import { taskProgress } from '@agentistics/core'
import { microLabel } from './board'

export function TaskProgressBar({ done, total, inProgress = 0, showPercent = true, height = 4, label }: {
  done: number
  total: number
  /** The number beside the bar. Off in the tightest cells, where the bar alone is the signal. */
  showPercent?: boolean
  height?: number
  inProgress?: number
  /** A word before the bar, when it is not obvious what is being counted. */
  label?: string
}) {
  const p = taskProgress(done, total, inProgress)
  const [hovered, setHovered] = useState<'done' | 'inProgress' | null>(null)
  if (p.percent === null) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      {label && <span style={{ ...microLabel, fontSize: 9, flexShrink: 0 }}>{label}</span>}
      <div style={{
        flex: 1, minWidth: 24, height, borderRadius: height / 2,
        background: 'var(--bg-elevated)', overflow: 'visible', position: 'relative',
      }}>
        <div onMouseEnter={() => setHovered('done')} onMouseLeave={() => setHovered(null)} style={{
          position: 'relative',
          width: `${p.donePercent}%`, height: '100%', borderRadius: height / 2,
          // Green only when it is ACTUALLY finished — the fill rounds down, so a bar that looks
          // full is full. An almost-done task stays orange, which is what "still open" looks like
          // everywhere else on this board.
          background: p.complete ? 'var(--accent-green)' : 'var(--anthropic-orange)',
          transition: 'width 0.2s',
        }} aria-label={`${p.percent}% concluído · ${p.done} de ${p.total} subtarefas`}>
          {hovered === 'done' && <span role="tooltip" style={{ position: 'absolute', bottom: height + 7, left: 0, zIndex: 3, whiteSpace: 'nowrap', padding: '4px 7px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 10, boxShadow: '0 3px 12px rgba(0,0,0,.25)' }}>{p.percent}% concluído · {p.done} de {p.total} subtarefas</span>}
        </div>
        {p.inProgressPercent != null && p.inProgressPercent > 0 && (
          <div onMouseEnter={() => setHovered('inProgress')} onMouseLeave={() => setHovered(null)} style={{
            position: 'absolute', left: `${p.donePercent}%`, top: 0,
            width: `${p.inProgressPercent}%`, height: '100%', background: 'var(--accent-purple)',
            transition: 'left 0.2s, width 0.2s',
          }} aria-label={`${p.inProgress} em andamento`}>
            {hovered === 'inProgress' && <span role="tooltip" style={{ position: 'absolute', bottom: height + 7, left: 0, zIndex: 3, whiteSpace: 'nowrap', padding: '4px 7px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 10, boxShadow: '0 3px 12px rgba(0,0,0,.25)' }}>{p.inProgress} em andamento</span>}
          </div>
        )}
      </div>
      {showPercent && (
        <span style={{
          ...microLabel, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
          color: p.complete ? 'var(--accent-green)' : 'var(--text-tertiary)',
        }}>
          {p.percent}% · {p.done}/{p.total}
        </span>
      )}
    </div>
  )
}
