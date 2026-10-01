/**
 * sharedPref.ts — state that belongs to the WORK, kept where every device can see it.
 *
 * THE PROBLEM THIS EXISTS FOR. The dashboard is one process on one machine, reached over Tailscale
 * from a phone, a tablet and a desktop. Everything it computes is already shared — sessions,
 * metrics, transcripts — but a whole category of state had drifted into `localStorage`, which is
 * per browser and never leaves it. So the same application answered "which sessions am I holding",
 * "which warnings did I dismiss", "what should notify me" differently on each device. Reported as
 * "as coisas se comportam de forma diferente… é literalmente a mesma aplicação".
 *
 * It was never decided; it accumulated. `localStorage` is the shortest path at the moment a store
 * is written, so each one took it. This module is the decision, made once.
 *
 * THE LINE. State about the WORK is shared (pins, dismissals, what notifies me, how I read a list).
 * State about the SCREEN stays local — terminal zoom, pane widths, a collapsed sidebar, a window's
 * position, and the two caches that exist to make the first paint instant. A phone and a 27-inch
 * monitor disagreeing about a pane width is correct; disagreeing about a pinned session is not.
 *
 * TWO RULES, both learned from real defects:
 *
 * 1. THE BROWSER COPY IS THE FIRST PAINT, NEVER THE TRUTH. It decides what is drawn before the
 *    server answers and is corrected a moment later — the pattern `App.tsx` already uses for the
 *    theme and the card order. Waiting for the network to draw a list is a blank frame on every
 *    load; trusting the local copy is three applications again.
 *
 * 2. THE WRITE IS ARMED ONLY BY A SUCCESSFUL LOAD — the rule `a11y-prefs.ts` states for the same
 *    trap. A central answers 401 until login and a machine can still be starting up. Treating that
 *    failure as "the shared value is empty" would let the first change made on one device write its
 *    local state over what every other device holds. Unarmed, a device works from its local copy
 *    and writes nothing: a device that cannot READ the shared value is exactly the one that must
 *    not overwrite it.
 *
 * ONE GET FOR ALL OF THEM. Every store registers here, and `loadSharedPrefs()` reads
 * `/api/user-prefs` ONCE and dispatches. Six stores fetching independently on every refocus is six
 * requests to answer one question. Writes stay per store — the route is a patch by key, so two
 * stores writing different keys cannot clobber each other.
 *
 * LATE REGISTRATION. A store created by a lazily-loaded chunk (e.g. a page that only mounts once
 * navigated to) can come into existence AFTER `loadSharedPrefs()` has already run once — today that
 * only happens again on a `visibilitychange` to visible, so the late store sat on its `fallback`
 * until then. `lastLoaded` keeps the most recent document `loadSharedPrefs()` read, and
 * `createSharedPref` adopts from it immediately on registration, so a store's first answer is never
 * stale just because it was born late.
 *
 * ONE ENDPOINT. `/api/preferences` is the MACHINE's file, and on a central that file is shared by
 * everyone signed in — right for nothing a single person chooses. Every store here reads and writes
 * `PERSONAL_PREFS` (`/api/user-prefs`), which the server resolves per ACCOUNT on a central and to
 * the machine's own file on a machine (`user-ui-prefs.ts`; the a11y rule, generalised). The
 * endpoint is still a per-store option, read once per load and ARMED on its own.
 *
 * EVERY CHOICE IS PERSONAL (2026-10-01). The stores that once went to `/api/preferences` (pins,
 * session groups, notification settings, dismissals, …) now pass `PERSONAL_PREFS` too: on a machine
 * the server keeps each of them at the very same top-level field (`USER_UI_PREF_REGISTRY` in
 * `user-ui-prefs.ts`), so nothing moves on disk; on a central they stop leaking across accounts.
 *
 * READ-ONLY SESSIONS. A central session with no account reads `{}` and may not write; the GET says
 * so with `X-Prefs-Writable: false`. That endpoint then ADOPTS (the defaults are the truth for that
 * session) but stays UNARMED and leaves the browser copy alone, so what this browser held is still
 * there to migrate once somebody signs in.
 *
 * THE ONE-TIME MIGRATION (`adoptLocalWhenAbsent`, or `migrateLocalOnce` for a value held outside a
 * store) runs at most ONCE PER KEY PER BROWSER (`MIGRATED_PREFIX`). Without that bound, a shared
 * browser on a central would copy the first person's arrangement into every next account that
 * signs in there with nothing stored yet.
 */

/** The per-person endpoint — see `packages/server/server/user-ui-prefs.ts` for the closed key list. */
export const PERSONAL_PREFS = '/api/user-prefs'

export interface SharedPrefStore<T> {
  /** The value in force right now — local copy until the load lands, shared value after. */
  get(): T
  /** Change it here and, once armed, everywhere. */
  set(next: T): void
  subscribe(fn: () => void): () => void
  /** Stable reference for `useSyncExternalStore`'s server snapshot (a fresh object each call loops). */
  serverSnapshot(): T
}

interface Registered {
  endpoint: string
  prefKey: string
  adopt: (raw: unknown, writable: boolean) => void
}

const registry: Registered[] = []

/** Marks, per browser, that a key's local copy has been reconciled with the server once. */
export const MIGRATED_PREFIX = 'agentistics-prefs-migrated:'

/** The endpoints that have answered once AND may be written. Absent = unarmed. See rule 2. */
const armed = new Set<string>()

/** Per endpoint, whether its last answer said this session may write (`X-Prefs-Writable`). */
const writableBy = new Map<string, boolean>()

/** The last document each endpoint answered, so a store registered afterwards can adopt it
 *  immediately instead of waiting for the next load. Absent until that endpoint's first success. */
const lastLoaded = new Map<string, Record<string, unknown>>()

/** True once `loadSharedPrefs()` has been asked for at all — a store registering after that on an
 *  endpoint nobody has read yet triggers that endpoint's read itself (see LATE REGISTRATION). */
let loadRequested = false
const inFlight = new Map<string, Promise<void>>()

/** Test seam: the module state is process-wide, so a test that loads must be able to reset it. */
export function resetSharedPrefs(): void {
  armed.clear()
  writableBy.clear()
  lastLoaded.clear()
  inFlight.clear()
  loadRequested = false
  registry.length = 0
}

/**
 * PURE: is this incoming value the same as the one held?
 *
 * Compared structurally, so an equal value that arrives as a different object does NOT notify —
 * a re-render loop is the cost, and every one of these stores feeds `useSyncExternalStore`.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

/** First time this browser reconciles `prefKey`? Marks it reconciled either way. */
function firstReconcile(prefKey: string): boolean {
  const flag = MIGRATED_PREFIX + prefKey
  if (storageGet(flag) !== null) return false
  storageSet(flag, '1')
  return true
}

/**
 * Write personal choices held OUTSIDE a store (App-wide choices like the theme live in React
 * state). A no-op until `/api/user-prefs` has answered and said this session may write — the same
 * rule every store follows, for the same reason.
 */
export function putPersonal(patch: Record<string, unknown>): void {
  if (!armed.has(PERSONAL_PREFS)) return
  void fetch(PERSONAL_PREFS, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => { /* it holds here; the next load reconciles */ })
}

/** Read `/api/user-prefs` (sharing a read already in flight) and answer its document, or `null`. */
export async function loadPersonalPrefs(): Promise<Record<string, unknown> | null> {
  loadRequested = true
  await loadEndpoint(PERSONAL_PREFS)
  return lastLoaded.get(PERSONAL_PREFS) ?? null
}

/**
 * The one-time migration for a value held OUTSIDE a store. When the server has nothing for
 * `prefKey`, this browser holds `local`, the session may write and this browser has never
 * reconciled the key, upload `local` and answer `true` — the caller then keeps it. Otherwise mark
 * the key reconciled (when writable) and answer `false`.
 */
export function migrateLocalOnce(prefKey: string, serverHas: boolean, local: unknown): boolean {
  if (!armed.has(PERSONAL_PREFS)) return false
  if (!firstReconcile(prefKey)) return false
  if (serverHas || local === undefined || local === null) return false
  putPersonal({ [prefKey]: local })
  return true
}

export function createSharedPref<T>(opts: {
  /** The `localStorage` key. Kept for the first paint, and kept COMPATIBLE — an existing key must
   *  go on being read, or every device silently loses what it had on the day this shipped. */
  key: string
  /** The field inside the endpoint's document. */
  prefKey: string
  /** Where the shared value lives. Defaults to `PERSONAL_PREFS` — every store here is a person's
   *  choice. Kept as an option so a test can point a store at its own route. */
  endpoint?: string
  /**
   * When the server has NOTHING for this key yet and this browser does, keep the browser's value
   * and write it up — once, on the first armed load. This is how a store that used to live only in
   * `localStorage` moves to the server without every device losing what it had on the day it
   * shipped. Off by default: for the older stores the server copy has been the truth for a while.
   */
  adoptLocalWhenAbsent?: boolean
  /** What is in force when neither side has anything to say. */
  fallback: T
  /** Total: anything unrecognised yields `null` and the caller keeps what it has. A stored document
   *  can be hand-edited or written by an older build, and a throw here is a blank dashboard. */
  parse: (raw: unknown) => T | null
  /** How the browser copy is written and read when it is not JSON. A key that predates this module
   *  (a `'1'`/`'0'` flag, a bare string) keeps its own format, so the first paint still reads it. */
  encode?: (value: T) => string
  decode?: (raw: string) => unknown
  /** The legacy value when `key` itself holds nothing — for a store whose browser copy used to live
   *  under other keys in another shape. A seeded value counts as held locally (it is what
   *  `adoptLocalWhenAbsent` uploads). */
  seed?: () => T | null
}): SharedPrefStore<T> {
  const { key, prefKey, fallback, parse } = opts
  const endpoint = opts.endpoint ?? PERSONAL_PREFS
  const encode = opts.encode ?? ((v: T) => JSON.stringify(v))
  const decode = opts.decode ?? ((raw: string) => JSON.parse(raw) as unknown)

  let hadLocal = false
  let current: T = (() => {
    try {
      const raw = storageGet(key)
      if (raw === null) {
        const seeded = opts.seed?.() ?? null
        hadLocal = seeded !== null
        return seeded ?? fallback
      }
      const parsed = parse(decode(raw))
      hadLocal = parsed !== null
      return parsed ?? fallback
    } catch {
      return fallback
    }
  })()

  const subscribers = new Set<() => void>()
  const notify = () => { for (const fn of subscribers) fn() }
  const writeLocal = () => storageSet(key, encode(current))

  const put = () => {
    void fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [prefKey]: current }),
    }).catch(() => { /* it holds here; the next load reconciles */ })
  }

  const registered: Registered = {
    endpoint,
    prefKey,
    adopt: (raw: unknown, writable: boolean) => {
      // The first armed answer this BROWSER sees for this key — see THE ONE-TIME MIGRATION.
      const first = writable && opts.adoptLocalWhenAbsent === true && firstReconcile(prefKey)
      if (raw === undefined && first && hadLocal) {
        // The server has never heard of this key and this browser holds a real value: it becomes
        // the shared one. Once per browser — after that the server answers.
        hadLocal = false
        put()
        return
      }
      if (writable) hadLocal = false
      const shared = raw === undefined ? fallback : parse(raw)
      if (shared === null || sameValue(shared, current)) return
      current = shared
      // A read-only session adopts in memory only: its defaults are not this browser's choices,
      // and overwriting them would lose what is waiting to migrate.
      if (writable) writeLocal()
      notify()
    },
  }
  registry.push(registered)

  // A load may already have landed before this store existed (a lazily-loaded chunk registering
  // after the app's first `/api/user-prefs` GET) — adopt it now rather than waiting for the next
  // `loadSharedPrefs()` call, which today only happens again on a `visibilitychange` to visible.
  const loaded = lastLoaded.get(endpoint)
  if (loaded) registered.adopt(loaded[prefKey], writableBy.get(endpoint) ?? false)
  else if (loadRequested) void loadEndpoint(endpoint)

  return {
    get: () => current,
    set: (next: T) => {
      if (sameValue(next, current)) return
      current = next
      writeLocal()
      if (armed.has(endpoint)) put()
      notify()
    },
    subscribe: (fn: () => void) => {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    },
    serverSnapshot: () => current,
  }
}

/** Read ONE endpoint and hand its document to every store registered on it. Shared while in flight. */
function loadEndpoint(endpoint: string): Promise<void> {
  const running = inFlight.get(endpoint)
  if (running) return running
  const run = (async () => {
    try {
      const res = await fetch(endpoint)
      if (!res.ok) return
      const doc = await res.json() as Record<string, unknown>
      const writable = res.headers.get('X-Prefs-Writable') !== 'false'
      if (writable) armed.add(endpoint)
      else armed.delete(endpoint)
      writableBy.set(endpoint, writable)
      lastLoaded.set(endpoint, doc)
      for (const store of registry) if (store.endpoint === endpoint) store.adopt(doc[store.prefKey], writable)
    } catch {
      /* offline, or a central that has not signed us in yet — stay unarmed and local */
    } finally {
      inFlight.delete(endpoint)
    }
  })()
  inFlight.set(endpoint, run)
  return run
}

/**
 * Read the shared values and adopt them. Idempotent; safe on every mount and every refocus.
 *
 * A failure leaves that endpoint unarmed and its stores on their local copy — see rule 2. It
 * deliberately does not report the failure: there is nothing for a person to do about it, and a
 * dashboard that announces "could not reach preferences" on a machine that is merely starting up
 * is noise.
 */
export async function loadSharedPrefs(): Promise<void> {
  loadRequested = true
  const endpoints = new Set<string>([PERSONAL_PREFS, ...registry.map(r => r.endpoint)])
  await Promise.all([...endpoints].map(loadEndpoint))
}

/**
 * A PERSONAL store whose value is a whole JSON OBJECT its module parses itself — the shape every
 * arrangement module already had (`readXPrefs()` parsing one `localStorage` document). The module
 * keeps its parser and swaps `localStorage.getItem(KEY)` for `doc.get()`; the browser copy keeps the
 * same key and the same JSON, and is migrated up once.
 */
export function createPersonalDoc(key: string, prefKey: string): SharedPrefStore<Record<string, unknown> | null> {
  return createSharedPref<Record<string, unknown> | null>({
    key, prefKey, endpoint: PERSONAL_PREFS, adoptLocalWhenAbsent: true, fallback: null,
    parse: raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null),
  })
}
