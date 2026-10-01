/**
 * centralMachinePick.ts — which machine a CENTRAL's Sessions workspace is looking at.
 *
 * Module scope, not React state, for the same reason `fleet.ts`'s poller is: the picker draws in
 * the aside and the fleet is fetched by the poller, and two copies of "which machine" is how a list
 * ends up describing one machine while a header counts another.
 *
 * Remembered per PERSON on the server (`/api/user-prefs`, `centralMachine` — per ACCOUNT, the only
 * store this ever reaches, since it exists only on a central), so reopening the app on any device
 * lands where you left it. The browser copy under the old key (a bare id, kept in that format) is
 * the first paint and the one-time migration source.
 */

import { createSharedPref } from './sharedPref'

const KEY = 'agentistics-central-machine'

let picked: string | null = null
let loaded = false
const listeners = new Set<() => void>()

const store = createSharedPref<string | null>({
  key: KEY, prefKey: 'centralMachine', fallback: null, adoptLocalWhenAbsent: true,
  parse: raw => (typeof raw === 'string' && raw ? raw : null),
  decode: raw => raw, encode: v => v ?? '',
})
store.subscribe(() => {
  const next = store.get()
  if (next === picked) return
  picked = next
  for (const fn of listeners) fn()
})

function load(): void {
  if (loaded) return
  loaded = true
  picked = store.get()
}

export function getCentralMachine(): string | null {
  load()
  return picked
}

export function setCentralMachine(id: string | null): void {
  load()
  if (picked === id) return
  picked = id
  store.set(id)
  for (const fn of listeners) fn()
}

export function subscribeCentralMachine(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** `useSyncExternalStore`'s server snapshot — there is no machine before hydration. */
export function centralMachineServerSnapshot(): string | null {
  return null
}
