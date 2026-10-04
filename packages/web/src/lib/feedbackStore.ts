/**
 * feedbackStore.ts — opens the feedback dialog from anywhere (Settings, the Nay dock, an error state)
 * without threading a prop through each of them. An external store, the `notifications.ts` shape.
 * `harnesses` and the language are told by the app once it knows them, so a surface that has no app context (the root
 * error boundary renders OUTSIDE it) still reports the same names.
 */
import { useSyncExternalStore } from 'react'
import type { FeedbackKind } from './feedback'

export interface FeedbackRequest {
  kind?: FeedbackKind
  title?: string
  description?: string
}

interface State { open: boolean; request: FeedbackRequest; harnesses: readonly string[]; pt: boolean }

let state: State = { open: false, request: {}, harnesses: [], pt: typeof navigator !== 'undefined' && !!navigator.language?.startsWith('pt') }
const listeners = new Set<() => void>()
const set = (next: State) => { state = next; listeners.forEach(l => l()) }

export function openFeedback(request: FeedbackRequest = {}): void { set({ ...state, open: true, request }) }
export function closeFeedback(): void { set({ ...state, open: false }) }
export function setFeedbackContext(harnesses: readonly string[], pt: boolean): void {
  if (pt === state.pt && harnesses.join() === state.harnesses.join()) return
  set({ ...state, harnesses, pt })
}

export function useFeedbackState(): State {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => state,
    () => state,
  )
}
