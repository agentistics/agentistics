/**
 * useHardwarePressureWatch — the rail's own Hardware icon turning red, plus the notification that
 * goes with it (addendum item 6, right-icon-rail spec).
 *
 * REUSES THE EXISTING HARDWARE SOURCE: `useHardwareSnapshot` is the very hook `HardwareModal.tsx`
 * already polls `/api/hardware-resources` through (every 5s) — this is a second CALL of that same
 * function, not a second reader of the machine, so the figures the rail's icon reacts to are
 * provably the same ones the modal draws. The PURE decision of what counts as pressure lives in
 * `lib/hardwarePressure.ts`, tested on its own; this hook is only the wiring — sample, decide,
 * remember the last reading, and notify exactly on the crossing into critical.
 *
 * THE NOTIFICATION CHANNEL IS THE EXISTING ONE TOO (`pushNotification`, `lib/notifications.ts`) —
 * client-originated, server-deduped, rendered by the same bell every other client-side notice goes
 * through. No new delivery mechanism.
 *
 * `pressureWatchStep` BELOW IS THE WHOLE DECISION, PULLED OUT PURE (rail-loose-ends, item 3) — this
 * repo has no jsdom to render the hook itself and drive it with a live snapshot, so the hook's own
 * body is reduced to the one thing that genuinely needs React (the `useHardwareSnapshot` poll and
 * the two refs/state it feeds), and everything it DECIDES — the icon's colour, whether a
 * notification fires and what it says — is a plain function call a test can drive directly with a
 * constructed `HardwarePressureInput`, the same pattern `usePlanBasis.test.ts`'s
 * `computePlanBasisView` already uses for a hook this package cannot otherwise test.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useHardwareSnapshot } from '../components/HardwareModal'
import {
  anyCritical, pressureRecommendation, pressureTransition, resourcesPressure,
  type HardwarePressureInput,
} from '../lib/hardwarePressure'
import { pushNotification, type NotificationType } from '../lib/notifications'

/**
 * PURE: is RAM specifically at `warn` or `critical` right now? Exported so `useIdleSessions.ts`
 * (which must never poll hardware itself — see that hook's own header) can derive its
 * `underPressure` flag from the SAME reading this hook already polls, rather than opening a second
 * `/api/hardware-resources` interval. `false` when there is no reading at all (`hardware === null`)
 * or RAM specifically could not be measured — never a guess in either direction.
 */
export function ramUnderPressure(hardware: HardwarePressureInput | null): boolean {
  if (!hardware) return false
  return resourcesPressure(hardware).some(p => p.resource === 'ram' && p.level !== 'ok')
}

/** The exact shape `pushNotification` (`lib/notifications.ts`) takes — that module exports no
 *  named type for it, so this mirrors its inline parameter type rather than widening it. */
export interface NotificationPayload {
  type: NotificationType
  code?: string
  meta?: Record<string, unknown>
  title?: string
  message?: string
}

export interface PressureWatchResult {
  /** The new "last known critical" fact, fed back in as the next call's `prevCritical` — held
   *  UNCHANGED (same value passed in) whenever `hardware` is `null`, exactly like the hook's own
   *  `prevRef` never advancing past a poll that could not read anything. */
  prevCritical: boolean | null
  /** What the rail icon's colour should show right now. */
  critical: boolean
  /** The notification to fire this step, or `null` on every step that is not a fresh crossing into
   *  critical (`pressureTransition`'s own rule, unchanged). */
  notify: NotificationPayload | null
}

/**
 * ONE POLL'S WORTH OF DECISION, taking the machine out of the picture entirely: given the LAST
 * known critical fact and this poll's own reading (or `null` — the machine could not be read this
 * time), decide the icon's colour and whether to notify. `resourcesPressure`/`anyCritical`/
 * `pressureTransition`/`pressureRecommendation` are `hardwarePressure.ts`'s own pure layer, already
 * tested there — this is only their composition into one step, so a hook that DOES render (a real
 * browser, or a future jsdom pass) and this test suite can never read the arithmetic two different
 * ways.
 */
export function pressureWatchStep(
  prevCritical: boolean | null,
  hardware: HardwarePressureInput | null,
  lang: 'pt' | 'en',
): PressureWatchResult {
  // No reading this poll — the same "nothing to check, nothing changes" the hook's own
  // `if (!hardware) return` already encoded: neither the remembered fact nor the icon moves.
  if (!hardware) return { prevCritical, critical: prevCritical ?? false, notify: null }
  const pressures = resourcesPressure(hardware)
  const next = anyCritical(pressures)
  const detail = pressureTransition(prevCritical, next) ? pressureRecommendation(pressures, lang) : null
  const notify: NotificationPayload | null = pressureTransition(prevCritical, next)
    ? {
      type: 'warning',
      code: 'hardware.pressure',
      // `detail` is already the fully-localized recommendation sentence (`pressureRecommendation`
      // took `lang` itself) — carried as `meta` so the notification's own EN/PT copy interpolates
      // it at render time like every other placeholder in `NOTIFICATION_TEXT`, never baked into a
      // raw title/message that would freeze in whichever language was active at the moment.
      ...(detail ? { meta: { detail } } : {}),
    }
    : null
  return { prevCritical: next, critical: next, notify }
}

export function useHardwarePressureWatch(lang: 'pt' | 'en'): { critical: boolean; ramUnderPressure: boolean } {
  const { hardware } = useHardwareSnapshot(lang)
  // `null` = no reading exists yet. `pressureTransition`'s own rule refuses to fire off that gap —
  // see that function's own header for why treating it as `false` would be wrong.
  const prevRef = useRef<boolean | null>(null)
  const [critical, setCritical] = useState(false)

  useEffect(() => {
    const step = pressureWatchStep(prevRef.current, hardware, lang)
    prevRef.current = step.prevCritical
    setCritical(step.critical)
    if (step.notify) pushNotification(step.notify)
  }, [hardware, lang])

  // Read off the SAME poll `useHardwareSnapshot` above already runs — `useIdleSessions.ts` takes
  // this rather than opening its own hardware interval.
  const ram = useMemo(() => ramUnderPressure(hardware), [hardware])

  return { critical, ramUnderPressure: ram }
}
