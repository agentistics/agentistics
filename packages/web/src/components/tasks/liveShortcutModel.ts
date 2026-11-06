/** liveShortcutModel — PURE: what the Sessions-bar Live shortcut shows on its button and when its popover opens. */
import type { FleetRow } from '../../lib/fleet'

/** Hover intent: the pointer must rest this long before the popover opens, so passing over the button costs nothing. */
export const HOVER_OPEN_MS = 300
/** Grace after the pointer leaves button+popover, so crossing the gap between them does not close it. */
export const HOVER_CLOSE_MS = 180

export interface LiveActivity { working: number; waiting: number }

/** Working agents (pulsing green dot) and sessions waiting on the owner (orange badge with a number). */
export function liveActivity(fleet: readonly FleetRow[]): LiveActivity {
  let working = 0, waiting = 0
  for (const r of fleet) {
    if (r.state === 'working') working++
    else if (r.state === 'waiting-approval') waiting++
  }
  return { working, waiting }
}

export function shortcutLabel(a: LiveActivity, pt: boolean): string {
  const base = pt ? 'Live Delivery' : 'Live Delivery'
  const parts: string[] = []
  if (a.waiting > 0) parts.push(pt ? `${a.waiting} esperando você` : `${a.waiting} waiting on you`)
  if (a.working > 0) parts.push(pt ? `${a.working} trabalhando` : `${a.working} working`)
  return parts.length ? `${base} — ${parts.join(', ')}` : base
}

/** A click on the popover's own surface goes to the Live view; a click on a control or card keeps its own job. */
export function popoverClickGoes(target: { closest(sel: string): unknown } | null): boolean {
  return !!target && !target.closest('button, a, input, select, [role="listbox"], [role="option"], [data-live-card]')
}
