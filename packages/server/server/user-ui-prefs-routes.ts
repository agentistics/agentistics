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
import { readPreferences, updatePreferences, type Preferences } from './preferences'
import { readUserUi, writeUserUi } from './user-prefs-store'
import { resolveA11yStore } from './a11y-prefs'
import { machineUiPatch, parseUserUiPut, readMachineUiPrefs, readUserUiPrefs } from './user-ui-prefs'
import { readJsonLimited } from './limits'
import { safeError } from './errors'

/** The whole body; each key also has its own cap (`USER_UI_PREF_REGISTRY`). */
const MAX_BODY_BYTES = 512 * 1024

/**
 * The IO this route performs, INJECTABLE so the central isolation (two accounts never see each
 * other's choices) is tested against this very handler rather than a description of it. Every
 * production caller passes nothing and gets the real stores.
 */
export interface UserUiPrefsDeps {
  central: boolean
  accountOf(req: Request): Promise<string | null>
  readMachine(): Promise<Record<string, unknown>>
  updateMachine(mutate: (current: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>>
  readAccount(accountId: string): Promise<unknown>
  writeAccount(accountId: string, patch: Record<string, unknown>): Promise<void>
}

const LIVE_DEPS: UserUiPrefsDeps = {
  central: TEAM_CENTRAL,
  accountOf: async req => (await getPrincipal(req))?.accountId ?? null,
  readMachine: async () => (await readPreferences()) as Record<string, unknown>,
  // Read-modify-write INSIDE the preferences write chain, so two keys saved in the same instant
  // cannot each start from a copy missing the other.
  updateMachine: async mutate => (await updatePreferences(current =>
    mutate(current as Record<string, unknown>) as Partial<Preferences>)) as Record<string, unknown>,
  readAccount: readUserUi,
  writeAccount: writeUserUi,
}

export async function handleUserUiPrefs(
  req: Request,
  cors: Record<string, string>,
  deps: UserUiPrefsDeps = LIVE_DEPS,
): Promise<Response> {
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json', ...extra },
    })

  try {
    const store = resolveA11yStore(deps.central, await deps.accountOf(req))

    if (req.method === 'GET') {
      // `X-Prefs-Writable` lets the web stay UNARMED where a write would be refused, rather than
      // collecting a 409 on every change and overwriting the browser's copy with the defaults.
      const writable = { 'X-Prefs-Writable': store.kind === 'anonymous' ? 'false' : 'true' }
      if (store.kind === 'machine') {
        return json(readMachineUiPrefs(await deps.readMachine()), 200, writable)
      }
      if (store.kind === 'account') return json(readUserUiPrefs(await deps.readAccount(store.accountId)), 200, writable)
      // Anonymous on a central: nothing of anybody's. Handing back the machine file would be
      // handing back whoever last arranged it.
      return json({}, 200, writable)
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
        // Each key goes to its own machine home — a legacy `top` key stays the field the rest of
        // the server reads; a new key goes under `ui` (see `USER_UI_PREF_REGISTRY`).
        const next = await deps.updateMachine(current => machineUiPatch(current, put.patch))
        return json(readMachineUiPrefs(next))
      }
      await deps.writeAccount(store.accountId, put.patch)
      return json(readUserUiPrefs(await deps.readAccount(store.accountId)))
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    const safe = safeError(err, { verbose: PROFILE === 'local' })
    console.error(safe.logLine)
    return json(safe.body, 500)
  }
}
