/**
 * calendarUi.tsx — the small shared pieces of the Delivery calendar: a stage chip, the confidence glyph, a version tag,
 * the priority flag. Colours come from the Live line's own stage table (`STAGE_LABEL`), so a stage is the same colour
 * here as on its card; nothing is re-declared.
 */
import { Diamond, Flag } from 'lucide-react'
import type { CalConfidence, CalPiece, CalPriority, CalStage } from '@agentistics/core'
import { STAGE_LABEL } from '../tasks/liveDeliveryModel'
import { CONFIDENCE_LABEL, PRIORITY_LABEL, pick } from './calendarText'

export const stageColor = (s: CalStage): string => STAGE_LABEL[s].color
export const stageName = (s: CalStage, pt: boolean): string => (pt ? STAGE_LABEL[s].pt : STAGE_LABEL[s].en)

export const PRIORITY_COLOR: Record<CalPriority, string> = {
  urgent: 'var(--accent-red)', high: 'var(--accent-amber)', medium: 'var(--accent-blue)', low: 'var(--text-tertiary)',
}

export function StageChip({ stage, pt }: { stage: CalStage; pt: boolean }) {
  const c = stageColor(stage)
  return (
    <span data-cal-stage={stage} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 18, padding: '0 7px', borderRadius: 9,
      fontSize: 10.5, fontWeight: 600, color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, whiteSpace: 'nowrap',
    }}>
      <i aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: c, display: 'inline-block' }} />
      {stageName(stage, pt)}
    </span>
  )
}

/** Three little bars: how sure the estimate is. Never colour alone — the title says the words. */
export function Confidence({ level, pt }: { level: CalConfidence | null; pt: boolean }) {
  if (!level) return null
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : 1
  const color = level === 'high' ? 'var(--accent-green)' : level === 'medium' ? 'var(--accent-amber)' : 'var(--accent-red)'
  return (
    <span role="img" aria-label={pick(CONFIDENCE_LABEL[level], pt)} title={pick(CONFIDENCE_LABEL[level], pt)}
      style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end', height: 11, verticalAlign: -1 }}>
      {[5, 8, 11].map((h, i) => <i key={h} style={{ width: 3, height: h, borderRadius: 1, background: i < filled ? color : 'var(--text-tertiary)', opacity: i < filled ? 1 : 0.45 }} />)}
    </span>
  )
}

export function PriorityFlag({ priority, pt }: { priority: CalPriority | null; pt: boolean }) {
  if (!priority) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: PRIORITY_COLOR[priority], fontSize: 10.5 }}>
      <Flag size={10} aria-hidden />{pick(PRIORITY_LABEL[priority], pt)}
    </span>
  )
}

/** ◆ published / ◇ expected — the glyph the whole calendar uses for a version. */
export function VersionGlyph({ published, size = 11 }: { published: boolean; size?: number }) {
  return <Diamond size={size} aria-hidden fill={published ? 'currentColor' : 'none'} style={{ flexShrink: 0 }} />
}

export function VersionTag({ version }: { version: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', height: 17, padding: '0 6px', borderRadius: 4, fontSize: 10.5, fontWeight: 600,
      color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', whiteSpace: 'nowrap',
    }}>{version}</span>
  )
}

export const PUBLISHED_COLOR = 'var(--accent-green)'
export const EXPECTED_COLOR = 'var(--accent-blue)'

/** The one-line "what is this piece's estimate" sentence, or the honest absence of one. */
export function pieceEtaLabel(p: CalPiece, clockOf: (ms: number) => string, pt: boolean): string {
  if (p.publishedAtMs !== null) return pt ? 'publicada' : 'published'
  if (p.publishEta.kind === 'estimate') return `~${clockOf(p.publishEta.atMs)}`
  return pt ? 'sem estimativa' : 'no estimate'
}
