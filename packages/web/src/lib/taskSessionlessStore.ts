/**
 * taskSessionlessStore.ts — whether the task detail on screen has no session at any level.
 *
 * The app header's "Stats" tab (the "In view N sessions · cost · tokens" strip) describes the
 * FLEET under the current filters; over a plain to-do it reads as a row of zeros, which is the
 * "empty / broken" look a sessionless task must not have. `DeliveryDetail` publishes the fact and
 * `App` hides the strip while it is true — an external store (the `lib/notifications.ts` shape)
 * because the two are far apart in the tree.
 */
import { useSyncExternalStore } from 'react'

let sessionless = false
const listeners = new Set<() => void>()

export function setTaskSessionless(v: boolean): void {
  if (v === sessionless) return
  sessionless = v
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useTaskSessionless = (): boolean => useSyncExternalStore(subscribe, () => sessionless, () => false)
