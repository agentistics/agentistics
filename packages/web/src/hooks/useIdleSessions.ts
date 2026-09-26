/**
 * Derives idle candidates from the LIVE fleet on every poll and announces each new batch once.
 * Local machine only — the caller passes `enabled: false` on a central.
 *
 * NEVER POLLS HARDWARE ITSELF. `useHardwareSnapshot` is NOT a shared/module-level poller like
 * `useFleet` — every call mounts its OWN `setInterval(…, 5000)` against `/api/hardware-resources`
 * (see `HardwareModal.tsx`'s own header, which claims one shared loop but implements a per-call
 * one). `SessionsPage.tsx` already calls `useHardwarePressureWatch`, which itself calls
 * `useHardwareSnapshot` — so a second call here would run a SECOND, independent 5s poll of the same
 * endpoint, and would keep polling even with `enabled: false` (a central, where this feature must
 * not run at all). The CALLER passes `underPressure`, read from `useHardwarePressureWatch`'s own
 * `ramUnderPressure` (the poll it already runs), so there is exactly one hardware poll on the page.
 */
import { useEffect, useMemo } from 'react'
import { freedBytes, idleCandidates, idleNotifyStep, sessionIdentityKey, type IdleCandidate } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { pushNotification } from '../lib/notifications'
import { pruneKept, useIdlePrefs } from '../lib/idleSessionsPrefs'
import { toIdleRow } from '../lib/idleRows'

export function fmtGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

// MODULE SCOPE, deliberately not a `useRef`: a ref is per-MOUNT, so leaving `/sessions` and coming
// back (or any remount of whatever component holds this hook) reset it to empty and re-announced a
// batch the user had already been told about. One tab should see one notification per newly-idle
// batch regardless of how many times the hook mounts within it.
let notifiedIds: ReadonlySet<string> = new Set()

export function useIdleSessions(args: {
  rows: ControlSession[]; finishedTasks: string[]; openSessionId: string | null; underPressure: boolean; enabled: boolean
}): { candidates: IdleCandidate[] } {
  const prefs = useIdlePrefs()
  const inputs = useMemo(() => args.rows.map(r => toIdleRow(r, args.finishedTasks)), [args.rows, args.finishedTasks])
  const candidates = useMemo(() => (!args.enabled || !prefs.enabled) ? [] : idleCandidates(inputs, {
    now: Date.now(),
    thresholdMs: prefs.thresholdMin * 60_000,
    pressureThresholdMs: prefs.pressureThresholdMin * 60_000,
    underPressure: args.underPressure,
    openSessionId: args.openSessionId,
    kept: prefs.kept,
  }), [inputs, prefs, args.underPressure, args.openSessionId, args.enabled])

  useEffect(() => {
    const step = idleNotifyStep(notifiedIds, candidates)
    notifiedIds = step.next
    if (!step.notify) return
    // LANGUAGE-NEUTRAL meta — see `NOTIFICATION_TEXT['sessions.idle']`'s own header. `names` is the
    // first three titles, `more` is a plain count (never pre-worded: "and N more"/"e mais N" is
    // composed at render time by `idleMoreSuffix`, or it would freeze in today's language), and
    // `freed` is a pre-formatted amount with no verb around it — `idleFreedSentence` supplies that.
    const top = candidates.slice(0, 3).map(c => args.rows.find(r => r.id === c.row.id)?.title ?? c.row.id)
    const freed = freedBytes(candidates)
    pushNotification({
      type: 'info', code: 'sessions.idle',
      meta: {
        count: candidates.length,
        names: top.join(', '),
        more: Math.max(0, candidates.length - top.length),
        ...(freed === null ? {} : { freed: fmtGB(freed) }),
      },
    })
  }, [candidates, args.rows])

  // Keep marks for sessions that no longer exist are dropped.
  useEffect(() => {
    if (args.rows.length === 0) return
    pruneKept(new Set(args.rows.map(r => sessionIdentityKey(r))))
  }, [args.rows])

  return { candidates }
}
