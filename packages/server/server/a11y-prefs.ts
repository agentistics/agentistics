/**
 * a11y-prefs.ts — how accessibility settings are written.
 *
 * `/api/accessibility` reads and writes the `accessibility` key of this machine's
 * `~/.agentistics/preferences.json`; a PUT replaces the stored value whole.
 */
import type { AccessibilityPrefs } from '@agentistics/core'
import { sanitizeAccessibilityPrefs } from '@agentistics/core'

/**
 * A PUT carries the whole object and REPLACES what is stored. It must not deep-merge per page:
 * treating an absent key as "unchanged" would make deleting the last lens of a page impossible.
 *
 * The replace-vs-merge guarantee itself lives in the route handler: it must write
 * applyA11yPut(body) as the whole stored document, never spread it over the document
 * it just read.
 */
export function applyA11yPut(incoming: unknown): AccessibilityPrefs {
  return sanitizeAccessibilityPrefs(incoming)
}
