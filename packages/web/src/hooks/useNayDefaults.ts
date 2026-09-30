/**
 * useNayDefaults.ts — the harness / model / effort every new Nay conversation starts with, as saved
 * in Settings -> Chat (`chatHarness` / `chatModel` / `chatEffort` in `/api/preferences`).
 *
 * One small store for the three places that read or edit it — Settings -> Chat, the dock's gear and
 * the dock's create picker — so changing it in one is seen by the others at once. `''` is the CLI's
 * own default. Saving writes all three keys together: they only mean something as a set (a model
 * belongs to its harness), and the server re-checks them anyway (`sessions/nay-launch.ts`).
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { NayLaunchChoice } from '../lib/nayLaunch'

let current: NayLaunchChoice | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

function load(): Promise<void> {
  if (loading) return loading
  loading = fetch('/api/preferences')
    .then(r => (r.ok ? r.json() : {}) as Promise<{ chatHarness?: string; chatModel?: string; chatEffort?: string }>)
    .catch(() => ({}) as { chatHarness?: string; chatModel?: string; chatEffort?: string })
    .then(p => {
      current = { harness: p.chatHarness ?? '', model: p.chatModel ?? '', effort: p.chatEffort ?? '' }
      emit()
    })
  return loading
}

export function saveNayDefaults(next: NayLaunchChoice): void {
  current = next
  emit()
  void fetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatHarness: next.harness, chatModel: next.model, chatEffort: next.effort }),
  }).catch(() => { /* kept here; the next load reconciles */ })
}

/** `null` until the saved defaults have been read. */
export function useNayDefaults(): NayLaunchChoice | null {
  useEffect(() => { void load() }, [])
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    () => current,
    () => null,
  )
}

/*
 * The harnesses this machine can start, with their models and efforts — the `/api/fleet/new`
 * answer, read ONCE per page and shared. The dock is mounted on every page and only needs this while
 * it is open; a fetch per mount would repeat a project search nobody asked for.
 */
import type { HarnessAnswer } from '../lib/wizardSteps'

let harnessCache: HarnessAnswer[] | null = null
let harnessLoad: Promise<void> | null = null
const harnessListeners = new Set<() => void>()

function loadHarnesses(lang: string): Promise<void> {
  if (harnessLoad) return harnessLoad
  harnessLoad = fetch(`/api/fleet/new?lang=${lang}&q=`)
    .then(r => (r.ok ? r.json() : { harnesses: [] }) as Promise<{ harnesses?: HarnessAnswer[] }>)
    .catch(() => ({ harnesses: [] as HarnessAnswer[] }))
    .then(j => { harnessCache = j.harnesses ?? []; for (const l of harnessListeners) l() })
  return harnessLoad
}

/** `null` until loaded; pass `enabled: false` to read the cache without fetching. */
export function useNayHarnesses(lang: string, enabled = true): HarnessAnswer[] | null {
  useEffect(() => { if (enabled) void loadHarnesses(lang) }, [lang, enabled])
  return useSyncExternalStore(
    fn => { harnessListeners.add(fn); return () => { harnessListeners.delete(fn) } },
    () => harnessCache,
    () => null,
  )
}
