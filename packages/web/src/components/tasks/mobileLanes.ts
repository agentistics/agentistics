/**
 * PURE helpers for the phone's board: which status chip opens selected, and which view a phone
 * opens on when nobody has chosen one.
 */
import type { BoardView } from './boardPrefs'

export interface LaneChip { status: string; count: number }

const IN_PROGRESS_LIKE = new Set(['in_progress', 'in_review', 'doing', 'review'])

/** First non-empty in-progress-like lane, else the first non-empty lane, else the first lane. */
export function pickDefaultLane(lanes: readonly LaneChip[]): string | null {
  if (lanes.length === 0) return null
  const active = lanes.find(l => l.count > 0 && IN_PROGRESS_LIKE.has(l.status))
  if (active) return active.status
  return (lanes.find(l => l.count > 0) ?? lanes[0]!).status
}

/** The selection if it still names a visible lane, else the default. */
export function resolveLane(selected: string | null, lanes: readonly LaneChip[]): string | null {
  return selected !== null && lanes.some(l => l.status === selected) ? selected : pickDefaultLane(lanes)
}

/** A phone with no stored view opens on the kanban; a stored choice always wins. */
export function effectiveView(stored: BoardView, isMobile: boolean, hasStored: boolean): BoardView {
  return isMobile && !hasStored ? 'board' : stored
}

/** Did the person ever choose a view? Reads the browser copy of the board prefs; total. */
export function hasStoredView(key = 'agentistics-task-board-v1'): boolean {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    if (!raw) return false
    const v = (JSON.parse(raw) as { view?: unknown } | null)?.view
    return v === 'overview' || v === 'board' || v === 'table'
  } catch { return false }
}
