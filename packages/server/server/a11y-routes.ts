/**
 * a11y-routes.ts — GET/PUT /api/accessibility.
 *
 * It touches no host power beyond the preferences file `/api/preferences` already writes, so it
 * is not registered in capability-guard.ts either.
 *
 * CORS headers are PASSED IN rather than imported: `index.ts` builds them per request from the
 * caller's origin, so there is no module-level constant to reach for.
 */
import { sanitizeAccessibilityPrefs } from '@agentistics/core'
import { PROFILE } from './exposure'
import { readPreferences, writePreferences } from './preferences'
import { applyA11yPut } from './a11y-prefs'
import { readJsonLimited } from './limits'
import { safeError } from './errors'

/** A lens document is small; a body larger than this is not one. */
const MAX_BODY_BYTES = 64 * 1024

export async function handleAccessibility(
  req: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  try {
    if (req.method === 'GET') {
      return json(sanitizeAccessibilityPrefs((await readPreferences()).accessibility))
    }

    if (req.method === 'PUT') {
      const read = await readJsonLimited<unknown>(req, MAX_BODY_BYTES)
      if (!read.ok) return json({ error: read.error }, read.error === 'too_large' ? 413 : 400)
      const prefs = applyA11yPut(read.value)
      await writePreferences({ accessibility: prefs })
      return json(prefs)
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    const safe = safeError(err, { verbose: PROFILE === 'local' })
    console.error(safe.logLine)
    return json(safe.body, 500)
  }
}
