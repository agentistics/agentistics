/**
 * chatSelection.ts — the conversation's SELECTION MODE, published to the workspace's header.
 *
 * Selecting messages is modelled on WhatsApp: the header over the conversation turns into
 * "N selected · Forward · Copy · Cancel" for as long as the mode lasts. The header is not the chat's
 * own DOM — on a desktop it is `App.tsx`'s shared sticky strip, on a phone `SessionsPage`'s bar — so
 * the chat PUBLISHES its selection here and whichever header is on screen reads it. A prop threaded
 * from the chat up through the page into `App` would be three components carrying a value only two
 * of them use.
 *
 * ONE SELECTION AT A TIME, owned by whoever set it. `clear(owner)` only clears the owner's own
 * entry, so a chat unmounting after another has already taken the header cannot blank the newer one.
 */

import { useSyncExternalStore } from 'react'

export interface ChatSelectionState {
  /** Who published this — the chat's scratch key. */
  owner: string
  count: number
  forward: () => void
  copy: () => void
  cancel: () => void
  /** "Reply (N)": quote every ticked message in the composer. Absent where the session cannot be written to. */
  reply?: () => void
}

export interface ChatSelectionStore {
  get(): ChatSelectionState | null
  set(next: ChatSelectionState): void
  clear(owner: string): void
  subscribe(fn: () => void): () => void
}

export function createChatSelectionStore(): ChatSelectionStore {
  let current: ChatSelectionState | null = null
  const listeners = new Set<() => void>()
  const emit = () => { for (const l of listeners) l() }
  return {
    get: () => current,
    set(next) { current = next; emit() },
    clear(owner) {
      if (current === null || current.owner !== owner) return
      current = null
      emit()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

export const chatSelection: ChatSelectionStore = createChatSelectionStore()

/** The selection currently on screen, or `null` when no conversation is in selection mode. */
export function useChatSelection(): ChatSelectionState | null {
  return useSyncExternalStore(chatSelection.subscribe, chatSelection.get, chatSelection.get)
}
