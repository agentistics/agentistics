/**
 * WHERE a search matched — the difference between a list of rows and an answer.
 *
 * The search used to be one lowercased blob per row (`SessionView.searchText`) tested with
 * `.includes()`. That finds the row and then refuses to say why: typing `docker` returned a
 * session whose folder, harness, note and opening prompt were all invisible to the reader, so the
 * only way to learn which of them carried the word was to open the session and look. Worse, the
 * blob is composed differently for the three kinds of row, so the same query searched a different
 * set of things depending on whether a conversation happened to be running.
 *
 * Named fields make the scope a FACT the screen can print, which is what lets the header say how
 * deep the match went and each row say which field earned its place.
 */

/** The searchable dimensions of a session row, in the order a reader scans them. */
export const SEARCH_SCOPES = ['name', 'folder', 'harness', 'note', 'task', 'prompt', 'transcript'] as const

export type SearchScope = typeof SEARCH_SCOPES[number]

/**
 * The text of every scope a row carries ON ITS OWN.
 *
 * `transcript` is deliberately absent: it is not a property of the row but the answer to a
 * question asked of the disk, and putting it here would mean holding conversation text in the
 * view — the exact shape that leaked whole transcripts to a central once already. It reaches
 * `matchScopes` as a boolean the caller resolved.
 */
export interface SearchFields {
  /** What the row is CALLED — the user's label, or the title the harness gave it. */
  name: string
  /** The working directory. */
  folder: string
  harness: string
  /** The user's own note on this row. */
  note: string
  /** The task this row belongs to. */
  task: string
  /** The conversation's opening prompt — what a person remembers about something they closed. */
  prompt: string
}

/** Scopes other than `transcript`, which no row can answer by itself. */
const OWN_SCOPES = SEARCH_SCOPES.filter((s): s is Exclude<SearchScope, 'transcript'> => s !== 'transcript')

export function emptySearchFields(): SearchFields {
  return { name: '', folder: '', harness: '', note: '', task: '', prompt: '' }
}

/**
 * The user-facing, CUMULATIVE search-depth toggles — persisted, several active at once.
 *
 * The PE named three: the title, the opening prompt, and the full transcription. They gate the
 * scopes in `TOGGLE_SCOPES`. The remaining structured scopes (`folder`/`harness`/`note`/`task`) are
 * ALWAYS searched — they are cheap in-memory reads already in the row, and dropping them would
 * silently narrow a search that works today. What the toggles exist for is the one scope worth NOT
 * paying for by default: `transcript` reads the disk, so it is off until the user asks for it.
 */
export const SEARCH_TOGGLES = ['title', 'prompt', 'transcript'] as const
export type SearchToggle = typeof SEARCH_TOGGLES[number]
export type SearchScopeSelection = Record<SearchToggle, boolean>

/** Which `SearchScope`s each toggle turns on. Disjoint, so the three read as three independent depths. */
const TOGGLE_SCOPES: Record<SearchToggle, readonly SearchScope[]> = {
  title: ['name'],
  prompt: ['prompt'],
  transcript: ['transcript'],
}

/** Searched no matter what the toggles say — cheap structured fields, never a disk read. */
const ALWAYS_SCOPES: readonly SearchScope[] = ['folder', 'harness', 'note', 'task']

/**
 * Title and first prompt on, transcription OFF.
 *
 * Transcription is the only scope that reads the disk. Defaulting it off keeps typing responsive on
 * a machine with hundreds of megabytes of transcripts, and turns its cost into an opt-in the user
 * can see — the spec's own rule: a search that hangs the TUI is worse than one that only reads titles.
 */
export const DEFAULT_SCOPE_SELECTION: SearchScopeSelection = { title: true, prompt: true, transcript: false }

/** A stored selection, defaulted field by field — a file missing a key reads as that key's default. */
export function normalizeSelection(x: Partial<SearchScopeSelection> | undefined): SearchScopeSelection {
  return {
    title: x?.title ?? DEFAULT_SCOPE_SELECTION.title,
    prompt: x?.prompt ?? DEFAULT_SCOPE_SELECTION.prompt,
    transcript: x?.transcript ?? DEFAULT_SCOPE_SELECTION.transcript,
  }
}

/** The scopes a selection actually searches — the toggled-on ones, plus the always-on structured set. */
export function activeScopes(sel: SearchScopeSelection): Set<SearchScope> {
  const out = new Set<SearchScope>(ALWAYS_SCOPES)
  for (const t of SEARCH_TOGGLES) if (sel[t]) for (const s of TOGGLE_SCOPES[t]) out.add(s)
  return out
}

/**
 * The CANONICAL persisted shape — the cumulative scope ARRAY, in `SEARCH_SCOPES` order.
 *
 * `Preferences.sessionView.searchScopes` (server, `preferences.ts`) and
 * `SessionViewPrefs.searchScopes` (this package) are BOTH `SearchScope[]`: the server owns the
 * stored format and the tui produces and consumes it, so the two never disagree on the wire. The
 * `SearchScopeSelection` object is only this screen's own on/off convenience — it is converted to
 * the array on the way out (`selectionToScopes`) and back on the way in (`selectionFromScopes`), so
 * nothing downstream ever sees the object. The array is exactly what `activeScopes` searches, which
 * is what keeps the persisted set and the actual search in step.
 */
export function selectionToScopes(sel: SearchScopeSelection): SearchScope[] {
  const set = activeScopes(sel)
  return SEARCH_SCOPES.filter(s => set.has(s))
}

/**
 * Recover the depth toggles from a persisted scope array — the inverse of `selectionToScopes` over
 * the three USER-controlled depths (title→`name`, prompt, transcript).
 *
 * The always-searched structured scopes (folder/harness/note/task) carry no toggle, so they are
 * ignored here exactly as they are in the UI — which is why the toggles round-trip through
 * `selectionToScopes` even though the array also names them. Anything that is NOT an array — absent,
 * or a value written by the pre-array build — reads as the default (title + first prompt on,
 * transcription off), the same robustness the server's `resolveSessionSearchScopes` applies to a
 * hand-edited or newer-binary file.
 */
export function selectionFromScopes(scopes: readonly SearchScope[] | undefined): SearchScopeSelection {
  if (!Array.isArray(scopes)) return { ...DEFAULT_SCOPE_SELECTION }
  const set = new Set<SearchScope>(scopes)
  return { title: set.has('name'), prompt: set.has('prompt'), transcript: set.has('transcript') }
}

/** Whether the deep transcript search should run at all — the one scope worth not paying for. */
export function transcriptScopeOn(sel: SearchScopeSelection): boolean {
  return sel.transcript
}

export type AllState = 'on' | 'mixed' | 'off'

/**
 * The "all" control, DERIVED — on when every toggle is on, off when none is, mixed otherwise.
 *
 * Derived and never stored, so it can never contradict the individual toggles on screen: there is
 * only one source, read two ways. This is the "when every individual is checked, all shows checked"
 * half of the PE's two-way requirement.
 */
export function allState(sel: SearchScopeSelection): AllState {
  const on = SEARCH_TOGGLES.filter(t => sel[t]).length
  return on === SEARCH_TOGGLES.length ? 'on' : on === 0 ? 'off' : 'mixed'
}

/** Toggle one depth on or off. */
export function toggleScope(sel: SearchScopeSelection, t: SearchToggle): SearchScopeSelection {
  return { ...sel, [t]: !sel[t] }
}

/**
 * The other half of the two-way "all": checking it turns every toggle on; from all-on it clears them.
 *
 * Paired with `allState` above, the two are one value read two ways, so "all" and the individuals
 * can never disagree — the PE's requirement, met by construction rather than by keeping them in sync.
 */
export function toggleAllScopes(sel: SearchScopeSelection): SearchScopeSelection {
  const next = allState(sel) !== 'on'
  return { title: next, prompt: next, transcript: next }
}

/**
 * The scopes of one row that carry `query`, in `SEARCH_SCOPES` order.
 *
 * An empty query matches NOTHING rather than everything: the caller decides that an unfiltered
 * list is unfiltered, and a wildcard here would report every row as matching every scope.
 */
export function matchScopes(
  fields: SearchFields,
  query: string,
  found: { transcript?: boolean } = {},
  /**
   * The scopes the search is CURRENTLY looking in. Absent means every scope — the behaviour before
   * depth was selectable, and what the tests without a selection still assert. A scope not in the
   * set is not tested, so a title-only match is invisible while the title toggle is off.
   */
  active?: ReadonlySet<SearchScope>,
): SearchScope[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const on = (scope: SearchScope) => active === undefined || active.has(scope)

  const hit: SearchScope[] = []
  for (const scope of OWN_SCOPES) {
    if (on(scope) && (fields?.[scope] ?? '').toLowerCase().includes(q)) hit.push(scope)
  }
  if (found.transcript && on('transcript')) hit.push('transcript')
  return hit
}

/** Whether a row matches at all — the predicate the list filters on. */
export function matchesQuery(
  fields: SearchFields,
  query: string,
  found: { transcript?: boolean } = {},
  active?: ReadonlySet<SearchScope>,
): boolean {
  return query.trim() === '' || matchScopes(fields, query, found, active).length > 0
}

/** The words the depth line needs, supplied by the caller — this module holds no strings. */
export interface SearchScopeWords {
  scope: Record<SearchScope, string>
  noGrep: string
  noTranscripts: string
  /** How the line names a transcription depth the user has switched OFF. */
  transcriptOff: string
}

/** What the transcript half of the search is currently doing. */
export interface TranscriptState {
  running?: boolean
  runningWord?: string
  unavailable?: 'no-grep' | 'no-transcripts'
  /**
   * The transcription DEPTH is switched off, so no disk read was even attempted.
   *
   * Distinct from `no-transcripts` ("this machine has none") on purpose: one is a choice the user
   * can reverse with a keypress, the other is a fact about the machine, and a line that confused
   * them would send someone to look for a switch that is not the problem.
   */
  off?: boolean
}

/**
 * HOW DEEP the search went, as one line: `name 3 · prompt 5 · transcript 47`.
 *
 * A scope nothing matched is left OUT, because printing seven scopes on every keystroke buries
 * the two that answered the question — EXCEPT `transcript`, which is always stated. That
 * asymmetry is the point: the other six are read from data already in memory and always ran, so
 * their silence means zero. The transcript is read off the disk and might not have run at all, so
 * an absent line would be indistinguishable from "nothing said this" — and the reader would draw
 * the wrong conclusion and stop looking. Same rule as `liveEmptyNotice`, in one line of chrome.
 */
export function searchDepthText(
  counts: ScopeCounts,
  words: SearchScopeWords,
  state: TranscriptState,
): string {
  const parts: string[] = []
  for (const scope of OWN_SCOPES) {
    if (counts[scope] > 0) parts.push(`${words.scope[scope]} ${counts[scope]}`)
  }

  if (state.off) {
    // The depth the user turned off — said, not silently omitted, so the transcript is always
    // accounted for one way or another (the same reason its count is always stated below).
    parts.push(words.transcriptOff)
  } else if (state.unavailable) {
    parts.push(state.unavailable === 'no-grep' ? words.noGrep : words.noTranscripts)
  } else if (state.running) {
    // Not `transcript 0`: the count is simply not in yet, and a zero that turns into 47 a moment
    // later teaches the reader that the number cannot be trusted.
    parts.push(state.runningWord ?? '…')
  } else {
    parts.push(`${words.scope.transcript} ${counts.transcript}`)
  }

  return parts.join(' · ')
}

export type ScopeCounts = Record<SearchScope, number>

export function emptyScopeCounts(): ScopeCounts {
  return { name: 0, folder: 0, harness: 0, note: 0, task: 0, prompt: 0, transcript: 0 }
}

/**
 * How many rows carry the query in each scope — the header's "how deep did this go" line.
 *
 * Every scope is present even at zero: a scope missing from the record and a scope nobody matched
 * read identically to a caller, and the second is a real answer while the first is not.
 */
export function scopeCounts(
  rows: readonly { fields: SearchFields; transcript?: boolean }[],
  query: string,
  active?: ReadonlySet<SearchScope>,
): ScopeCounts {
  const counts = emptyScopeCounts()
  if (query.trim() === '') return counts
  for (const row of rows) {
    for (const scope of matchScopes(row.fields, query, { transcript: row.transcript }, active)) {
      counts[scope]++
    }
  }
  return counts
}
