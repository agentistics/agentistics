/**
 * relayedAside.ts — PURE: which of the session aside's tabs a CENTRAL can fill for another
 * machine's session.
 *
 * Every tab but one reads the machine's own disk or conversation through `/api/fleet/*` or
 * `/api/mcp/*` — routes a central refuses by design (`index.ts`'s `TEAM_CENTRAL` block,
 * `capability-guard.ts`), because it has no access to a member's host. Mounted anyway, they fired
 * a row of 403s on every open and drew empty or errored panels, which read as "nothing works here".
 * `metrics` is the exception: it is the session's record in the store, which the central holds.
 */
import type { TabPanelId } from './panelSlots'

export function relayedTabAvailable(id: TabPanelId): boolean {
  return id === 'metrics'
}
