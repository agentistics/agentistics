/**
 * "Open the plan usage" is a navigation to the Uso page (`/usage`), where the accounts, the limits and
 * the APIs (ElevenLabs key and balance included) live. It used to open a modal; there is no modal any
 * more. The bus stays because the callers sit far from the router: the App subscribes once and navigates.
 */
const listeners = new Set<() => void>()
export function requestUsagePage(): void { for (const fn of listeners) fn() }
export function subscribeUsagePage(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
