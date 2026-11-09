/**
 * ScheduleView — the cronograma: releases on top as bars from where their work began to the day they ship (solid until
 * now, dashed after), then the pieces by priority, each drawn from the stages it REALLY went through and — only when
 * the Live read model produced one — a dashed span to its estimate. A piece with no estimate ends at "now" and says
 * "no estimate"; nothing is extrapolated. A red line marks now; the accounts' renewals sit on their own row.
 */
import { RefreshCw } from 'lucide-react'
import { brtDay, brtDayStartMs, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { HarnessBadges } from '../tasks/HarnessBadges'
import { clock, DAY_MS, dowShort, pct, pieceSegments, stamp, versionDays, weekdayMon0, byPriority } from '../../lib/calendarModel'
import { TEXT, pick } from './calendarText'
import { Confidence, EXPECTED_COLOR, PUBLISHED_COLOR, PriorityFlag, VersionGlyph, VersionTag, stageColor } from './calendarUi'

const LABEL_W = 230
const ROW_H = 36

const span = (fromMs: number, toMs: number, w0: number, w1: number): { left: string; width: string } | null => {
  const a = Math.max(fromMs, w0), b = Math.min(toMs, w1)
  if (b <= a) return null
  return { left: `${pct(a, w0, w1)}%`, width: `${pct(b, w0, w1) - pct(a, w0, w1)}%` }
}

export function ScheduleView({ anchor, nowMs, versions, pieces, marks, pt, onOpenPiece, onOpenVersion, onOpenMark, selected, mobile = false }: {
  mobile?: boolean
  anchor: string; nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean
  onOpenPiece: (key: string, e: React.MouseEvent) => void
  onOpenVersion: (version: string, e: React.MouseEvent) => void
  onOpenMark: (m: CalMark, e: React.MouseEvent) => void
  selected: string | null
}) {
  const w0 = brtDayStartMs(anchor), w1 = w0 + 2 * DAY_MS
  const today = brtDay(nowMs)
  const nowPct = pct(nowMs, w0, w1)
  const nowVisible = nowPct >= 0 && nowPct <= 100
  const days = [anchor, brtDay(w0 + DAY_MS)]
  const ticks = Array.from({ length: 15 }, (_, i) => i * 3 * 3600_000).map(o => w0 + o).filter(ms => ms < w1)
  const sortedPieces = [...pieces].sort(byPriority)
  const resets = marks.filter((m): m is Extract<CalMark, { kind: 'account-reset' }> => m.kind === 'account-reset' && m.atMs >= w0 && m.atMs < w1).sort((a, b) => a.atMs - b.atMs)
  const vlist = versions.filter(v => { const d = versionDays(v, pieces, today); return d && brtDayStartMs(d.end) + DAY_MS > w0 && brtDayStartMs(d.start) < w1 })

  const track = (children: React.ReactNode, h = ROW_H) => (
    <div style={{ position: 'relative', flex: 1, height: h, minWidth: 0 }}>{children}</div>
  )
  const grid = (
    <div aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, left: LABEL_W, right: mobile ? 220 : 0, zIndex: 0, pointerEvents: 'none' }}>
      {ticks.map(ms => <i key={ms} style={{ position: 'absolute', top: 0, bottom: 0, left: `${pct(ms, w0, w1)}%`, borderLeft: `1px solid ${brtDay(ms) !== brtDay(ms - 1) && (ms - w0) % DAY_MS === 0 ? 'var(--border)' : 'var(--border-subtle)'}` }} />)}
    </div>
  )

  return (
    <div data-cal-schedule style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', position: 'relative' }}>
      <div data-cal-schedule-track style={{ position: 'relative', minWidth: mobile ? 980 : 760, paddingRight: mobile ? 220 : undefined, paddingBottom: mobile ? 64 : 34 }}>
        {grid}
        {/* header: the two days and the hours */}
        <div style={{ display: 'flex', height: 44, borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 4, background: 'var(--bg-card)' }}>
          <div style={{ width: LABEL_W, flexShrink: 0, display: 'flex', alignItems: 'flex-end', padding: '0 12px 6px', color: 'var(--text-tertiary)', fontSize: 11 }}>{pick(TEXT.piece, pt)}</div>
          <div style={{ position: 'relative', flex: 1 }}>
            {days.map((d, i) => (
              <div key={d} style={{ position: 'absolute', top: 0, left: `${i * 50}%`, width: '50%', height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 600, color: d === today ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)', borderLeft: i ? '1px solid var(--border)' : 0 }}>
                {dowShort(weekdayMon0(d), pt)} {d.slice(8)}
                {d === today && <b style={{ marginLeft: 6, background: 'var(--anthropic-orange)', color: '#111', borderRadius: 9, padding: '0 6px', height: 18, display: 'inline-flex', alignItems: 'center', fontSize: 10.5 }}>{pick(TEXT.today, pt).toLowerCase()}</b>}
              </div>
            ))}
            {ticks.map(ms => <span key={ms} style={{ position: 'absolute', top: 28, left: `${pct(ms, w0, w1)}%`, transform: 'translateX(-50%)', fontSize: 10, color: 'var(--text-tertiary)' }}>{String(Number(clock(ms).slice(0, 2))).padStart(2, '0')}h</span>)}
          </div>
        </div>

        {resets.length > 0 && (
          <div style={{ display: 'flex', position: 'relative', zIndex: 1, height: 30 }}>
            <div style={{ width: LABEL_W, flexShrink: 0, padding: '0 12px', display: 'flex', alignItems: 'center', fontSize: 11, color: 'var(--text-tertiary)' }}>{pick(TEXT.marks, pt)}</div>
            {track(
              <button type="button" data-cal-resets onClick={e => onOpenMark(resets[0]!, e)}
                style={{ position: 'absolute', top: 5, left: `${Math.min(pct(resets[0]!.atMs, w0, w1), 62)}%`, display: 'flex', alignItems: 'center', gap: 6, height: 20, padding: '0 8px', borderRadius: 10, border: '1px dashed color-mix(in srgb, var(--accent-cyan) 60%, transparent)', background: 'color-mix(in srgb, var(--accent-cyan) 8%, transparent)', color: 'var(--accent-cyan)', cursor: 'pointer', font: 'inherit', fontSize: 11, whiteSpace: 'nowrap' }}>
                <RefreshCw size={11} aria-hidden />
                {pt ? `${resets.length} ${resets.length === 1 ? 'conta renova' : 'contas renovam'}` : `${resets.length} ${resets.length === 1 ? 'account renews' : 'accounts renew'}`}: {resets.map(r => `${r.label} ${clock(r.atMs)}`).join(' · ')}
              </button>, 30)}
          </div>
        )}

        {vlist.map(v => {
          const published = v.state === 'published'
          const d = versionDays(v, pieces, today)!
          const start = Math.max(brtDayStartMs(d.start), w0 - 1)
          const end = v.atMs ?? nowMs
          const color = published ? PUBLISHED_COLOR : EXPECTED_COLOR
          const solid = span(start, Math.min(end, published ? end : nowMs), w0, w1)
          const dashed = !published && v.atMs !== null && v.atMs > nowMs ? span(Math.max(nowMs, w0), v.atMs, w0, w1) : null
          const endPct = pct(end, w0, w1)
          return (
            <div key={v.version} style={{ display: 'flex', position: 'relative', zIndex: 1, height: 32 }}>
              <div style={{ width: LABEL_W, flexShrink: 0, padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, fontSize: 12, fontWeight: 600 }}>
                {v.version}<span style={{ fontWeight: 400, fontSize: 10.5, color: 'var(--text-tertiary)' }}>{published ? pick(TEXT.published, pt) : pick(TEXT.expected, pt)}</span>
              </div>
              {track(
                <button type="button" data-cal-bar-version={v.version} onClick={e => onOpenVersion(v.version, e)}
                  style={{ position: 'absolute', inset: 0, background: 'none', border: 0, cursor: 'pointer', padding: 0, outline: selected === v.version ? '1.5px solid var(--anthropic-orange)' : undefined }}>
                  {solid && <i style={{ position: 'absolute', top: 14, height: 4, borderRadius: 2, background: color, ...solid }} />}
                  {dashed && <i style={{ position: 'absolute', top: 14, height: 4, borderRadius: 2, border: `1px dashed ${color}`, boxSizing: 'border-box', ...dashed }} />}
                  {endPct >= 0 && endPct <= 100 && v.atMs !== null && (
                    <>
                      <span style={{ position: 'absolute', top: 16, left: `${endPct}%`, transform: 'translate(-50%, -50%)', color, display: 'inline-flex' }}><VersionGlyph published={published} size={13} /></span>
                      <span style={{ position: 'absolute', top: 16, left: `calc(${endPct}% + 12px)`, transform: 'translateY(-50%)', fontSize: 10.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        <b style={{ color: 'var(--text-primary)' }}>{v.version}</b> · {stamp(v.atMs, pt)}{published ? '' : ` (${pt ? 'prev.' : 'exp.'})`}
                      </span>
                    </>
                  )}
                  {v.atMs === null && <span style={{ position: 'absolute', top: 16, left: `calc(${Math.max(0, nowPct)}% + 6px)`, transform: 'translateY(-50%)', fontSize: 10.5, color: 'var(--text-tertiary)' }}>{pick(TEXT.noEstimate, pt)}</span>}
                </button>, 32)}
            </div>
          )
        })}

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 12px 4px', background: 'var(--border-subtle)', borderTop: '1px solid var(--border)', position: 'relative', zIndex: 1 }}>
          <b style={{ fontSize: 12 }}>{pick(TEXT.piecesByPriority, pt)}</b>
          <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{pick(TEXT.urgentToLow, pt)}</span>
        </div>

        {sortedPieces.map(p => {
          const segs = pieceSegments(p, nowMs)
          const last = segs[segs.length - 1]
          const endMs = p.publishEta.kind === 'estimate' ? p.publishEta.atMs : p.publishedAtMs ?? nowMs
          const endPct = pct(endMs, w0, w1)
          return (
            <div key={p.key} data-cal-piece-row={p.key} style={{ display: 'flex', position: 'relative', zIndex: 1, height: ROW_H + 4, borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ width: LABEL_W, flexShrink: 0, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, minWidth: 0 }}>
                <span title={p.title} style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  {p.harness && <HarnessBadges harnesses={[p.harness]} max={1} fontSize={10} />}
                  {p.model && <span>{p.model}</span>}
                  <PriorityFlag priority={p.priority} pt={pt} />
                  {p.version && <VersionTag version={p.version} />}
                </span>
              </div>
              {track(
                <button type="button" data-cal-bar-piece={p.key} onClick={e => onOpenPiece(p.key, e)}
                  style={{ position: 'absolute', inset: 0, background: 'none', border: 0, cursor: 'pointer', padding: 0, outline: selected === p.key ? '1.5px solid var(--anthropic-orange)' : undefined }}>
                  {segs.map((s, i) => {
                    const g = span(s.fromMs, s.toMs, w0, w1)
                    if (!g) return null
                    const expected = s.stage === 'expected'
                    const c = s.stage === 'expected' ? (last && segs.length > 1 ? stageColor(p.stage) : 'var(--text-tertiary)') : stageColor(s.stage)
                    return <i key={i} data-cal-seg={s.stage} style={{ position: 'absolute', top: 13, height: 10, borderRadius: 3, boxSizing: 'border-box', ...g,
                      ...(expected ? { border: `1px dashed ${c}`, background: `repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, ${c} 25%, transparent) 4px 6px)` } : { background: c }) }} />
                  })}
                  {segs.length === 0 && p.startedAtMs === null && <span style={{ position: 'absolute', top: 18, left: 8, fontSize: 10.5, color: 'var(--text-tertiary)' }}>{pick(TEXT.noTime, pt)}</span>}
                  {(p.publishEta.kind === 'estimate' || p.publishedAtMs !== null) && endPct >= 0 && endPct <= 100 && (
                    <span style={{ position: 'absolute', top: 18, left: `calc(${endPct}% + 8px)`, transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {clock(endMs)}{p.publishEta.kind === 'estimate' && <Confidence level={p.publishEta.confidence} pt={pt} />}
                    </span>
                  )}
                  {p.publishEta.kind === 'none' && p.publishedAtMs === null && nowVisible && (
                    <span style={{ position: 'absolute', top: 18, left: `calc(${nowPct}% + 8px)`, transform: 'translateY(-50%)', fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{pick(TEXT.noEstimate, pt)}</span>
                  )}
                </button>, ROW_H + 4)}
            </div>
          )
        })}

        {nowVisible && (
          <div data-cal-now aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, left: LABEL_W, right: mobile ? 220 : 0, pointerEvents: 'none', zIndex: 5 }}>
            <i style={{ position: 'absolute', top: 0, bottom: 0, left: `${nowPct}%`, borderLeft: '1.5px solid var(--accent-red)' }} />
            <span style={{ position: 'absolute', bottom: 6, left: `${nowPct}%`, transform: 'translateX(-50%)', background: 'var(--accent-red)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 9, whiteSpace: 'nowrap' }}>{pick(TEXT.now, pt)} {clock(nowMs)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
