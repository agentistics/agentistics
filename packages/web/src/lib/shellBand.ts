/**
 * shellBand.ts — PURE. The decisions the per-session shell band makes, kept out of the JSX.
 *
 * Three of them, and each is a rule the spec states rather than a preference:
 *
 *  - **The unwatch discipline** (`shellWatching`). The capture loop runs ONLY while the band is
 *    open, the session selected and the document visible. It is the only per-second cost this
 *    feature has — two tmux reads a second per watched pane — and `terminal-web.ts` already records
 *    the rule for the fleet's own channel: "capture is viewer-gated, so a surface that forgets to
 *    unwatch leaves a `capture-pane` loop running for a screen nobody can see."
 *  - **The geometry** (`clampBandHeight`). A drag may not shrink the band below a readable floor
 *    nor let it eat the conversation above it.
 *  - **The refusals** (`shellErrorText`). The route-level errors — the ones `index.ts` answers
 *    BEFORE `shell-web.ts` gets to compose a sentence — carry a CODE and no prose. The band must
 *    still say what happened: a blank pane is the confident-nothing this repo refuses everywhere
 *    else. `shell-web.ts`'s own refusals (`no-tmux`, `no-cwd`, `cwd-missing`, `at-cap`) already
 *    arrive as sentences and are shown verbatim; nothing here re-words them.
 *
 * The band's open/closed state and its height are a per-viewer convenience, so they live in
 * `localStorage` — the CLAUDE.md rule for exactly this kind of state — and every read and write is
 * guarded: a private window, cleared site data or a browser blocking storage makes the accessor
 * itself throw.
 */

// `PanelId`/`PANEL_IDS` only — `panelSlots.ts` imports nothing from this module, so this stays a
// one-way dependency rather than a circular one.
import { PANEL_IDS, type PanelId } from './panelSlots'
import { paneStorageKey, type PaneId } from './paneScope'

/** The smallest band worth drawing: a prompt, a command and a few lines of its output. */
export const BAND_MIN_PX = 140

const STORAGE_KEY = 'agentistics-shell-band'

export interface ShellWatchFacts {
  /** Is the band expanded (or the mobile sheet up)? */
  bandOpen: boolean
  /** Is a session selected, and is this band that session's? */
  sessionSelected: boolean
  /** `document.visibilityState === 'visible'`. */
  documentVisible: boolean
}

export function shellWatching(f: ShellWatchFacts): boolean {
  return f.bandOpen && f.sessionSelected && f.documentVisible
}

/**
 * The dragged height, bounded.
 *
 * The floor is applied LAST so a column too short for it still yields a layable-out box rather
 * than a ceiling below the floor, which a naive `Math.min(max, Math.max(min, h))` produces as a
 * height smaller than the minimum — and a flex child cannot be laid out at a negative one.
 *
 * UX PASS ITEM 7 REMOVED THE OLD CEILING (`viewportHeight * 0.7`, a fixed 70% no drag could ever
 * cross) — reported as a low, arbitrary cap that stopped the band well short of the screen it was
 * asked to fill. The one ceiling left is the CENTRE COLUMN'S OWN measured height (never the whole
 * viewport, which also holds the header and — on the sessions workspace — the left/right asides
 * beside this column, not above or below it): a band cannot cover more than the column it docks
 * inside. Reaching that ceiling is `resolveBandHeight`'s job, not this function's — this one stays
 * the plain clamp the keyboard step and every existing caller already expect.
 */
export function clampBandHeight(px: number, columnHeight: number): number {
  if (!Number.isFinite(px)) return BAND_MIN_PX
  const ceiling = Number.isFinite(columnHeight) && columnHeight > 0 ? columnHeight : Number.POSITIVE_INFINITY
  return Math.max(BAND_MIN_PX, Math.min(px, ceiling))
}

/** How close to the column's own top edge a drag must reach before the band SNAPS to fill it
 *  (design item 7) — close enough that the reader is plainly asking for "all of it", far enough
 *  that an ordinary resize a few pixels short of the ceiling does not snap by accident. */
export const BAND_SNAP_THRESHOLD_PX = 48

/**
 * WHAT A DRAG (or a keyboard step) ASKS FOR, resolved against the measured centre column (design
 * item 7). Two states, and the band is not free to be almost-but-not-quite full:
 *
 *  - within `BAND_SNAP_THRESHOLD_PX` of covering the WHOLE column, it SNAPS there exactly —
 *    `height` reads the column's own height, never a few pixels short of it, and `full` says so.
 *  - anywhere else, it is the ordinary clamp (`clampBandHeight`), and `full` is false.
 *
 * Symmetric by construction: dragging UP from an ordinary height past the threshold snaps to full;
 * dragging DOWN from full (which starts the next drag at the column's own height) crosses back
 * under the threshold on the very same arithmetic and releases it — there is no separate "release"
 * rule to keep in sync with the "snap" one.
 */
export function resolveBandHeight(wantedPx: number, columnHeight: number): { height: number; full: boolean } {
  const clamped = clampBandHeight(wantedPx, columnHeight)
  if (Number.isFinite(columnHeight) && columnHeight > 0 && columnHeight - clamped <= BAND_SNAP_THRESHOLD_PX) {
    return { height: columnHeight, full: true }
  }
  return { height: clamped, full: false }
}

/**
 * HOW FAR PAST THE COLUMN'S OWN TOP a drag must push before the gesture means real, whole-screen
 * full screen rather than a giant band (design: Studio full screen).
 *
 * Reached only once `resolveBandHeight` has ALREADY snapped to `full` — there is nothing left to
 * negotiate for HEIGHT at that point, since the ceiling is the column's own edge, so the next
 * stretch of the same gesture can only be answered "no, further than the column: all of it."
 * Measured on the RAW, unclamped want (`wantedPx`), never on `resolveBandHeight`'s own result,
 * which caps at the column and so can never see how far past it a drag actually reached — the exact
 * gap that let a drag to the very top of the screen read as merely "some giant band" and stop
 * there, one screenshot short of what the reader was plainly asking for.
 *
 * Kept here beside `resolveBandHeight` — not inside `StudioBand`'s own component — so any band that
 * reuses this resize code reads the SAME threshold rather than a forked one, the same rule
 * `BAND_SNAP_THRESHOLD_PX` already follows for the "fill the column" snap one step before this.
 */
export const BAND_FULLSCREEN_OVERSHOOT_PX = 40

/**
 * Does this drag (or keyboard step) want FULL SCREEN — see `BAND_FULLSCREEN_OVERSHOOT_PX`'s own
 * header for why this is measured on `wantedPx` rather than on an already-clamped height.
 *
 * An unmeasured column (`0`, `NaN`) never triggers it — the same "nothing to snap TO" rule
 * `resolveBandHeight` already applies one step earlier, for the identical reason: there is no top
 * edge to have gone past.
 */
export function wantsFullscreen(wantedPx: number, columnHeight: number): boolean {
  return Number.isFinite(columnHeight) && columnHeight > 0
    && wantedPx - columnHeight >= BAND_FULLSCREEN_OVERSHOOT_PX
}

/**
 * ONE CALL FOR THE WHOLE DRAG STEP, AND THE ONE STATE MACHINE BOTH BANDS DRIVE THEIR RESIZE
 * THROUGH — `resolveBandHeight`'s clamped `{height, full}` plus whether this same want ALSO crosses
 * into full screen, bundled so a band's move handler asks once rather than reaching into two
 * functions and risking they disagree about what `wantedPx` was measured against. `height`/`full`
 * never reflect the overshoot itself — they stay exactly what `resolveBandHeight` would have
 * answered alone (clamped at the column, sane) — which is what makes leaving full screen able to
 * fall back to THIS record rather than to the drag's own raw, possibly enormous number: the band was
 * never told to remember the overshoot in the first place.
 *
 * **THE INVARIANT THIS FUNCTION EXISTS TO STATE: `full` and the band's ACTUAL ON-SCREEN HEIGHT MAY
 * NEVER DISAGREE.** They did, for a release — not because this function was wrong (every number it
 * returns was, and is, correct — see `shellBand.test.ts`) but because the CALLER rendered `full` as
 * `flex: '1 1 auto'` on the band's own root, competing for space with the chat pane's OWN `flex: 1`
 * sibling instead of taking an explicit pixel height. Two `flex-grow: 1` items with different
 * `flex-basis` split the column by their CONTENT size, not by "give everything to the one that asked
 * to fill it" — measured on the real layout, a 700px column gave the band 381px and the chat 315px.
 * So a small incremental drag that reached the snap threshold made the band SHRINK on the very frame
 * it was told to fill the column ("aos poucos pra cima e atinjo o topo, ele volta pro meio"), the
 * next drag's own `startH` was read from `renderedHeight` (which correctly said "700", matching the
 * STATE this function had already resolved) while the box on screen was really 381px — so the same
 * finger movement that felt like a small further nudge computed as `startH + delta` against the
 * WRONG starting point and blew straight through `BAND_FULLSCREEN_OVERSHOOT_PX`, and true full
 * screen (a `position: fixed` overlay, immune to the flex competition) rendered correctly for the
 * first time in the whole gesture ("se eu tento redimensionar ele fica fullscreen"). Leaving it
 * (closing the band, which the header row's own click does) re-entered the SAME broken `full`
 * rendering path on the next open, with `heightPrefs` untouched throughout ("clico na barra ele
 * volta pro meio e fica bugado"). The fix is in the CALLER — `SessionPanel.tsx`'s `StudioBand` and
 * this file's own `ShellBand.tsx` now give the root an EXPLICIT height (`Math.max(BAND_MIN_PX,
 * renderedHeight)`, where `renderedHeight` already resolves to the column's own height while `full`)
 * instead of delegating to outer flex distribution, and give ONLY the CONTENT box inside it
 * `flex: '1 1 auto', minHeight: 0` to spend that height on. This function's own numbers were never
 * the bug and needed no change — the invariant lives here, in words, so the next caller of `full`
 * cannot reintroduce the mismatch by reaching for `flex-grow` again.
 *
 * THE SAME RESOLVER SERVES BOTH BANDS. `StudioBand` and `ShellBand` share one `BandPrefs` record
 * (`readBandPrefs`/`writeBandPrefs`, the `agentistics-shell-band` key) and now share this one
 * function for what a drag on either of their handles means — a second, hand-rolled copy in
 * `ShellBand.tsx` is exactly the drift this repository's own CLAUDE.md exists to prevent. Where the
 * two differ is only in WHAT "full screen" does once requested: `StudioBand` owns a `fullscreen`
 * flag (`SessionsPage`'s `studioFullscreen`, a `position: fixed` overlay `Studio.tsx`'s own gear
 * menu can also reach); `ShellBand` has no overlay of its own and instead navigates to the pane's
 * DEDICATED screen (`onOpenFullscreen`) when one is offered — the same escalation, aimed at whichever
 * "full screen" that band actually has.
 */
export function resolveBandDrag(
  wantedPx: number, columnHeight: number,
): { height: number; full: boolean; fullscreen: boolean } {
  return { ...resolveBandHeight(wantedPx, columnHeight), fullscreen: wantsFullscreen(wantedPx, columnHeight) }
}

/** The route-level refusal codes, which carry no sentence of their own. */
const ERROR_TEXT: Record<string, { en: string; pt: string }> = {
  shell_disabled: {
    en: 'The terminal is off on this machine. Turn it on in Settings → Sessions.',
    pt: 'O terminal está desligado nesta máquina. Ligue em Configurações → Sessões.',
  },
  shell_central: {
    en: 'A central aggregates other machines and has no host of its own to open a terminal on.',
    pt: 'Uma central agrega outras máquinas e não tem host próprio para abrir um terminal.',
  },
  no_host: {
    en: 'This server cannot reach its session host right now.',
    pt: 'Este servidor não consegue alcançar o host das sessões agora.',
  },
  unknown_session: {
    en: 'This machine does not manage that session, so there is no directory to open a terminal in.',
    pt: 'Esta máquina não gerencia essa sessão, então não há diretório onde abrir um terminal.',
  },
  network: {
    en: 'The server did not answer.',
    pt: 'O servidor não respondeu.',
  },
}

/**
 * A shell API call, carrying the reader's language.
 *
 * `handleShellRoute` renders each `ShellRefusal` CODE into prose — the deciding module stays
 * language-free — and it reads the language off the query string, answering in English when none is
 * given. Omitting it put "8 terminals are already open. Close one to open another." on a Portuguese
 * dashboard, beside a Portuguese retry button. A refusal that cannot be read is the one kind this
 * feature cannot afford, so the language travels on every call rather than on the ones somebody
 * remembered.
 */
export function shellApiUrl(path: string, lang: 'pt' | 'en'): string {
  return `${path}?lang=${lang}`
}

/** An unknown code is shown VERBATIM — a reason nobody can read still beats a silent failure. */
export function shellErrorText(code: string, lang: 'pt' | 'en'): string {
  const entry = ERROR_TEXT[code]
  return entry ? entry[lang] : code
}

/**
 * How many trailing segments of the directory the band names.
 *
 * Two, because one is ambiguous on a machine full of `src` and `web` folders and three does not fit
 * a band's title row at 390px.
 */
const WHERE_SEGMENTS = 2

/**
 * Where the shell was opened, said in the room a band's title row has.
 *
 * `direction: rtl` is the trick the session list uses to keep a path's tail visible, and it is
 * WRONG here: this string starts with `~`, and rtl moves that marker to the END —
 * `eu/freelas/Pelvis-Institucional/~`, which reads as a directory called `~` inside the project.
 * Verified on screen at 390px before this existed. So the trim is computed, and the leading `…`
 * says out loud that something was cut.
 */
export function shellWhere(cwd: string | undefined): string {
  if (!cwd) return ''
  const short = cwd.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~')
  const segments = short.split('/').filter(Boolean)
  // `~/x` and `/srv/app` are already at the budget; only a genuinely deeper path is cut.
  if (segments.length <= WHERE_SEGMENTS) return short
  return `…/${segments.slice(-WHERE_SEGMENTS).join('/')}`
}

export interface BandPrefs {
  open: boolean
  height: number
  /**
   * SNAPPED TO FILL THE CENTRE COLUMN (design item 7) — persisted the same way `height` already is,
   * so a band left full reopens full. `height` is STILL kept current while a panel's own entry here
   * is true (the measured column height at the moment it was written), which is what lets a reload
   * on a DIFFERENT-sized screen still read as full rather than as an arbitrary tall number — the
   * render path re-derives the actual pixel figure from the live measurement, this flag only says
   * which of the two readings applies.
   *
   * FULL SCREEN IS A PROPERTY OF THE PANEL, NOT OF THE SLOT — found by the agent fixing the band's
   * resize grip: drag one band (say the Studio) to fill the column, then move a DIFFERENT panel
   * (Contents, say) into the SAME bottom slot, and the new occupant read as full too, on the first
   * frame, before anyone had dragged it anywhere. The OLD shape was one flat boolean, shared by
   * `StudioBand`, `SimpleDockedBand` and `ShellBand` alike — whichever panel next reads this record
   * inherits whatever the LAST occupant left behind, because the record never named who it was
   * about. Keyed by `PanelId` instead: each panel reads and writes only its OWN entry
   * (`bandPanelFull`/`withBandPanelFull`, below), so a new occupant starts un-full regardless of
   * what the panel it replaced was doing. `height`/`open`/`target`/`geometry` stay SHARED on
   * purpose — the band's own size and visibility are a property of the BOX a reader keeps
   * reaching for, which is exactly why a band left tall reopens tall for the next panel too; only
   * "is THIS panel covering the whole column" is a fact about the panel and not the box.
   */
  full?: Partial<Record<PanelId, boolean>>
  /**
   * The last geometry each PLACEMENT measured for its terminal, so the next open can state it
   * before the first capture instead of snapping a quarter-second later.
   *
   * It is a memory of THIS browser's box, not a fact about the pane — a pane has one size and the
   * last viewer to ask wins, which is exactly why a shell last read on a phone opens 52 columns
   * wide on a desktop. Absent, stale and unreadable all mean the same thing here: say nothing and
   * let the measurement that lands moments later decide.
   *
   * KEYED BY PLACEMENT, because they are different boxes: the band under the composer is about 13
   * rows and the shell's own screen about 48. Measured on a real layout — one shared number made
   * every arrival on the dedicated screen open at the band's height and jump, which is the same
   * snap this memory exists to remove, from the other side.
   */
  geometry?: Partial<Record<ShellPlacement, PaneGeometry>>
  /**
   * WHICH terminal the band was last showing — the session's CLI pane or its shell.
   *
   * It is a preference and not a route because the band is a place you glance at while reading the
   * conversation beside it; the ROUTE belongs to the dedicated screen, where the target is the
   * whole page and a shared link must open on the right one. Read through `readTarget`, which
   * treats absent and unreadable alike as the shell — what this band has been since phase 2.
   */
  target?: string
}

/**
 * Where a shell is drawn. `docked` is the band under the composer; `dedicated` is its own screen;
 * `aside` is the panel-slots' RIGHT slot (`lib/panelSlots.ts`'s `shell` panel) — no drag handle, no
 * collapsed state (the slot's own close is the way out), but its own geometry key: the aside is a
 * different box from both of the other two, and one shared measurement would snap the pane to
 * whichever box last reported, the exact defect `bandGeometry` exists to avoid.
 */
export type ShellPlacement = 'docked' | 'dedicated' | 'aside'

export interface PaneGeometry { cols: number; rows: number }

/** ABSENT READS AS CLOSED. Nobody acquires an open shell band by having reloaded the page. */
export const DEFAULT_BAND_PREFS: BandPrefs = { open: false, height: 240 }

/** Per PANE of a split view (`paneScope.ts`); the main pane keeps the historical key. */
export function readBandPrefs(storage?: Storage, pane: PaneId = 'main'): BandPrefs {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(paneStorageKey(STORAGE_KEY, pane))
    if (!raw) return DEFAULT_BAND_PREFS
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null) return DEFAULT_BAND_PREFS
    const r = v as Record<string, unknown>
    return {
      open: r.open === true,
      // A height that does not read as one falls back to the DEFAULT, not to the floor: a record
      // half of which could not be read is not a request for the smallest possible band.
      height: typeof r.height === 'number' && Number.isFinite(r.height)
        ? Math.max(BAND_MIN_PX, r.height)
        : DEFAULT_BAND_PREFS.height,
      // OMITTED rather than an empty object, matching `geometry`/`target` below: absent and "no
      // panel is full" read the same way to every caller (`bandPanelFull(prefs, panel)`), so there
      // is no reason for a record that never mentioned it to gain a key it did not have.
      ...(readFullMap(r.full) ? { full: readFullMap(r.full)! } : {}),
      // DROPPED PER PLACEMENT when it does not read as a pair of positive whole numbers. Half a
      // geometry is worse than none — it would be sent, refused, and the reader would never learn
      // why — and one unreadable placement must not cost the other.
      ...(readGeometries(r.geometry) ? { geometry: readGeometries(r.geometry)! } : {}),
      // Kept as the RAW string: `readTarget` is the one place that decides what an unreadable
      // value means, and duplicating that rule here would be a second answer to one question.
      ...(typeof r.target === 'string' ? { target: r.target } : {}),
    }
  } catch {
    return DEFAULT_BAND_PREFS
  }
}

/**
 * MIGRATES AWAY FROM THE OLD SHAPE, NEVER RESURRECTS IT — `full` used to be a flat `boolean`
 * (`BandPrefs.full`'s own header). A record still holding that shape must not throw (it is
 * ordinary, pre-existing data, not corruption) and must not carry the old `true` forward as some
 * panel's own entry either — that boolean named no panel, so applying it to whichever one asks
 * first would just move the exact bug it is being migrated away from one layer down. So a
 * non-object `full` (the old shape, `true` or `false` alike) reads as "nothing stored", silently,
 * and only the NEW object shape is read through — one known panel id at a time, `=== true` only.
 */
function readFullMap(v: unknown): Partial<Record<PanelId, boolean>> | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const out: Partial<Record<PanelId, boolean>> = {}
  for (const panel of PANEL_IDS) {
    if (r[panel] === true) out[panel] = true
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Is THIS panel the one that was put in full screen — never whichever panel left an entry behind
 *  for the slot in general. See `BandPrefs.full`'s own header. */
export function bandPanelFull(prefs: BandPrefs, panel: PanelId): boolean {
  return prefs.full?.[panel] === true
}

/**
 * The read-modify-write for ONE panel's own entry, leaving every other panel's exactly as it was.
 * `value: false` REMOVES the key rather than writing a literal `false` — matching `readBandPrefs`'s
 * own convention that absent and false must read identically to every caller — so a record with no
 * panel full at all round-trips with no `full` key at all, not `{}`.
 */
export function withBandPanelFull(prefs: BandPrefs, panel: PanelId, value: boolean): BandPrefs {
  const next: Partial<Record<PanelId, boolean>> = { ...prefs.full }
  if (value) next[panel] = true
  else delete next[panel]
  const { full: _drop, ...rest } = prefs
  void _drop
  return Object.keys(next).length > 0 ? { ...rest, full: next } : rest
}

/**
 * SEED A FRESHLY-READ RECORD WITH AN EXTERNALLY-OWNED `open` VALUE — the fix for the sibling of the
 * `full` bug above, found by the agent fixing the resize grip: with the band open on the Studio,
 * picking Claude Code or Shell MINIMIZED it instead of switching, needing a second click to both
 * open it and show the tab just picked. `ShellBand` mounts fresh whenever it swaps in for
 * `StudioBand`/`SimpleDockedBand` (they are three different components sharing one bottom slot),
 * and `useState(() => readBandPrefs())` read that shared record's `open` field COLD — a boolean
 * never scoped to which panel it was about, exactly like `full` before `withBandPanelFull` existed
 * — ignoring the `bottomOpen: true` `panelSlots.ts`'s own `openPanel` had JUST written for the very
 * panel now mounting. `openSeed` is `slotLayout.bottomOpen` itself, read ONCE at mount (`StudioBand`
 * takes it as a fully CONTROLLED prop; this band cannot go that far without also rewiring the shell-
 * resolution reducer's OWN mount-time read of the same flag, so it seeds instead — see `ShellBand`'s
 * own `open` prop for the rest of that story). `undefined` means the caller has no such authority
 * (a placement other than `docked`, or a caller that predates this prop) and the stored value is
 * trusted exactly as read.
 */
export function seedBandOpen(prefs: BandPrefs, openSeed: boolean | undefined): BandPrefs {
  return openSeed === undefined ? prefs : { ...prefs, open: openSeed }
}

function readGeometry(v: unknown): PaneGeometry | null {
  if (typeof v !== 'object' || v === null) return null
  const g = v as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
  return ok(g.cols) && ok(g.rows) ? { cols: g.cols, rows: g.rows } : null
}

function readGeometries(v: unknown): Partial<Record<ShellPlacement, PaneGeometry>> | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const out: Partial<Record<ShellPlacement, PaneGeometry>> = {}
  for (const key of ['docked', 'dedicated', 'aside'] as const) {
    const g = readGeometry(r[key])
    if (g) out[key] = g
  }
  return Object.keys(out).length > 0 ? out : null
}

/** What this placement's box measured last time, or `undefined` for "it has never said". */
export function bandGeometry(placement: ShellPlacement, storage?: Storage): PaneGeometry | undefined {
  return readBandPrefs(storage).geometry?.[placement]
}

/**
 * Record the measurement without disturbing the rest of the record.
 *
 * A read-modify-write rather than a field on the band's React state: the emulator reports a
 * geometry on every layout change, and routing that through a `setState` would re-render the whole
 * panel for a number nothing on screen shows.
 */
export function writeBandGeometry(
  placement: ShellPlacement,
  geometry: PaneGeometry,
  storage?: Storage,
): void {
  try {
    const prefs = readBandPrefs(storage)
    writeBandPrefs({ ...prefs, geometry: { ...prefs.geometry, [placement]: geometry } }, storage)
  } catch { /* the memory is a convenience; the band works without it */ }
}

export function writeBandPrefs(prefs: BandPrefs, storage?: Storage, pane: PaneId = 'main'): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(paneStorageKey(STORAGE_KEY, pane), JSON.stringify(prefs))
  } catch { /* a browser blocking site data costs the convenience, never the band */ }
}
