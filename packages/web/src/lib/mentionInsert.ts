/**
 * mentionInsert.ts — the ONE insertion every "reference this in the conversation" gesture calls.
 *
 * Three gestures produce a reference (§6.1 of the slots-and-references design): dragging a tree row
 * onto the composer, the tree's own "Mencionar na conversa", and "Mencionar seleção" in the Monaco
 * editor. Collapsing them into one function is what keeps them from drifting into three insertion
 * rules that quietly disagree — the same reason `rename-spec.ts` is one table rather than one per
 * caller. The FORMAT is `mentionSpec.ts`'s job; this module is the one thing that happens
 * afterwards: queue it as a draft request (`composerStore.ts`), which already appends rather than
 * replaces and already survives the composer not being mounted yet.
 */

import type { HarnessId } from '@agentistics/core'
import { requestDraft } from './composerStore'
import { mentionFor, type MentionTarget } from './mentionSpec'

export type { MentionTarget } from './mentionSpec'

/**
 * Localized text for the toast shown when a mention landed while the composer was not on screen —
 * see `insertMention`'s `needsSwitch`. Kept here, beside the one function that decides when it is
 * owed, rather than duplicated at each of the three call sites.
 */
export const MENTION_ADDED_TOAST: Record<'pt' | 'en', string> = {
  pt: 'Adicionado à mensagem.',
  en: 'Added to the message.',
}

export interface MentionInsertResult {
  /** The text that was queued — for a caller that wants to log it or test against it. */
  text: string
  /**
   * True when the composer was NOT mounted for this session, so the caller should switch the
   * centre to the conversation and show `MENTION_ADDED_TOAST`. The draft store already holds the
   * request either way — `composerStore.ts`'s whole point is surviving exactly this — so this flag
   * is about the PERSON seeing that something happened, not about whether it will arrive.
   */
  needsSwitch: boolean
}

/**
 * Turn one target into composer text and queue it.
 *
 * `composerMounted` is passed in rather than sensed here: this module holds no UI state, and each
 * of the three call sites already knows the answer for its own tree of components — the composer
 * (drop) always knows it is mounted, the tree menu and the Monaco action do not.
 */
export function insertMention(
  sessionId: string,
  harness: HarnessId | undefined,
  target: MentionTarget,
  composerMounted: boolean,
): MentionInsertResult {
  const text = mentionFor(harness, target)
  requestDraft(sessionId, text)
  return { text, needsSwitch: !composerMounted }
}

// --- gesture 1: composer drop --------------------------------------------------------------------

export interface ComposerDropDeps {
  /**
   * Reads a repo-tree drag payload off a drop, already scoped to the current session (a payload
   * naming another session is the reader's job to refuse, returning `null`). Returns `null` when
   * the drop carries no such payload at all — an ordinary OS file drop, most of the time.
   *
   * INJECTED rather than imported from `lib/repoDrag.ts`: that module (the MIME contract's single
   * definition, `application/x-agentistics-repo-entry`) is owned by a different work package
   * landing in parallel with this one. Wiring the real reader in is a one-line change once it
   * exists — see this package's report.
   */
  readRepoEntry: (dt: DataTransfer) => { path: string } | null
  /** The session's own harness, to pick the mention format via `mentionSpec.ts`. */
  harness: HarnessId | undefined
}

export type ComposerDropOutcome =
  | { handled: true; text: string }
  /** Not a repo-entry drop. The caller's EXISTING file-drop handling must still run — this is not "nothing happened". */
  | { handled: false }

/**
 * Decides whether a drop onto the composer is a repo-tree row, and if so inserts the mention.
 *
 * The composer is mounted by construction here — this IS the composer's own drop handler — so
 * `needsSwitch` never applies and is not surfaced; unlike the tree menu and Monaco gestures, a drop
 * onto the composer can never need to switch the centre to it.
 */
export function handleComposerDrop(
  sessionId: string,
  dt: DataTransfer,
  deps: ComposerDropDeps,
): ComposerDropOutcome {
  const entry = deps.readRepoEntry(dt)
  if (!entry) return { handled: false }
  const { text } = insertMention(sessionId, deps.harness, { path: entry.path }, true)
  return { handled: true, text }
}

// --- gesture 3: Monaco selection ------------------------------------------------------------------

/**
 * The target for "Mencionar seleção" from a Monaco selection's line numbers, or `null` when there
 * is nothing selected — an empty selection means "the cursor is somewhere", not "I selected this
 * line", so the action and the floating chip must both stay absent rather than mention one line
 * nobody chose. `startLine`/`endLine` are taken as given rather than re-derived from a Monaco
 * `Selection` object here, so this stays a pure function over two numbers and a flag — Monaco's own
 * types do not need to reach this module.
 */
export function mentionTargetForSelection(
  path: string,
  startLine: number,
  endLine: number,
  empty: boolean,
): MentionTarget | null {
  if (empty) return null
  return { path, lines: { start: Math.min(startLine, endLine), end: Math.max(startLine, endLine) } }
}
