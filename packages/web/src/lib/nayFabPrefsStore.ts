/**
 * nayFabPrefsStore.ts — the Nay button's place and motion choices, shared by every screen that
 * shows or edits them.
 *
 * They lived as state inside `NayDock`, which was fine while the dock's gear was the only place to
 * change them. Settings → Chat edits the same three motion choices now (button drag, dock follow,
 * notification card), and two copies of one setting would disagree the moment either was changed.
 * So the value lives here, in the `useSyncExternalStore` shape `notifications.ts` uses.
 *
 * PER BROWSER (`localStorage`), never the shared preferences file: where a floating button sits and
 * how it moves is about this screen, like a pane width, not about the work. Every storage touch is
 * guarded: a private window makes the accessor itself throw.
 */

import { useSyncExternalStore } from 'react'
import { DEFAULT_NAY_FAB_PREFS, parseNayFabPrefs, type NayFabPrefs } from './nayFab'

const KEY = 'agentistics-nay-fab'

function read(): NayFabPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null ? DEFAULT_NAY_FAB_PREFS : parseNayFabPrefs(JSON.parse(raw))
  } catch { return DEFAULT_NAY_FAB_PREFS }
}

let current: NayFabPrefs = typeof window === 'undefined' ? DEFAULT_NAY_FAB_PREFS : read()
const listeners = new Set<() => void>()

export function getNayFabPrefs(): NayFabPrefs { return current }

export function setNayFabPrefs(next: NayFabPrefs): void {
  current = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* a convenience, never required */ }
  for (const l of listeners) l()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // Another tab changed it: follow, so two open tabs never draw two different buttons.
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { current = read(); fn() } }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => { listeners.delete(fn); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage) }
}

export function useNayFabPrefs(): NayFabPrefs {
  return useSyncExternalStore(subscribe, getNayFabPrefs, () => DEFAULT_NAY_FAB_PREFS)
}
