import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const writes = new Map<string, number>()
const emit = () => { for (const listener of listeners) listener() }
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }

export function beginStatusWrite(key: string): () => void {
  writes.set(key, (writes.get(key) ?? 0) + 1); emit()
  return () => { const n = (writes.get(key) ?? 1) - 1; if (n) writes.set(key, n); else writes.delete(key); emit() }
}
export function useStatusPending(key?: string): boolean {
  return useSyncExternalStore(subscribe, () => key ? writes.has(key) : writes.size > 0, () => false)
}

type ReviewPrompt = { count: number; resolve: (yes: boolean) => void }
let prompt: ReviewPrompt | null = null
export function requestReviewOverride(count: number): Promise<boolean> {
  if (prompt) return Promise.resolve(false)
  return new Promise(resolve => { prompt = { count, resolve }; emit() })
}
export function answerReviewOverride(yes: boolean): void {
  const current = prompt; prompt = null; emit(); current?.resolve(yes)
}
export function useReviewOverride(): ReviewPrompt | null {
  return useSyncExternalStore(subscribe, () => prompt, () => null)
}
