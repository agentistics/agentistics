/**
 * user-ui-prefs-routes.ts — GET/PUT /api/user-prefs.
 *
 * Authenticated by the default rule (NOT in AUTH_PUBLIC). It touches no host power beyond the
 * preferences file `/api/preferences` already writes, so it is not registered in
 * capability-guard.ts — the same standing as `/api/accessibility`, whose store resolution it
 * reuses (`resolveA11yStore`): the choice of WHERE a person's own settings live is made once.
 */
import { getPrincipal } from './auth'
import { TEAM_CENTRAL } from './config'
import { PROFILE } from './exposure'
import { readPreferences, updatePreferences } from './preferences'
import { readUserUi, writeUserUi } from './user-prefs-store'
import { resolveA11yStore } from './a11y-prefs'
import { parseUserUiPut, readUserUiPrefs } from './user-ui-prefs'
import { readJsonLimited } from './limits'
import { safeError } from './errors'

/** A board arrangement is a few hundred bytes; a body larger than this is not one. */
const MAX_BODY_BYTES = 64 * 1024

export async function handleUserUiPrefs(
  req: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  try {
    const principal = await getPrincipal(req)
    const store = resolveA11yStore(TEAM_CENTRAL, principal?.accountId ?? null)

    if (req.method === 'GET') {
      if (store.kind === 'machine') return json(readUserUiPrefs((await readPreferences()).ui))
      if (store.kind === 'account') return json(readUserUiPrefs(await readUserUi(store.accountId)))
      // Anonymous on a central: nothing of anybody's. Handing back the machine file would be
      // handing back whoever last arranged it.
      return json({})
    }

    if (req.method === 'PUT') {
      if (store.kind === 'anonymous') {
        return json({ error: 'sign in with an account to save your arrangement' }, 409)
      }
      const read = await readJsonLimited<unknown>(req, MAX_BODY_BYTES)
      if (!read.ok) return json({ error: read.error }, read.error === 'too_large' ? 413 : 400)
      const put = parseUserUiPut(read.value)
      if (!put.ok) return json({ error: put.error, key: put.key }, 400)
      if (store.kind === 'machine') {
        // Read-modify-write INSIDE the preferences write chain, so two keys saved in the same
        // instant cannot each start from a copy missing the other.
        const next = await updatePreferences(current => ({
          ui: { ...readUserUiPrefs(current.ui), ...put.patch } as Record<string, Record<string, unknown>>,
        }))
        return json(readUserUiPrefs(next.ui))
      }
      await writeUserUi(store.accountId, put.patch as Record<string, Record<string, unknown>>)
      return json(readUserUiPrefs(await readUserUi(store.accountId)))
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    const safe = safeError(err, { verbose: PROFILE === 'local' })
    console.error(safe.logLine)
    return json(safe.body, 500)
  }
}
