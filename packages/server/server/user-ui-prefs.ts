/**
 * user-ui-prefs.ts — a person's OWN interface choices, and where they live.
 *
 * `/api/preferences` is the MACHINE's file, and on a central that file belongs to the container and
 * is shared by everyone signed in — so one person's pins, theme or hidden columns became everyone's.
 * This is the rule `a11y-prefs.ts` already applies to the magnifiers, generalised to any key, and
 * the store resolution is that module's, reused rather than restated: a machine writes its
 * preferences file, a central writes the account's `userPrefs` document, and a central session with
 * no account reads nothing and writes nothing (never the machine file).
 *
 * THE LINE. A CHOICE lives here — something a person decided and expects to find again on another
 * device (a pin, a theme, how a list is grouped, which tab is where). What depends on the SCREEN
 * stays per device in the browser — pane widths and sizes, terminal zoom, split ratios, a collapsed
 * sidebar, the Nay button's position — because a phone and a desktop must not fight over one value.
 *
 * THE KEYS ARE A CLOSED LIST, AND EACH ONE SAYS WHERE IT LIVES ON A MACHINE (`USER_UI_PREF_REGISTRY`).
 *  - `top`: a key that was ALREADY a top-level field of `preferences.json` before this route existed
 *    (the theme, the language, the chat defaults the Nay launcher reads, the pins, the session
 *    groups the MCP writes…). It STAYS there: moving it would break every server-side reader and
 *    strand every machine's existing value. No data is migrated.
 *  - `ui`: a key that is new to the server, stored under `preferences.json`'s `ui.<key>`.
 * On a CENTRAL every key, whatever its machine home, lives in the account's `userPrefs.ui.<key>`.
 * `user-ui-prefs.test.ts` asserts that every legacy top-level key maps to `top`.
 *
 * VALUES are any JSON value — string, number, boolean, null, array or object — opaque to the server
 * (each one is sanitised by the web store that owns it, because the shapes live in the web bundle).
 * What keeps this from becoming a dump for anything a client sends is the closed key list and a
 * BYTE CAP PER KEY, on top of the route's bound on the whole body.
 */

export type MachineHome = 'top' | 'ui'

interface KeySpec {
  /** Where the key lives in a MACHINE's `preferences.json`. */
  machine: MachineHome
  /** The largest serialised value a PUT may store under this key. */
  maxBytes: number
}

const SMALL = 4 * 1024
const MEDIUM = 32 * 1024
const LARGE = 128 * 1024

/**
 * Every key `/api/user-prefs` accepts. A new personal preference is added here ON PURPOSE, the same
 * way a capability is registered; the web side's `uiPrefs.registry.test.ts` fails when a store
 * names a key that is not listed.
 */
export const USER_UI_PREF_REGISTRY = {
  // ---- legacy top-level keys: already in preferences.json, some read by the server itself ----
  theme: { machine: 'top', maxBytes: SMALL },
  lang: { machine: 'top', maxBytes: SMALL },
  currency: { machine: 'top', maxBytes: SMALL },
  textScale: { machine: 'top', maxBytes: SMALL },
  cardOrder: { machine: 'top', maxBytes: SMALL },
  cardPrecision: { machine: 'top', maxBytes: SMALL },
  monthlyBudgetUSD: { machine: 'top', maxBytes: SMALL },
  chatModel: { machine: 'top', maxBytes: SMALL },
  chatHarness: { machine: 'top', maxBytes: SMALL },
  chatEffort: { machine: 'top', maxBytes: SMALL },
  chatSoundEnabled: { machine: 'top', maxBytes: SMALL },
  chatSoundId: { machine: 'top', maxBytes: SMALL },
  nayMotion: { machine: 'top', maxBytes: SMALL },
  pinnedSessions: { machine: 'top', maxBytes: MEDIUM },
  mutedSessions: { machine: 'top', maxBytes: MEDIUM },
  sessionGroups: { machine: 'top', maxBytes: LARGE },
  idleSessions: { machine: 'top', maxBytes: MEDIUM },
  dismissedHealth: { machine: 'top', maxBytes: MEDIUM },
  notificationSettings: { machine: 'top', maxBytes: SMALL },
  tagsLayout: { machine: 'top', maxBytes: SMALL },
  galleryView: { machine: 'top', maxBytes: SMALL },
  galleryScope: { machine: 'top', maxBytes: SMALL },
  skillFormat: { machine: 'top', maxBytes: SMALL },
  pricingGroupBy: { machine: 'top', maxBytes: SMALL },
  // ---- new keys: under preferences.json `ui.<key>` on a machine ----
  taskBoard: { machine: 'ui', maxBytes: MEDIUM },
  sessionsAside: { machine: 'ui', maxBytes: MEDIUM },
  floatingPanels: { machine: 'ui', maxBytes: LARGE },
  panelSlots: { machine: 'ui', maxBytes: MEDIUM },
  shellBand: { machine: 'ui', maxBytes: SMALL },
  fellDismissed: { machine: 'ui', maxBytes: MEDIUM },
  nayDockTab: { machine: 'ui', maxBytes: SMALL },
  nayDockWindows: { machine: 'ui', maxBytes: MEDIUM },
  editorPreviewMode: { machine: 'ui', maxBytes: SMALL },
  studioTreeSide: { machine: 'ui', maxBytes: SMALL },
  sessionsFiltersOpen: { machine: 'ui', maxBytes: SMALL },
  fleetOpen: { machine: 'ui', maxBytes: SMALL },
  studioSeen: { machine: 'ui', maxBytes: SMALL },
  projectDisk: { machine: 'ui', maxBytes: SMALL },
  centralMachine: { machine: 'ui', maxBytes: SMALL },
  updateSnooze: { machine: 'ui', maxBytes: SMALL },
  whatsNewSeen: { machine: 'ui', maxBytes: SMALL },
  whatsNewAutoOpen: { machine: 'ui', maxBytes: SMALL },
  vaultKinds: { machine: 'ui', maxBytes: SMALL },
} as const satisfies Record<string, KeySpec>

export type UserUiPrefKey = keyof typeof USER_UI_PREF_REGISTRY
export const USER_UI_PREF_KEYS = Object.keys(USER_UI_PREF_REGISTRY) as UserUiPrefKey[]
export type UserUiPrefs = Partial<Record<UserUiPrefKey, unknown>>

export const isUserUiPrefKey = (k: string): k is UserUiPrefKey =>
  Object.prototype.hasOwnProperty.call(USER_UI_PREF_REGISTRY, k)

/** Where `key` lives on a MACHINE. */
export function machineHome(key: UserUiPrefKey): MachineHome {
  return USER_UI_PREF_REGISTRY[key].machine
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A JSON value a client could have sent — `undefined` is the one thing it cannot be. */
const isJsonValue = (v: unknown): boolean =>
  v === null || typeof v === 'string' || typeof v === 'boolean'
  || (typeof v === 'number' && Number.isFinite(v)) || Array.isArray(v) || isPlainObject(v)

const byteLength = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length

const clampTextScale = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1.5, Math.max(0.85, v)) : 1

/**
 * PURE: what a stored PER-ACCOUNT document (`userPrefs.ui`) may be read back as. Total — a document
 * written by a later build yields only the keys this build knows.
 */
export function readUserUiPrefs(stored: unknown): UserUiPrefs {
  if (!isPlainObject(stored)) return {}
  const out: UserUiPrefs = {}
  for (const [k, v] of Object.entries(stored)) {
    if (!isUserUiPrefKey(k) || !isJsonValue(v)) continue
    out[k] = k === 'textScale' ? clampTextScale(v) : v
  }
  return out
}

/**
 * PURE: the personal keys of a MACHINE's preferences document — each read from its own home, so a
 * `top` key is the very field the rest of the server reads and a `ui` key comes from `ui.<key>`.
 */
export function readMachineUiPrefs(prefs: Record<string, unknown>): UserUiPrefs {
  const nested = isPlainObject(prefs.ui) ? prefs.ui : {}
  const out: UserUiPrefs = {}
  for (const key of USER_UI_PREF_KEYS) {
    const v = machineHome(key) === 'top' ? prefs[key] : nested[key]
    if (v !== undefined && isJsonValue(v)) out[key] = v
  }
  return out
}

/**
 * PURE: the shallow merge a PUT makes into a MACHINE's preferences document — `top` keys as fields
 * of their own, `ui` keys merged into the existing `ui` object (never replacing its other keys).
 */
export function machineUiPatch(current: Record<string, unknown>, patch: UserUiPrefs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const nested: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch) as [UserUiPrefKey, unknown][]) {
    if (machineHome(k) === 'top') out[k] = v
    else nested[k] = v
  }
  if (Object.keys(nested).length > 0) {
    out.ui = { ...(isPlainObject(current.ui) ? current.ui : {}), ...nested }
  }
  return out
}

export type UserUiPut =
  | { ok: true; patch: UserUiPrefs }
  | { ok: false; error: 'not_an_object' | 'unknown_key' | 'bad_value' | 'too_large'; key?: string }

/**
 * PURE: validate a PUT. The body is a PATCH by key (`{ taskBoard: {...} }`): each named key is
 * REPLACED whole, keys not named are left alone — two stores writing different keys must not
 * clobber each other, the rule `writePreferences` keeps across preference keys. A key outside the
 * closed list is REFUSED rather than dropped, so a client asking for something this server will
 * not keep finds out instead of believing it was saved; so is a value over its key's byte cap.
 */
export function parseUserUiPut(body: unknown): UserUiPut {
  if (!isPlainObject(body)) return { ok: false, error: 'not_an_object' }
  const patch: UserUiPrefs = {}
  for (const [k, v] of Object.entries(body)) {
    if (!isUserUiPrefKey(k)) return { ok: false, error: 'unknown_key', key: k }
    if (!isJsonValue(v)) return { ok: false, error: 'bad_value', key: k }
    if (k === 'textScale' && (typeof v !== 'number' || !Number.isFinite(v))) {
      return { ok: false, error: 'bad_value', key: k }
    }
    if (byteLength(v) > USER_UI_PREF_REGISTRY[k].maxBytes) return { ok: false, error: 'too_large', key: k }
    patch[k] = k === 'textScale' ? clampTextScale(v) : v
  }
  return { ok: true, patch }
}
