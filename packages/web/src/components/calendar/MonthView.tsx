/**
 * MonthView — the macro level: a month grid where a release is a RIBBON. A published version is one day; a planned one
 * runs from where its work began to the day it is expected (dashed, so "expected" is never mistaken for "happened"); a
 * version with no estimate is a single dashed marker on today that says so. Task due days are chips; renewing accounts
 * are a small icon on their day. Six rows share the height, so the page never scrolls; the day number opens that day.
 * When a week row has fewer chip rows than chips, the day-number row says "+N" for that day (`fitWeek` counts them) and
 * pressing it opens the day — nothing leaves the grid unsaid.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { RefreshCw, Flag } from 'lucide-react'
import { brtDay, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { dowShort, expectedPiecesOfDay, fitWeek, marksOfDay, monthCells, overduePiecesOfDay, startedPiecesOfDay, weekRibbons, type Ribbon } from '../../lib/calendarModel'
import { TEXT, pick } from './calendarText'
import { EXPECTED_COLOR, PUBLISHED_COLOR, VersionGlyph, stageColor } from './calendarUi'

const RIBBON_H = 18
const NUM_H = 22

/** How many chip rows fit under the day numbers in a week row `h` px tall (the "+N" sits on the number row, so it costs none). */
export function rowsThatFit(h: number): number {
  return Math.max(0, Math.floor((h - NUM_H - 2 + 2) / (RIBBON_H + 2)))
}

type Common = {
  nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean
  onPickDay: (day: string) => void
  onOpenVersion: (version: string, e: React.MouseEvent) => void
  onOpenMark: (m: CalMark, e: React.MouseEvent) => void
  /** Opens a piece placed by its start alone (no version, no estimate). */
  onOpenPiece?: (key: string, e: React.MouseEvent) => void
  selected: string | null
}

export function MonthView({ anchor, ...rest }: Common & { anchor: string }) {
  const today = brtDay(rest.nowMs)
  const cells = monthCells(anchor)
  const weeks = Array.from({ length: 6 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
  return (
    <div data-cal-month style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--bg-card)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} style={{ padding: '6px 10px', fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{dowShort(i, rest.pt)}</div>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'repeat(6, minmax(0, 1fr))' }}>
        {weeks.map((week, wi) => <WeekRow key={week[0]!.day} week={week} last={wi === 5} today={today} {...rest} />)}
      </div>
    </div>
  )
}

function WeekRow({ week, last, today, nowMs, versions, pieces, marks, pt, selected, onPickDay, onOpenVersion, onOpenMark, onOpenPiece }: Common & {
  week: { day: string; inMonth: boolean }[]; last: boolean; today: string
}) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [cap, setCap] = useState(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    // A row that cannot be measured (no layout yet) hides nothing: "unknown height" is not "no room".
    const measure = () => { const h = el.getBoundingClientRect().height; setCap(h > 0 ? rowsThatFit(h) : Number.POSITIVE_INFINITY) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const days = week.map(c => c.day)
  const allRibbons = weekRibbons(days, versions, pieces, today)
  const lanes = allRibbons.reduce((m, r) => Math.max(m, r.lane + 1), 0)
  const PRIO: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
  const dueMarks = week.map(c => marksOfDay(c.day, marks).filter((m): m is Extract<CalMark, { kind: 'task-due' }> => m.kind === 'task-due')
    .sort((a, b) => (PRIO[a.priority ?? ''] ?? 4) - (PRIO[b.priority ?? ''] ?? 4)))
  // Pieces with no version and no estimate (a leader working alone) sit on the day their work began.
  const started = week.map(c => startedPiecesOfDay(c.day, pieces))
  const expected = week.map(c => expectedPiecesOfDay(c.day, pieces))
  const overdue = week.map(c => overduePiecesOfDay(c.day, pieces, nowMs))
  // Rows are a PER-DAY budget. Only the version ribbons are per week (they span days, so they sit on the same top rows in
  // every column): they may take about half of `cap`, never all of it. Each day then spends its own rows in this order:
  // the overdue chip (a guaranteed row), deadlines (urgent first), started pieces, predicted pieces. A day with nothing
  // started therefore shows its deadline and its predictions, whatever another day of the week is carrying.
  const anyOverdue = cap >= 1 && overdue.some(s => s.length > 0)
  const laneRoom = Number.isFinite(cap) ? Math.max(0, cap - (anyOverdue ? 1 : 0)) : cap
  const laneCap = Number.isFinite(laneRoom) ? (laneRoom > 0 ? Math.max(1, Math.floor(laneRoom / 2)) : 0) : laneRoom
  const baseFit = fitWeek({ ribbons: allRibbons, dues: week.map(() => 0), cap: laneCap })
  const shownLanes = Math.min(lanes, laneCap)
  const plan = week.map((_, i) => {
    let room = Number.isFinite(cap) ? Math.max(0, cap - shownLanes) : Number.POSITIVE_INFINITY
    const od = overdue[i]!.length > 0 && cap >= 1
    if (od) room -= 1
    const take = <T,>(s: T[]): T[] => { const r = s.slice(0, Math.max(0, room)); room -= r.length; return r }
    const dues = take(dueMarks[i]!)
    const st = take(started[i]!)
    const ex = take(expected[i]!)
    return { dues, st, ex, od }
  })
  const shownDues = plan.map(p => p.dues)
  const shownStarted = plan.map(p => p.st)
  const shownExpected = plan.map(p => p.ex)
  const shownOverdue = plan.map((p, i) => (p.od ? overdue[i]! : []))
  const hiddenDues = week.map((_, i) => dueMarks[i]!.length - shownDues[i]!.length)
  const fit = { ...baseFit, more: baseFit.more.map((n, i) => n + hiddenDues[i]! + started[i]!.length - shownStarted[i]!.length + expected[i]!.length - shownExpected[i]!.length + (overdue[i]!.length - shownOverdue[i]!.length)) }
  return (
    <div ref={rowRef} data-cal-week style={{ position: 'relative', minHeight: 0, overflow: 'hidden', borderBottom: !last ? '1px solid var(--border)' : 0 }}>
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
        {fit.ribbons.map(r => <RibbonBar key={r.version} r={r} pt={pt} selected={selected === r.version} onOpen={e => onOpenVersion(r.version, e)} />)}
        {week.map((c, i) => shownDues[i]!.map((m, k) => (
          <button key={`${c.day}-${m.taskId}`} type="button" data-cal-due={m.taskId} onClick={e => onOpenMark(m, e)} title={m.label}
            style={{
              gridColumn: i + 1, gridRow: 2 + shownLanes + k, margin: '0 4px', height: RIBBON_H, display: 'flex', alignItems: 'center', gap: 4, padding: '0 5px', minWidth: 0,
              border: 0, borderRadius: 4, cursor: 'pointer', font: 'inherit', fontSize: 10.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden',
              color: brtDay(nowMs) > c.day ? 'var(--accent-red)' : 'var(--accent-amber)',
              background: brtDay(nowMs) > c.day ? 'var(--accent-red-dim)' : 'color-mix(in srgb, var(--accent-amber) 10%, transparent)',
            }}>
            <Flag size={10} aria-hidden style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{pick(TEXT.due, pt)} · {m.label}</span>
          </button>
        )))}
        {week.map((c, i) => shownStarted[i]!.map((p, k) => (
          <button key={`${c.day}-${p.key}`} type="button" data-cal-started={p.key} onClick={e => onOpenPiece?.(p.key, e)} title={`${p.title} · ${pick(TEXT.noEstimate, pt)}`}
            style={{
              gridColumn: i + 1, gridRow: 2 + shownLanes + shownDues[i]!.length + k, margin: '0 4px', height: RIBBON_H, display: 'flex', alignItems: 'center', gap: 4, padding: '0 5px', minWidth: 0,
              border: `1px dashed ${stageColor(p.stage)}`, borderRadius: 4, cursor: 'pointer', font: 'inherit', fontSize: 10.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden',
              color: 'var(--text-primary)', background: 'transparent',
            }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: stageColor(p.stage) }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</span>
          </button>
        )))}
        {week.map((c, i) => shownExpected[i]!.map((p, k) => (
          <button key={`${c.day}-expected-${p.key}`} type="button" data-cal-expected-piece={p.key} onClick={e => onOpenPiece?.(p.key, e)} title={`${p.title} · ${pick(TEXT.expected, pt)}`}
            style={{ gridColumn: i + 1, gridRow: 2 + shownLanes + shownDues[i]!.length + shownStarted[i]!.length + k, margin: '0 4px', height: RIBBON_H, display: 'flex', alignItems: 'center', gap: 4, padding: '0 5px', minWidth: 0, border: `1px dashed ${stageColor(p.stage)}`, borderRadius: 4, cursor: 'pointer', font: 'inherit', fontSize: 10.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', color: 'var(--text-primary)', background: 'transparent' }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: stageColor(p.stage) }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</span>
          </button>
        )))}
        {week.map((c, i) => shownOverdue[i]!.length > 0 && (
          <button key={`${c.day}-overdue`} type="button" data-cal-overdue={c.day} onClick={() => onPickDay(c.day)} title={pick(TEXT.overdue, pt)}
            style={{ gridColumn: i + 1, gridRow: 2 + shownLanes + shownDues[i]!.length + shownStarted[i]!.length + shownExpected[i]!.length, margin: '0 4px', height: RIBBON_H, display: 'flex', alignItems: 'center', padding: '0 5px', minWidth: 0, border: 0, borderRadius: 4, cursor: 'pointer', font: 'inherit', fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
            {overdue[i]!.length} {pick(TEXT.overdue, pt)}
          </button>
        ))}
        {week.map((c, i) => fit.more[i]! > 0 && (
          <button key={`more-${c.day}`} type="button" data-cal-more={c.day} onClick={() => onPickDay(c.day)}
            // "+N" counts what this cell had no row for: predicted and started pieces, version ribbons and due dates. The title names each kind.
            title={pick(TEXT.moreHidden({
              total: fit.more[i]!, expected: expected[i]!.length - shownExpected[i]!.length, started: started[i]!.length - shownStarted[i]!.length,
              overdue: overdue[i]!.length - shownOverdue[i]!.length, other: baseFit.more[i]! + hiddenDues[i]!,
            }), pt)}
            style={{
              gridColumn: i + 1, gridRow: 1, justifySelf: 'end', alignSelf: 'center', marginRight: marksOfDay(c.day, marks).some(m => m.kind === 'account-reset') ? 26 : 5,
              height: 17, display: 'inline-flex', alignItems: 'center', padding: '0 5px', minWidth: 0, zIndex: 1,
              border: 0, borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
              color: 'var(--text-primary)', background: 'var(--bg-hover)',
            }}>
            +{fit.more[i]}
          </button>
        ))}
      </div>
    </div>
  )
}

function RibbonBar({ r, pt, selected, onOpen }: { r: Ribbon; pt: boolean; selected: boolean; onOpen: (e: React.MouseEvent) => void }) {
  const published = r.state === 'published'
  const color = published ? PUBLISHED_COLOR : EXPECTED_COLOR
  return (
    <button type="button" data-cal-ribbon={r.version} data-cal-state={r.state} onClick={onOpen}
      title={`${r.version} · ${r.note === 'published' ? pick(TEXT.published, pt) : r.note === 'none' ? pick(TEXT.noEstimate, pt) : pick(TEXT.expected, pt)}`}
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
