/**
 * AgendaView — the list by day. It is the WEEK on a desktop (seven columns, Monday first) and the whole calendar on a
 * phone (days stacked, no grid: a grid does not fit 390 px). Both draw the same entries from the one `agendaOf`:
 * what shipped, what is expected, the accounts renewing, the due days. A row says its hour or, honestly, that it has none.
 */
import { RefreshCw, Flag } from 'lucide-react'
import { brtDay, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { addDays, agendaOf, clock, dowShort, monthName, relativeDay, weekdayMon0, weekDays, type AgendaEntry } from '../../lib/calendarModel'
import { TEXT, pick } from './calendarText'
import { Confidence, EXPECTED_COLOR, PUBLISHED_COLOR, PriorityFlag, StageChip, VersionGlyph } from './calendarUi'

interface Handlers {
  onOpenPiece: (key: string, e: React.MouseEvent) => void
  onOpenVersion: (version: string, e: React.MouseEvent) => void
  onOpenMark: (m: CalMark, e: React.MouseEvent) => void
}

function Entry({ e, pt, marks, selected, h }: { e: AgendaEntry; pt: boolean; marks: readonly CalMark[]; selected: string | null; h: Handlers }) {
  const box = (sel: boolean): React.CSSProperties => ({
    display: 'flex', flexDirection: 'column', gap: 4, width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--radius-md)', cursor: 'pointer', font: 'inherit',
    background: 'var(--bg-card)', color: 'var(--text-primary)', border: `1px solid ${sel ? 'var(--anthropic-orange)' : 'var(--border)'}`, minHeight: 44,
  })
  if (e.kind === 'version') {
    const v = e.version, published = e.state === 'published', c = published ? PUBLISHED_COLOR : EXPECTED_COLOR
    return (
      <button type="button" data-cal-entry="version" onClick={ev => h.onOpenVersion(v.version, ev)} style={box(selected === v.version)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 }}>
          <span style={{ color: c, display: 'inline-flex' }}><VersionGlyph published={published} /></span>
          {v.version} {published ? pick(TEXT.published, pt) : pick(TEXT.expected, pt)}
          <span style={{ marginLeft: 'auto' }}><Confidence level={published ? null : v.confidence} pt={pt} /></span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pick(TEXT.pieces(v.pieceKeys.length), pt)}{v.basis === 'partial' ? ` · ${pick(TEXT.expected, pt)}` : ''}</span>
      </button>
    )
  }
  if (e.kind === 'resets') {
    return (
      <button type="button" data-cal-entry="resets" onClick={ev => h.onOpenMark(marks.find(m => m.kind === 'account-reset' && brtDay(m.atMs) === brtDay(e.atMs))!, ev)} style={box(false)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: 'var(--accent-cyan)' }}><RefreshCw size={13} aria-hidden />{pick(TEXT.accountsRenew, pt)}</span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{e.items.map(i => `${i.label} ${clock(i.atMs)}`).join(' · ')}</span>
      </button>
    )
  }
  if (e.kind === 'due') {
    return (
      <button type="button" data-cal-entry="due" onClick={ev => h.onOpenMark(e.mark, ev)} style={box(false)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: 'var(--accent-amber)' }}><Flag size={12} aria-hidden />{pick(TEXT.due, pt)} · {e.mark.label}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pick(TEXT.noTime, pt)}</span>
      </button>
    )
  }
  const p: CalPiece = e.piece
  return (
    <button type="button" data-cal-entry="piece" onClick={ev => h.onOpenPiece(p.key, ev)} style={box(selected === p.key)}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{p.title}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
        <StageChip stage={p.stage} pt={pt} />{e.state === 'expected' ? pick(TEXT.expected, pt) : pick(TEXT.published, pt)}<PriorityFlag priority={p.priority} pt={pt} />
      </span>
    </button>
  )
}

const timeOf = (e: AgendaEntry, pt: boolean): string => (e.atMs === null ? '' : e.kind === 'version' && e.state === 'expected' ? `~${clock(e.atMs)}` : e.kind === 'piece' && e.state === 'expected' ? `~${clock(e.atMs)}` : clock(e.atMs))

export function AgendaView({ mode, anchor, nowMs, versions, pieces, marks, pt, selected, span = 31, ...h }: {
  mode: 'week' | 'agenda'; anchor: string; /** The phone's list: how many days forward from the anchor. */ span?: number; nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean; selected: string | null
} & Handlers) {
  const today = brtDay(nowMs)
  const src = { versions, pieces, marks }
  if (mode === 'week') {
    return (
      <div data-cal-week-view style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', overflow: 'hidden' }}>
        {weekDays(anchor).map((d, i) => {
          const list = agendaOf(d, src)
          return (
            <div key={d} data-cal-weekday={d} style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: i ? '1px solid var(--border)' : 0, background: d === today ? 'linear-gradient(180deg, var(--anthropic-orange-dim), transparent 40%)' : undefined }}>
              <div style={{ padding: '7px 8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11.5, fontWeight: 600, color: d === today ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)' }}>
                {dowShort(i, pt)} <span style={{ fontSize: 13, color: d === today ? 'var(--anthropic-orange-light)' : 'var(--text-primary)' }}>{Number(d.slice(8))}</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {list.map((e, k) => (
                  <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {e.atMs !== null && <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{timeOf(e, pt)}</span>}
                    <Entry e={e} pt={pt} marks={marks} selected={selected} h={h} />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }
  // The phone's agenda: every day that has something, from the anchor forward (and the anchor itself, even empty).
  const days = Array.from({ length: span }, (_, i) => addDays(anchor, i)).filter(d => d === anchor || agendaOf(d, src).length > 0)
  return (
    <div data-cal-agenda style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
      {days.map(d => {
        const list = agendaOf(d, src)
        return (
          <section key={d} data-cal-agenda-day={d}>
            <h3 style={{ margin: '12px 0 6px', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 8, color: d === today ? 'var(--anthropic-orange-light)' : 'var(--text-primary)' }}>
              {dowShort(weekdayMon0(d), pt)} {String(Number(d.slice(8))).padStart(2, '0')} {monthName(Number(d.slice(5, 7)) - 1, pt).slice(0, 3)}
              <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-tertiary)' }}>{relativeDay(d, today, pt)}</span>
            </h3>
            {list.length === 0 && <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>{pick(TEXT.emptyTitle, pt)}</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {list.map((e, k) => (
                <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ width: 46, flexShrink: 0, paddingTop: 10, fontSize: 11.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{timeOf(e, pt)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}><Entry e={e} pt={pt} marks={marks} selected={selected} h={h} /></div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
