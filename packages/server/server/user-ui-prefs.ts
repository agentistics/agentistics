/**
 * user-ui-prefs.ts — a person's OWN interface arrangement, and where it lives.
 *
 * `/api/preferences` is the right home for state about the WORK on a machine (`sharedPref.ts` on
 * the web says why), and the wrong one for state about how ONE PERSON arranges a screen on a
 * central: there that file belongs to the container and is shared by everyone signed in, so one
 * person's hidden columns would hide them for the whole team. This is the rule `a11y-prefs.ts`
 * already applies to the magnifiers, generalised to any key — and the store resolution is that
 * module's, reused rather than restated: a machine writes its preferences file, a central writes
 * the account's `userPrefs` document, and a central session with no account reads nothing and
 * writes nothing (never the machine file).
 *
 * THE KEYS ARE A CLOSED LIST. The values are opaque to the server — each one is sanitised by the
 * web store that owns it, because the shapes (`ColumnId`, `BoardStatus`, …) live in the web
 * bundle — so what keeps this from becoming a dump for anything a client sends is that only a key
 * listed here is stored, every value must be a plain JSON object, and the whole body is bounded.
 * A new personal preference is added here on purpose, the same way a capability is registered.
 */

/** Every key `/api/user-prefs` accepts. `taskBoard` = `web/src/components/tasks/boardPrefs.ts`. */
export const USER_UI_PREF_KEYS = ['taskBoard'] as const
export type UserUiPrefKey = typeof USER_UI_PREF_KEYS[number]
export type UserUiPrefs = Partial<Record<UserUiPrefKey, Record<string, unknown>>>

const isKey = (k: string): k is UserUiPrefKey => (USER_UI_PREF_KEYS as readonly string[]).includes(k)

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * PURE: what a stored document may be read back as. Total — a hand-edited preferences file or a
 * document written by a later build yields only the keys this build knows, each a plain object.
 */
export function readUserUiPrefs(stored: unknown): UserUiPrefs {
  if (!isPlainObject(stored)) return {}
  const out: UserUiPrefs = {}
  for (const [k, v] of Object.entries(stored)) if (isKey(k) && isPlainObject(v)) out[k] = v
  return out
}

export type UserUiPut =
  | { ok: true; patch: UserUiPrefs }
  | { ok: false; error: 'not_an_object' | 'unknown_key' | 'bad_value'; key?: string }

/**
 * PURE: validate a PUT. The body is a PATCH by key (`{ taskBoard: {...} }`): each named key is
 * REPLACED whole, keys not named are left alone — two stores writing different keys must not
 * clobber each other, the rule `writePreferences` keeps across preference keys. A key outside the
 * closed list is REFUSED rather than dropped, so a client asking for something this server will
 * not keep finds out instead of believing it was saved.
 */
export function parseUserUiPut(body: unknown): UserUiPut {
  if (!isPlainObject(body)) return { ok: false, error: 'not_an_object' }
  const patch: UserUiPrefs = {}
  for (const [k, v] of Object.entries(body)) {
    if (!isKey(k)) return { ok: false, error: 'unknown_key', key: k }
    if (!isPlainObject(v)) return { ok: false, error: 'bad_value', key: k }
    patch[k] = v
  }
  return { ok: true, patch }
}
