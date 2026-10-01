/**
 * appFlags.ts — three small CHOICES `App.tsx` used to keep in `localStorage` alone, now on the
 * server (`/api/user-prefs`; per ACCOUNT on a central) so they read the same on every device. Each
 * keeps its old key AND its old `'1'`/`'0'` format as the first-paint copy and the one-time
 * migration source (see `sharedPref.ts`).
 */
import { createSharedPref } from './sharedPref'

const flag = (raw: string): unknown => (raw === '1' ? true : raw === '0' ? false : null)
const bit = (v: boolean | null): string => (v ? '1' : '0')
const asBool = (raw: unknown): boolean | null => (typeof raw === 'boolean' ? raw : null)

/** Is the Sessions workspace's filter panel open? Absent = closed. */
export const sessionsFiltersOpenStore = createSharedPref<boolean>({
  key: 'agentistics-sessions-filters-open', prefKey: 'sessionsFiltersOpen', fallback: false,
  adoptLocalWhenAbsent: true, parse: asBool, decode: flag, encode: bit,
})

/** Is the dashboard's fleet strip open? `null` = never chosen, and the caller picks by screen. */
export const fleetOpenStore = createSharedPref<boolean | null>({
  key: 'agentistics-fleet-open', prefKey: 'fleetOpen', fallback: null,
  // The old reader treated anything but `'0'` as open, so the decoder does too.
  adoptLocalWhenAbsent: true, parse: asBool, decode: raw => raw !== '0', encode: bit,
})

/** Has the Studio's first-open dot fired? Once true it stays true. */
export const studioSeenStore = createSharedPref<boolean>({
  key: 'agentistics.studio.seen', prefKey: 'studioSeen', fallback: false,
  adoptLocalWhenAbsent: true, parse: asBool, decode: raw => raw === '1', encode: bit,
})
