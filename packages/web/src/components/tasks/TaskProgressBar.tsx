import { useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { taskProgress, type TaskStatusDef } from '@agentistics/core'
import { liveStatusOrder, microLabel, statusStyle } from './board'
import { statusLabel, type Lang } from './copy'

export interface ProgressTooltipModel {
  summary: string
  statuses: Array<{ id: string; label: string; count: number; color: string }>
  titles: string[]
  moreTitles: number
}

export function progressTooltipModel(done: number, total: number, percent: number, counts: Readonly<Record<string, number>>, statuses: readonly TaskStatusDef[] | null, lang: Lang, titles: readonly string[] = []): ProgressTooltipModel {
  const order = liveStatusOrder(statuses)
  const ids = [...order, ...Object.keys(counts).filter(id => !order.includes(id))]
  return {
    summary: lang === 'pt' ? `${done} de ${total} concluídas (${percent}%)` : `${done} of ${total} completed (${percent}%)`,
    statuses: ids.filter(id => (counts[id] ?? 0) > 0).map(id => ({ id, label: statusLabel(id, lang, statuses), count: counts[id]!, color: statusStyle(statuses, id).color })),
    titles: [...titles].slice(0, 8), moreTitles: Math.max(0, titles.length - 8),
  }
}

export function ProgressTooltip({ model, x, y }: { model: ProgressTooltipModel; x: number; y: number }) {
  return createPortal(
    <span role="tooltip" style={{ position: 'fixed', left: x, top: y, transform: 'translateY(-100%)', zIndex: 4000, pointerEvents: 'none', width: 360, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 5, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 10, lineHeight: 1.45, boxShadow: '0 3px 12px rgba(0,0,0,.25)' }}>
      <span style={{ display: 'block', fontWeight: 650, marginBottom: 3 }}>{model.summary}</span>
      {model.statuses.map(s => <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, flex: '0 0 auto' }} />{s.label} {s.count}</span>)}
      {model.titles.length > 0 && <span style={{ display: 'block', marginTop: 4, color: 'var(--text-secondary)' }}>{model.titles.map(title => <span key={title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>)}{model.moreTitles > 0 && <span style={{ display: 'block' }}>+{model.moreTitles}</span>}</span>}
    </span>, document.body,
  )
}

export function TaskProgressBar({ done, total, inProgress = 0, blocked = 0, statusCounts, statuses = null, showPercent = true, height = 4, label, subtaskTitles = [], lang = 'en' }: {
  done: number; total: number; showPercent?: boolean; height?: number; inProgress?: number; blocked?: number
  statusCounts?: Readonly<Record<string, number>>; statuses?: readonly TaskStatusDef[] | null; label?: string
  subtaskTitles?: readonly string[]; lang?: Lang
}) {
  const p = taskProgress(done, total, inProgress, blocked, statusCounts)
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null)
  if (p.percent === null) return null
  const order = liveStatusOrder(statuses)
  const ids = [...order, ...Object.keys(p.counts).filter(id => !order.includes(id))]
  const showTooltip = (e: MouseEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); setTooltip({ x: r.left, y: r.top - 7 }) }
  const model = progressTooltipModel(p.done, p.total, p.percent, p.counts, statuses, lang, subtaskTitles)
  let left = 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      {label && <span style={{ ...microLabel, fontSize: 9, flexShrink: 0 }}>{label}</span>}
      <div onMouseEnter={showTooltip} onMouseLeave={() => setTooltip(null)} style={{ flex: 1, minWidth: 24, height, borderRadius: height / 2, background: 'var(--bg-elevated)', overflow: 'hidden', position: 'relative' }} aria-label={`${p.percent}% · ${p.done} de ${p.total}`}>
        {ids.map(id => {
          const count = p.counts[id] ?? 0
          if (count <= 0) return null
          const width = count / p.total * 100
          const node = <i key={id} aria-label={`${statusStyle(statuses, id).label}: ${count}`} style={{ position: 'absolute', left: `${left}%`, top: 0, width: `${width}%`, height: '100%', background: statusStyle(statuses, id).color }} />
          left += width
          return node
        })}
      </div>
      {showPercent && <span style={{ ...microLabel, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums', color: p.complete ? statusStyle(statuses, 'done').color : 'var(--text-tertiary)' }}>{p.percent}% · {p.done}/{p.total}</span>}
      {tooltip && typeof document !== 'undefined' && <ProgressTooltip model={model} x={tooltip.x} y={tooltip.y} />}
    </div>
  )
}
