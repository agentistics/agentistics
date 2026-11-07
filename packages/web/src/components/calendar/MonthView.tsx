/**
 * MonthView — the macro level: a month grid where a release is a RIBBON. A published version is one day; a planned one
 * runs from where its work began to the day it is expected (dashed, so "expected" is never mistaken for "happened"); a
 * version with no estimate is a single dashed marker on today that says so. Task due days are chips; renewing accounts
 * are a small icon on their day. Six rows share the height, so the page never scrolls; the day number opens that day.
 */
import { RefreshCw, Flag } from 'lucide-react'
import { brtDay, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { dowShort, marksOfDay, monthCells, weekRibbons, type Ribbon } from '../../lib/calendarModel'
import { TEXT, pick } from './calendarText'
import { EXPECTED_COLOR, PUBLISHED_COLOR, VersionGlyph } from './calendarUi'

const RIBBON_H = 18
const NUM_H = 22

export function MonthView({ anchor, nowMs, versions, pieces, marks, pt, onPickDay, onOpenVersion, onOpenMark, selected }: {
  anchor: string; nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean
  onPickDay: (day: string) => void
  onOpenVersion: (version: string, e: React.MouseEvent) => void
  onOpenMark: (m: CalMark, e: React.MouseEvent) => void
  selected: string | null
}) {
  const today = brtDay(nowMs)
  const cells = monthCells(anchor)
  const weeks = Array.from({ length: 6 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
  return (
    <div data-cal-month style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--bg-card)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} style={{ padding: '6px 10px', fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{dowShort(i, pt)}</div>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'repeat(6, minmax(0, 1fr))' }}>
        {weeks.map((week, wi) => {
          const days = week.map(c => c.day)
          const ribbons = weekRibbons(days, versions, pieces, today)
          const lanes = ribbons.reduce((m, r) => Math.max(m, r.lane + 1), 0)
          return (
            <div key={days[0]} data-cal-week style={{ position: 'relative', minHeight: 0, overflow: 'hidden', borderBottom: wi < 5 ? '1px solid var(--border)' : 0 }}>
              <div aria-hidden style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                {week.map((c, i) => (
                  <div key={c.day} style={{
                    borderRight: i < 6 ? '1px solid var(--border)' : 0,
                    background: c.day === today ? 'linear-gradient(180deg, var(--anthropic-orange-dim), transparent 70%)' : !c.inMonth ? 'var(--border-subtle)' : undefined,
                  }} />
                ))}
              </div>
              <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: `${RIBBON_H}px`, rowGap: 2, padding: '0 0 2px', minWidth: 0 }}>
                {week.map((c, i) => {
                  const resets = marksOfDay(c.day, marks).filter(m => m.kind === 'account-reset')
                  return (
                    <button key={c.day} type="button" data-cal-day={c.day} onClick={() => onPickDay(c.day)}
                      aria-label={c.day} style={{
                        gridColumn: i + 1, gridRow: 1, height: NUM_H, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 7px',
                        background: 'none', border: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 500,
                        color: c.inMonth ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                      }}>
                      {c.day === today
                        ? <b style={{ width: 20, height: 20, borderRadius: 10, background: 'var(--anthropic-orange)', color: '#111', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{Number(c.day.slice(8))}</b>
                        : <span>{Number(c.day.slice(8))}</span>}
                      {resets.length > 0 && (
                        <span title={`${pick(TEXT.accountsRenew, pt)}: ${resets.map(m => m.kind === 'account-reset' ? m.label : '').join(', ')}`} style={{ color: 'var(--accent-cyan)', display: 'inline-flex' }}>
                          <RefreshCw size={11} aria-hidden />
                        </span>
                      )}
                    </button>
                  )
                })}
                {ribbons.map(r => <RibbonBar key={r.version} r={r} pt={pt} selected={selected === r.version} onOpen={e => onOpenVersion(r.version, e)} />)}
                {week.map((c, i) => {
                  const dues = marksOfDay(c.day, marks).filter((m): m is Extract<CalMark, { kind: 'task-due' }> => m.kind === 'task-due')
                  return dues.slice(0, 2).map((m, k) => (
                    <button key={`${c.day}-${m.taskId}`} type="button" data-cal-due={m.taskId} onClick={e => onOpenMark(m, e)} title={m.label}
                      style={{
                        gridColumn: i + 1, gridRow: 2 + lanes + k, margin: '0 4px', height: RIBBON_H, display: 'flex', alignItems: 'center', gap: 4, padding: '0 5px', minWidth: 0,
                        border: 0, borderRadius: 4, cursor: 'pointer', font: 'inherit', fontSize: 10.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden',
                        color: brtDay(nowMs) > c.day ? 'var(--accent-red)' : 'var(--accent-amber)',
                        background: brtDay(nowMs) > c.day ? 'var(--accent-red-dim)' : 'color-mix(in srgb, var(--accent-amber) 10%, transparent)',
                      }}>
                      <Flag size={10} aria-hidden style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{pick(TEXT.due, pt)} · {m.label}</span>
                    </button>
                  ))
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RibbonBar({ r, pt, selected, onOpen }: { r: Ribbon; pt: boolean; selected: boolean; onOpen: (e: React.MouseEvent) => void }) {
  const published = r.state === 'published'
  const color = published ? PUBLISHED_COLOR : EXPECTED_COLOR
  return (
    <button type="button" data-cal-ribbon={r.version} data-cal-state={r.state} onClick={onOpen}
      style={{
        gridColumn: `${r.startCol + 1} / ${r.endCol + 2}`, gridRow: 2 + r.lane, margin: `0 ${r.contRight ? 0 : 4}px 0 ${r.contLeft ? 0 : 4}px`, height: RIBBON_H,
        display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', minWidth: 0, cursor: 'pointer', font: 'inherit', fontSize: 10.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden',
        borderRadius: `${r.contLeft ? 0 : 4}px ${r.contRight ? 0 : 4}px ${r.contRight ? 0 : 4}px ${r.contLeft ? 0 : 4}px`,
        color, background: published ? 'var(--accent-green-dim)' : 'color-mix(in srgb, var(--accent-blue) 7%, transparent)',
        border: published ? '1px solid transparent' : `1px dashed color-mix(in srgb, ${color} 70%, transparent)`,
        boxShadow: selected ? 'inset 0 0 0 1.5px var(--anthropic-orange)' : undefined,
      }}>
      <VersionGlyph published={published} size={10} />
      <span>{r.version}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontWeight: 400 }}>
        {r.note === 'published' ? pick(TEXT.published, pt) : r.note === 'none' ? pick(TEXT.noEstimate, pt) : pick(TEXT.expected, pt)}
      </span>
    </button>
  )
}
