/**
 * VersionCards — the next releases as cards across the top of the calendar: the latest one published, then every
 * planned one with its expected day (or the plain words "no estimate"), its confidence and a bar of where its pieces
 * stand. A card is a view of core's `CalVersion`; it asserts nothing the version does not carry.
 */
import { brtDay, type CalVersion } from '@agentistics/core'
import { clock, dowShort, relativeDay, stageSegments, weekdayMon0 } from '../../lib/calendarModel'
import { TEXT, pick } from './calendarText'
import { Confidence, EXPECTED_COLOR, PUBLISHED_COLOR, VersionGlyph, stageColor } from './calendarUi'

/** PURE: the cards worth a place on the strip — every planned version and only the most recent published one. */
export function stripVersions(versions: readonly CalVersion[]): CalVersion[] {
  const planned = versions.filter(v => v.state === 'planned')
  const published = versions.filter(v => v.state === 'published' && v.atMs !== null).sort((a, b) => b.atMs! - a.atMs!).slice(0, 1)
  return [...published, ...planned]
}

/** PURE: the card's second line — when it shipped, or when it is expected, in words. */
export function versionWhen(v: CalVersion, todayDay: string, pt: boolean): string {
  if (v.atMs === null) return pick(TEXT.noEstimate, pt)
  const day = brtDay(v.atMs), rel = relativeDay(day, todayDay, pt)
  const near = Math.abs(Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${todayDay}T00:00:00Z`)) / 86_400_000)) <= 1
  const when = near ? rel : `${dowShort(weekdayMon0(day), pt).toLowerCase()} ${day.slice(8, 10)}`
  if (v.state === 'published') return `${pick(TEXT.published, pt)} · ${when} ${clock(v.atMs)}`
  return v.basis === 'partial' ? `${when} · ${pick(TEXT.expected, pt)}` : `${when} · ~${clock(v.atMs)}`
}

export function VersionCards({ versions, nowMs, pt, onOpen, selected }: {
  versions: readonly CalVersion[]; nowMs: number; pt: boolean; onOpen: (v: CalVersion, e: React.MouseEvent) => void; selected: string | null
}) {
  const today = brtDay(nowMs)
  const cards = stripVersions(versions)
  if (cards.length === 0) return null
  return (
    <div data-cal-versions style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '2px 0 10px', flexShrink: 0 }}>
      {cards.map(v => {
        const published = v.state === 'published'
        const accent = published ? PUBLISHED_COLOR : EXPECTED_COLOR
        return (
          <button
            key={v.version} type="button" data-cal-version={v.version} onClick={e => onOpen(v, e)}
            style={{
              flex: '0 0 auto', minWidth: 150, textAlign: 'left', cursor: 'pointer', padding: '8px 12px 9px', display: 'flex', flexDirection: 'column', gap: 3,
              background: 'var(--bg-card)', color: 'var(--text-primary)', borderRadius: 'var(--radius-md)', font: 'inherit',
              border: `1px solid ${selected === v.version ? 'var(--anthropic-orange)' : published ? 'color-mix(in srgb, var(--accent-green) 45%, var(--border))' : 'var(--border)'}`,
              ...(published ? {} : {}),
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 }}>
              <span style={{ color: accent, display: 'inline-flex' }}><VersionGlyph published={published} /></span>
              {v.version}
              <span style={{ marginLeft: 'auto' }}><Confidence level={published ? null : v.confidence} pt={pt} /></span>
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{versionWhen(v, today, pt)}</span>
            <span aria-hidden style={{ display: 'flex', height: 3, borderRadius: 2, overflow: 'hidden', gap: 1, marginTop: 3 }}>
              {stageSegments(v).map(s => <i key={s.stage} style={{ display: 'block', height: '100%', width: `${s.pct}%`, background: stageColor(s.stage) }} />)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
