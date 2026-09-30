/**
 * nayFabPrefsStore.ts — the Nay button's place and motion choices, shared by every screen that
 * shows or edits them (the chat window's settings screen and Settings → Chat).
 *
 * TWO HALVES, stored where each belongs:
 *  - WHERE the button sits and whether an edge pulls it in (`pos`, `snap`) is about THIS screen, like
 *    a pane width, so it stays per browser in `localStorage`;
 *  - the three MOTION choices (button drag, dock follow, notification card) are a preference about
 *    the product, so they live in `/api/preferences` (`nayMotion`, through `createSharedPref`) and
 *    every device shows the same (owner, 2026-09-30). The local copy of the style written before
 *    this existed is still read for the first paint, so nobody's choice is lost.
 *
 * Every storage touch is guarded: a private window makes the accessor itself throw.
 */

import { useSyncExternalStore } from 'react'
import { DEFAULT_NAY_FAB_PREFS, isNayFabStyle, parseNayFabPrefs, type NayFabPrefs, type NayFabStyle } from './nayFab'
import { createSharedPref } from './sharedPref'

const KEY = 'agentistics-nay-fab'

/** The motion half, as `/api/preferences` stores it. Absent dock/card = inherit the button's. */
export interface NayMotionPrefs { style?: NayFabStyle; dockStyle?: NayFabStyle; cardStyle?: NayFabStyle }

function readLocal(): NayFabPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null ? DEFAULT_NAY_FAB_PREFS : parseNayFabPrefs(JSON.parse(raw))
  } catch { return DEFAULT_NAY_FAB_PREFS }
}

const motion = createSharedPref<NayMotionPrefs>({
  key: 'agentistics-nay-motion',
  prefKey: 'nayMotion',
  fallback: {},
  parse: raw => {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    return {
      ...(isNayFabStyle(o.style) ? { style: o.style } : {}),
      ...(isNayFabStyle(o.dockStyle) ? { dockStyle: o.dockStyle } : {}),
      ...(isNayFabStyle(o.cardStyle) ? { cardStyle: o.cardStyle } : {}),
    }
  },
})

let local: NayFabPrefs = typeof window === 'undefined' ? DEFAULT_NAY_FAB_PREFS : readLocal()
let current: NayFabPrefs = combine()
const listeners = new Set<() => void>()

/** The place from this browser, the motion from the shared preference (the local style as the floor). */
function combine(): NayFabPrefs {
  const m = motion.get()
  const out: NayFabPrefs = { style: m.style ?? local.style, snap: local.snap, pos: local.pos }
  if (m.dockStyle) out.dockStyle = m.dockStyle
  if (m.cardStyle) out.cardStyle = m.cardStyle
  return out
}

function emit(): void { current = combine(); for (const l of listeners) l() }
motion.subscribe(emit)

export function getNayFabPrefs(): NayFabPrefs { return current }

export function setNayFabPrefs(next: NayFabPrefs): void {
  local = { style: next.style, snap: next.snap, pos: next.pos }
  try { localStorage.setItem(KEY, JSON.stringify(local)) } catch { /* a convenience, never required */ }
  const m = motion.get()
  const changed = m.style !== next.style || m.dockStyle !== next.dockStyle || m.cardStyle !== next.cardStyle
  if (changed) {
    motion.set({
      style: next.style,
      ...(next.dockStyle ? { dockStyle: next.dockStyle } : {}),
      ...(next.cardStyle ? { cardStyle: next.cardStyle } : {}),
    })
  }
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function useNayFabPrefs(): NayFabPrefs {
  return useSyncExternalStore(subscribe, getNayFabPrefs, () => DEFAULT_NAY_FAB_PREFS)
}
