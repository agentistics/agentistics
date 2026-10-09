/**
 * adapter-state-host.ts — the process's ONE `AdapterStateFeed` (`adapter-state.ts`), wired to the
 * engine and the `adapter-chat` flag.
 *
 * `hostAdapterState()` is what the fleet poller asks on every poll: `null` with the flag off (the poller
 * is then exactly what it was), `null` before an engine has loaded or with none (a community build), and
 * the feed otherwise. Turning the flag off at runtime releases every subscription.
 */
import { featureOn } from '@agentistics/core'
import type { HarnessChat } from '@agentistics/engine-api'
import { engine } from '../engine/load'
import { createAdapterStateFeed, type AdapterStateFeed } from './adapter-state'

let feed: AdapterStateFeed | null = null
const listeners = new Set<() => void>()

function chatOf(harness: string): HarnessChat | undefined {
  const integrations = engine()?.integrations as Record<string, { chat?: HarnessChat } | undefined> | undefined
  return integrations?.[harness]?.chat
}

export function hostAdapterState(): AdapterStateFeed | null {
  if (!featureOn('adapter-chat')) {
    if (feed) { feed.stop(); feed = null }
    return null
  }
  if (!engine()) return null
  if (!feed) {
    feed = createAdapterStateFeed({ chatOf })
    feed.onChange(() => { for (const l of listeners) l() })
  }
  return feed
}

/** Called (debounced) when a harness states a change — the hub polls at once instead of at its tick. */
export function onAdapterStateChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** An act was just performed on this row: read its screen on the next poll (a no-op with the flag off). */
export function forceRowScreen(id: string): void {
  feed?.forceScreen(id)
}
