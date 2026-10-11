export type NayTabRequest = 'limits'
const listeners = new Set<(tab: NayTabRequest) => void>()
export function requestNayTab(tab: NayTabRequest): void { for (const fn of listeners) fn(tab) }
export function subscribeNayRequests(fn: (tab: NayTabRequest) => void): () => void { listeners.add(fn); return () => listeners.delete(fn) }
