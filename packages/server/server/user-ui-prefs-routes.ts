/**
 * user-ui-prefs-routes.ts — GET/PUT /api/user-prefs.
 *
 * It touches no host power beyond the preferences file `/api/preferences` already writes, so it
 * is not registered in capability-guard.ts — the same standing as `/api/accessibility`.
 */
import { PROFILE } from './exposure'
import { readPreferences, updatePreferences, type Preferences } from './preferences'
import { machineUiPatch, parseUserUiPut, readMachineUiPrefs } from './user-ui-prefs'
import { readJsonLimited } from './limits'
import { safeError } from './errors'
import { validateNayPreferencePatch } from './sessions/nay-persona'

/** The whole body; each key also has its own cap (`USER_UI_PREF_REGISTRY`). */
const MAX_BODY_BYTES = 512 * 1024

/** The IO this route performs, INJECTABLE so the handler is tested rather than a description of it. */
export interface UserUiPrefsDeps {
  readMachine(): Promise<Record<string, unknown>>
  updateMachine(mutate: (current: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>>
}

const LIVE_DEPS: UserUiPrefsDeps = {
  readMachine: async () => (await readPreferences()) as Record<string, unknown>,
  updateMachine: async mutate => (await updatePreferences(current =>
    mutate(current as Record<string, unknown>) as Partial<Preferences>)) as Record<string, unknown>,
}

export async function handleUserUiPrefs(
  req: Request,
  cors: Record<string, string>,
  deps: UserUiPrefsDeps = LIVE_DEPS,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  try {
    if (req.method === 'GET') {
      return json(readMachineUiPrefs(await deps.readMachine()))
    }

    if (req.method === 'PUT') {
      const read = await readJsonLimited<unknown>(req, MAX_BODY_BYTES)
      if (!read.ok) return json({ error: read.error }, read.error === 'too_large' ? 413 : 400)
      const put = parseUserUiPut(read.value)
      if (!put.ok) return json({ error: put.error, key: put.key }, 400)
      let validatedPatch = put.patch
      if (Object.keys(put.patch).some(key => key === 'chatResponder' || key === 'chatWorkingDir')) {
        try {
          validatedPatch = await validateNayPreferencePatch(await deps.readMachine(), put.patch)
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      }
      // Each key goes to its own machine home — a legacy `top` key stays the field the rest of
      // the server reads; a new key goes under `ui` (see `USER_UI_PREF_REGISTRY`).
      const next = await deps.updateMachine(current => machineUiPatch(current, validatedPatch))
      return json(readMachineUiPrefs(next))
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    const safe = safeError(err, { verbose: PROFILE === 'local' })
    console.error(safe.logLine)
    return json(safe.body, 500)
  }
}
