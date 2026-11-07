/**
 * EvolutionDetails — the "who and why" cards (QA rejections by AUTHOR model, blocks by reason, the queue, cost by model
 * and harness) and the table of the deliveries behind every number. Plain bars and a real table; on a phone the table
 * becomes a list of cards. A row opens its task on the board.
 */
import { useNavigate } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { NONE_KEY, type MetricRow, type MetricsReply } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { RecordCard, dialogButtonStyle } from '../../pages/settings/primitives'
import { StageChip } from '../calendar/calendarUi'
import { harnessName } from '../../lib/evolutionFilters'
import { QA_LABEL, PRIORITY_NAME } from '../../lib/evolutionFilters'
import { TEXT, pick } from './evolutionText'
import { blockReasonLabel, fmtDur, fmtNum, fmtPct } from './evolutionModel'

export interface Bar { key: string; label: string; v: number; max: number; right: string; color: string; title?: string }

export function HBars({ bars, empty }: { bars: Bar[]; empty: string }) {
  if (bars.length === 0) return <div data-evo-bars-empty style={{ padding: '14px 4px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{empty}</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {bars.map(b => (
        <div key={b.key} data-evo-bar={b.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 1.3fr) 2fr minmax(52px, auto)', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span title={b.title ?? b.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{b.label}</span>
          <span style={{ height: 8, background: 'var(--bg-elevated)', borderRadius: 4, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.min(100, (b.v / (b.max || 1)) * 100)}%`, background: b.color, borderRadius: 4 }} />
          </span>
          <span style={{ textAlign: 'right', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{b.right}</span>
        </div>
      ))}
    </div>
  )
}

const modelName = (m: string, pt: boolean) => (m === NONE_KEY ? pick(TEXT.unknownModel, pt) : m)

export function qaBars(r: MetricsReply, pt: boolean): Bar[] {
  return r.qaByAuthor.map(a => ({
    key: a.model, label: modelName(a.model, pt), v: a.rate ?? 0, max: 1, color: '#ff5f5f',
    right: `${fmtPct(a.rate, pt)} · ${a.rejected}/${a.n}`,
    title: `${modelName(a.model, pt)} — ${pick(TEXT.qaBarTip(a.rejected, a.n, a.adjustAvg === null ? '—' : fmtNum(a.adjustAvg, pt, 1)), pt)}`,
  }))
}

export function blockBars(r: MetricsReply, pt: boolean): Bar[] {
  const max = Math.max(1, ...r.blocks.map(b => b.ms))
  return r.blocks.map(b => ({ key: b.reason, label: blockReasonLabel(b.reason, pt), v: b.ms, max, color: '#c2410c', right: `${fmtDur(b.ms, pt)} · ${b.count}` }))
}

export function queueBars(r: MetricsReply, pt: boolean): Bar[] {
  const max = Math.max(1, ...r.queue.map(q => q.ageMs))
  return r.queue.map(q => ({ key: q.subtaskId, label: q.title, v: q.ageMs, max, color: q.ageMs > 72 * 3_600_000 ? '#f87171' : '#8b8b95', right: fmtDur(q.ageMs, pt) }))
}

export function costBars(r: MetricsReply, pt: boolean, cost: (usd: number) => string, by: 'author' | 'harness'): Bar[] {
  const rows = by === 'author' ? r.costByAuthor : r.costByHarness
  const max = Math.max(0, ...rows.map(c => c.costUSD))
  return rows.map(c => ({
    key: c.key, label: c.key === NONE_KEY ? pick(by === 'author' ? TEXT.unknownModel : TEXT.unknownHarness, pt) : by === 'harness' ? harnessName(c.key) : c.key,
    v: c.costUSD, max, color: '#818cf8', right: `${cost(c.costUSD)} · ${c.deliveries}`,
  }))
}

// ---------------------------------------------------------------------------------------------- the table

function Cell({ children, right, title }: { children: ReactNode; right?: boolean; title?: string }) {
  return <td title={title} style={{ padding: '7px 10px', textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)', maxWidth: right ? undefined : 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</td>
}

const dateOf = (ms: number | null, pt: boolean): string => (ms === null ? '—' : new Date(ms).toLocaleDateString(pt ? 'pt-BR' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))

export function EvolutionTable({ rows, total, pt, cost, maxHeight }: { rows: MetricRow[]; total: number; pt: boolean; cost: (usd: number) => string; maxHeight: number | null }) {
  const isMobile = useIsMobile()
  const nav = useNavigate()
  // A phone gets cards, and 70 of them is a 20 000px page: ten at a time.
  const [more, setMore] = useState(10)
  const open = (r: MetricRow) => nav(`/tasks/${encodeURIComponent(r.taskId)}`)
  const qaText = (r: MetricRow) => pick(QA_LABEL[r.qaResult], pt)
  const model = (r: MetricRow) => (r.authorModel ? r.authorModel : '—')
  const note = rows.length < total ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '6px 2px' }}>{pick(TEXT.showingN(rows.length, total), pt)}</div> : null
  if (isMobile) {
    return (
      <div data-evo-table style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.slice(0, more).map(r => (
          <RecordCard key={r.subtaskId} title={r.title} subtitle={r.taskTitle} badge={<StageChip stage={r.stage} pt={pt} />} onClick={() => open(r)} wrapTitle
            fields={[
              { label: pick(TEXT.colLead, pt), value: fmtDur(r.leadMs, pt) },
              { label: pick(TEXT.colVersion, pt), value: r.version ?? '—' },
              { label: pick(TEXT.colModel, pt), value: model(r) },
              { label: pick(TEXT.colQa, pt), value: qaText(r) },
              { label: pick(TEXT.colBlocked, pt), value: r.blockedMs > 0 ? fmtDur(r.blockedMs, pt) : '—' },
              { label: pick(TEXT.colCost, pt), value: r.costUSD === null ? '—' : cost(r.costUSD) },
            ]} />
        ))}
        {rows.length > more && <button type="button" data-evo-more onClick={() => setMore(m => m + 10)} style={dialogButtonStyle('secondary', true)}>{pick(TEXT.showMore(Math.min(10, rows.length - more), rows.length - more), pt)}</button>}
        {note}
      </div>
    )
  }
  const th = (t: string, right = false) => <th key={t} style={{ position: 'sticky', top: 0, background: 'var(--bg-card)', textAlign: right ? 'right' : 'left', padding: '7px 10px', fontSize: 10.5, fontWeight: 600, color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{t}</th>
  return (
    <div data-evo-table>
      <div style={{ overflow: 'auto', maxHeight: maxHeight ?? undefined }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            {th(pick(TEXT.colDelivery, pt))}{th(pick(TEXT.colStage, pt))}{th(pick(TEXT.colVersion, pt))}{th(pick(TEXT.colModel, pt))}{th(pick(TEXT.colPriority, pt))}
            {th(pick(TEXT.colLead, pt), true)}{th(pick(TEXT.colQa, pt))}{th(pick(TEXT.colBlocked, pt), true)}{th(pick(TEXT.colCost, pt), true)}{th(pick(TEXT.colPublished, pt), true)}
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.subtaskId} data-evo-row={r.subtaskId} onClick={() => open(r)} style={{ cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                <Cell title={`${r.title} — ${r.taskTitle}`}><span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{r.title}</span> <span style={{ color: 'var(--text-tertiary)' }}>· {r.taskTitle}</span></Cell>
                <Cell><StageChip stage={r.stage} pt={pt} /></Cell>
                <Cell>{r.version ?? '—'}</Cell>
                <Cell>{model(r)}</Cell>
                <Cell>{r.priority ? pick(PRIORITY_NAME[r.priority], pt) : '—'}</Cell>
                <Cell right>{fmtDur(r.leadMs, pt)}</Cell>
                <Cell>{qaText(r)}</Cell>
                <Cell right>{r.blockedMs > 0 ? fmtDur(r.blockedMs, pt) : '—'}</Cell>
                <Cell right>{r.costUSD === null ? '—' : cost(r.costUSD)}</Cell>
                <Cell right>{dateOf(r.publishedAtMs, pt)}</Cell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note}
    </div>
  )
}
