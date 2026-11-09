/**
 * DayView — the micro level: one BRT day by the hour. An "all day" strip on top carries what has no hour of its own
 * (a version published or expected today, the renewing accounts, due days); below it one column per piece that has
 * anything on that day — where it is now (solid) and the expected rest (dashed, "prev."). The grid scrolls inside
 * itself and opens on the current hour; the page never scrolls.
 */
import { useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { brtDay, brtDayStartMs, brtParts, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { agendaOf, clock, dayBlocks, DAY_MS, pct, piecesOnDay } from '../../lib/calendarModel'
import { TEXT, pick } from './calendarText'
import { EXPECTED_COLOR, PUBLISHED_COLOR, VersionGlyph, stageColor, stageName } from './calendarUi'

const HOUR_H = 38
const COL_MIN = 168
const GUTTER = 48

export function DayView({ day, nowMs, versions, pieces, marks, pt, onOpenPiece, onOpenVersion, onOpenMark, selected }: {
  day: string; nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean
  onOpenPiece: (key: string, e: React.MouseEvent) => void
  onOpenVersion: (version: string, e: React.MouseEvent) => void
  onOpenMark: (m: CalMark, e: React.MouseEvent) => void
  selected: string | null
}) {
  const d0 = brtDayStartMs(day), isToday = brtDay(nowMs) === day
  const cols = piecesOnDay(pieces, day, nowMs)
  const allDay = agendaOf(day, { versions, pieces, marks })
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const h = isToday ? brtParts(nowMs).hour : 8
    el.scrollTop = Math.max(0, (h - 2) * HOUR_H)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])
  const nowTop = isToday ? pct(nowMs, d0, d0 + DAY_MS) : null

  return (
    <div data-cal-day-view data-cal-day={day} data-cal-count={cols.length} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0, minHeight: 36, flexWrap: 'wrap' }}>
        <span style={{ width: GUTTER - 10, fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.1 }}>{pick(TEXT.allDay, pt)}</span>
        {allDay.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>}
        {allDay.map((e, i) => {
          if (e.kind === 'version') {
            const published = e.state === 'published', c = published ? PUBLISHED_COLOR : EXPECTED_COLOR
            return (
              <button key={i} type="button" data-cal-allday="version" onClick={ev => onOpenVersion(e.version.version, ev)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, cursor: 'pointer', font: 'inherit', fontSize: 11, color: c,
                  background: published ? 'var(--accent-green-dim)' : 'color-mix(in srgb, var(--accent-blue) 7%, transparent)', border: published ? '1px solid transparent' : `1px dashed ${c}` }}>
                <VersionGlyph published={published} size={10} />{e.version.version} {published ? pick(TEXT.published, pt) : pick(TEXT.expected, pt)} {e.atMs !== null ? (published ? clock(e.atMs) : `~${clock(e.atMs)}`) : ''}
              </button>
            )
          }
          if (e.kind === 'resets') {
            return (
              <button key={i} type="button" data-cal-allday="resets" onClick={ev => onOpenMark(marks.find(m => m.kind === 'account-reset' && brtDay(m.atMs) === day)!, ev)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, border: '1px dashed color-mix(in srgb, var(--accent-cyan) 60%, transparent)', background: 'transparent', color: 'var(--accent-cyan)', cursor: 'pointer', font: 'inherit', fontSize: 11 }}>
                <RefreshCw size={11} aria-hidden />{e.items.length} {pt ? (e.items.length === 1 ? 'janela renova' : 'janelas renovam') : (e.items.length === 1 ? 'window renews' : 'windows renew')}
              </button>
            )
          }
          if (e.kind === 'due') {
            return <button key={i} type="button" data-cal-allday="due" onClick={ev => onOpenMark(e.mark, ev)} style={{ height: 22, padding: '0 8px', borderRadius: 4, border: 0, cursor: 'pointer', font: 'inherit', fontSize: 11, color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 10%, transparent)' }}>{pick(TEXT.due, pt)} · {e.mark.label}</button>
          }
          return null
        })}
      </div>

      {cols.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>{pick(TEXT.emptyTitle, pt)}</div>
      ) : (
        <div ref={scroller} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
          <div style={{ display: 'flex', minWidth: GUTTER + cols.length * COL_MIN, position: 'relative' }}>
            <div style={{ width: GUTTER, flexShrink: 0, position: 'sticky', left: 0, zIndex: 3, background: 'var(--bg-card)' }}>
              <div style={{ height: 40, position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 4 }} />
              <div style={{ position: 'relative', height: 24 * HOUR_H }}>
                {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ position: 'absolute', top: h * HOUR_H - 6, right: 8, fontSize: 10.5, color: 'var(--text-tertiary)' }}>{h ? `${String(h).padStart(2, '0')}h` : ''}</span>)}
              </div>
            </div>
            {cols.map(p => (
              <div key={p.key} data-cal-day-card={p.key} style={{ flex: `1 0 ${COL_MIN}px`, minWidth: 0, borderLeft: '1px solid var(--border)' }}>
                <div style={{ height: 40, position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', padding: '5px 8px', overflow: 'hidden' }}>
                  <div title={p.title} style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{[p.version, p.harness].filter(Boolean).join(' · ')}</div>
                </div>
                <div style={{ position: 'relative', height: 24 * HOUR_H }}>
                  {Array.from({ length: 24 }, (_, h) => <i key={h} aria-hidden style={{ position: 'absolute', left: 0, right: 0, top: h * HOUR_H, borderTop: '1px solid var(--border-subtle)' }} />)}
                  {dayBlocks(p, day, nowMs).map((b, i) => {
                    const top = (pct(b.fromMs, d0, d0 + DAY_MS) / 100) * 24 * HOUR_H
                    const h = Math.max(20, ((b.toMs - b.fromMs) / DAY_MS) * 24 * HOUR_H)
                    const c = stageColor(b.stage)
                    return (
                      <button key={i} type="button" data-cal-block={b.expected ? 'expected' : 'now'} onClick={e => onOpenPiece(p.key, e)}
                        style={{
                          position: 'absolute', left: 4, right: 4, top, height: h, textAlign: 'left', padding: '3px 6px', overflow: 'hidden', cursor: 'pointer', font: 'inherit', fontSize: 11, lineHeight: 1.25, color: 'var(--text-primary)',
                          borderRadius: 5, borderWidth: b.expected ? '1px 1px 1px 3px' : '0 0 0 3px', borderStyle: b.expected ? 'dashed' : 'solid', borderColor: c,
                          background: `color-mix(in srgb, ${c} ${b.expected ? 9 : 22}%, var(--bg-card))`,
                          outline: selected === p.key ? '1.5px solid var(--anthropic-orange)' : undefined,
                        }}>
                        <b style={{ display: 'block', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.expected ? (pt ? 'previsto' : 'expected') : stageName(b.stage, pt)}</b>
                        <small style={{ color: 'var(--text-secondary)', fontSize: 10 }}>{clock(b.fromMs)} – {clock(b.toMs)}</small>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            {nowTop !== null && (
              <div data-cal-now aria-hidden style={{ position: 'absolute', left: 0, right: 0, top: 40 + (nowTop / 100) * 24 * HOUR_H, borderTop: '1.5px solid var(--accent-red)', zIndex: 2, pointerEvents: 'none' }}>
                <span style={{ position: 'absolute', left: 2, top: -9, background: 'var(--accent-red)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 9 }}>{clock(nowMs)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
