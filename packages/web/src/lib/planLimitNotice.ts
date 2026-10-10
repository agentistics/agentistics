/**
 * PLAN.LIMITS — a threshold notice the server raised (`limits.threshold` / `limits.exhausted`,
 * once per threshold per window period — core `planThresholdNotices`) becomes Nay's card, the same
 * way a session notice does: the bell keeps the record, the card speaks it, do-not-disturb and a
 * hidden tab leave it in the bell (the toast then shows it instead).
 */
import type { AppNotification } from './notifications'
import { pushAlert } from './nayNotifyStore'
import { getNotificationSettings } from './sessionNotifications'
import { limitNoticeMeta } from './planLimits'

export const LIMIT_CODES: ReadonlySet<string> = new Set(['limits.threshold', 'limits.exhausted'])

/** Queue the Nay card for a limit notice. False when it did not (the toast shows it then). */
export function pushLimitAlert(n: Pick<AppNotification, 'id' | 'code' | 'meta' | 'ts'>): boolean {
  if (!n.code || !LIMIT_CODES.has(n.code)) return false
  const m = limitNoticeMeta(n.meta)
  if (!m) return false
  if (getNotificationSettings().doNotDisturb) return false
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false
  return pushAlert({
    key: `limit:${n.id}`,
    kind: 'limit',
    sessionId: `limits:${m.harness}`,
    name: m.harness,
    harness: m.harness,
    sinceMs: n.ts,
    sinceKnown: true,
    limit: m,
  })
}
