/**
 * Studio — Agentistics Studio's own root: the tree, the search and a multi-tab Monaco editor, as
 * LAYERS over one panel rather than a split.
 *
 * IT IS A MODE, NOT A TAB, and that is the one thing to understand before changing anything here.
 * It began as one tab among the aside's fourteen, under the aside's own "Contents" header and its
 * tab strip — two rows of chrome above a file tree and a code editor, in a column 440px wide. A
 * tree plus an editor cannot share vertical space with that, so opening the Studio now REPLACES the
 * aside's chrome: `ArtifactsAside` renders this component as a `Layer` at its own root, over the
 * header and the strip, at the full size of the aside. The way back is this component's OWN top
 * edge (`onExit`), which is the only chrome there is here — and it is a required prop rather than an
 * optional one, because an exit that can be forgotten is a reader trapped in a panel.
 *
 * The name is the PRODUCT's, deliberately: Agentistics Studio, the studio of this product. It is
 * not "agent studio", which reads as a studio for building agents and is a different thing. The
 * modules under it keep their repository names (`repoApi`, `repoTreeModel`, `RepoTreeView`,
 * `RepoFileEditor`, …): those describe what they read, which really is a repository.
 *
 * THE TREE STAYS BESIDE THE EDITOR, and that is what `StudioBody` is for. Opening a file used to
 * REPLACE the tree with the editor, so reading one file and looking for the next were two modes you
 * moved between — asked about in those words: "quero tbm que quando um arquivo for aberto tenhamos
 * uma barra aqui redimensionavel e minimizavel que ainda mostra a arvore de arquivos pra eu poder
 * continuar navegando e explorando eles". So a file open on a wide enough panel puts the tree in a
 * column of its own on the left, DRAGGABLE and collapsible, with the editor beside it.
 *
 * IT IS A LAYOUT, NOT A SECOND COMPOSITION. Both panes are the same two `Layer`s that were stacked
 * before; `studioLayout` decides only whether they sit side by side or on top of each other, and
 * every rule below — what stays mounted, what hides and how — is untouched by that choice. A split
 * that built its own panes would be a second place for the mounting rules to be got wrong.
 *
 * `layers` IS STILL THE ANSWER IN TWO CASES, and neither is a fallback for the other. A PHONE has
 * one column: a tree and an editor sharing 390px is two things doing neither job, so there the
 * panes stay stacked and the open-files strip is what moves between them. And a panel too NARROW to
 * hold both minima (`SPLIT_MIN`) degrades the same way rather than shipping a 90px tree beside a
 * 90px editor — the aside is itself draggable, down to 280px, so this is an ordinary Tuesday and
 * not an edge case.
 *
 * The open-files strip stays on screen in every arrangement — a tab you cannot see is a buffer you
 * cannot get back to — and the back control it carries appears only where there IS a back: in the
 * split the tree is already on screen, so the control that answers "get it out of my way" is the
 * collapse toggle on the Studio's own bar, never a control that would empty the editor pane.
 *
 * SWITCHING TABS MAY NEVER DESTROY WHAT WAS TYPED, and that is the one rule this composition
 * exists to keep. `RepoFileEditor` re-reads its file on mount and disposes its Monaco model on
 * unmount, so a composition that mounted only the ACTIVE file would lose three lines of unsaved
 * work to an ordinary click on the tab beside it — a loss far more likely than the conflict the
 * editor's whole save machine is built around, in a feature whose headline promise is that nothing
 * is lost silently. So the editor is kept MOUNTED per open tab (`mountedEditors`), hidden rather
 * than unmounted, which is the cheapest correct answer of the three available: it preserves the
 * text, the dirty flag, the undo history, the scroll position and the cursor, and it needs no
 * change to the editor at all.
 *
 * THE SAME RULE HOLDS ONE LEVEL UP, and it was learned the hard way: the tree and the editor stack
 * are BOTH mounted, one of them hidden (`Layer`). Rendering one OR the other made "back to the
 * tree" — a control that promises to change nothing — destroy the very buffer the paragraph above
 * protects. Caught by running it, not by reading it.
 *
 * AND IT HOLDS A THIRD TIME, ONE LEVEL FURTHER OUT: LEAVING the Studio must not unmount it either.
 * `ArtifactsAside` keeps this component mounted and hidden behind the same `Layer` while the normal
 * aside is showing, so `onExit` is a control that changes what is on screen and nothing else. That
 * is why the exit is a plain callback and never an unmount.
 *
 * It is bounded rather than unbounded: the mounted set is the ACTIVE file plus every file with
 * UNSAVED changes. A clean background tab is unmounted, because re-reading it from the server
 * yields the same bytes and costs one request — there is nothing to lose. So the number of live
 * Monaco instances is "files you have actually edited and not saved", plus one.
 *
 * AUTOSAVE STAYS ON FOR A HIDDEN TAB, and the trade is stated rather than left to be discovered.
 * A background buffer that quietly stopped saving itself under an autosave switch the reader turned
 * ON is the same half-promise this feature refuses everywhere else; the cost is that a CONFLICT
 * raised on a hidden tab opens its question where nobody can see it. Nothing is lost by that — the
 * tab keeps its unsaved dot, the buffer is intact, and the question is there, answerable, the moment
 * the tab is selected again.
 *
 * A LIVE-AGENT BADGE reuses the SAME `turns` feed the Live tab already polls — no new polling loop,
 * per the design spec. The general badge is "the session's most recent live events are still
 * pending"; the STRONGER, file-specific one additionally matches a WRITE among those pending events
 * against the file on screen. It reads `LiveEvent.text`, which is the path, and never `ref`, which
 * is the harness's `tool_use` id: the plan's own draft compared `ref` against the open path, and
 * that badge could never have lit.
 *
 * THE LEVELS ABOVE THIS ONE ASK TOO, and this component is what lets them. Everything above keeps
 * the Studio mounted through gestures INSIDE the panel; the PAGE is what unmounts it — closing the
 * panel, navigating to another session or another screen. So the dirty paths are REPORTED to
 * `lib/unsavedBuffers.ts`, and `SessionsPage`'s `UnsavedChangesGuard` holds each of those drops
 * behind the same question this component asks for one tab, raised for N. Without the report the
 * guard counts nothing and asks nothing, which is the silent loss it exists to prevent.
 *
 * The open files belong to ONE session, and selecting a different session still resets this panel —
 * the tree, the strip and every buffer with it; there is nowhere to keep them. What changed is that
 * the switch is a NAVIGATION, and the navigation is held and asked about before it happens. A
 * STATED LIMIT remains: a switch the router cannot hold (the browser's own Back/Forward, see
 * `lib/unsavedLeave.ts`) still resets without a question.
 */

import { createSharedPref } from '../../lib/sharedPref'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowLeftRight, Check, ChevronDown, ChevronLeft, ChevronRight, FilePlus,
  FolderPlus, Loader, PanelLeftClose, PanelLeftOpen, Plus, Search,
  Undo2, X,
} from 'lucide-react'
import {
  applyChildren, applyError, baseNameOf, canMoveInto, closeTab, destinationPath, flattenVisible,
  isSelfOrDescendant, makeRootNode, markDirty, openTab, parentOf, retargetOpenPaths, retargetPath,
  type OpenTab, type TreeNode,
} from '../../lib/repoTreeModel'
import {
  createRepoEntry, deleteRepoEntry, fetchTree, renameRepoEntry, type RepoLang, type TreeListResult,
} from '../../lib/repoApi'
import { repoFailureText } from '../../lib/repoErrorText'
import { copyText } from '../../lib/clipboard'
import { overlayPadding } from '../../lib/mobileOverlay'
import { liveEvents, type LiveEvent, type LiveTurn } from '../../lib/artifactTabs'
import { clearUnsaved, reportUnsaved } from '../../lib/unsavedBuffers'
import { useStudioSearchRequest } from '../../lib/studioSearchRequest'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useElementWidth } from '../../hooks/useElementWidth'
import { ConfirmModal } from '../../pages/settings/primitives'
import { BetaTag } from '../BetaTag'
import { ResizeGrip } from '../ResizeGrip'
import { FileIcon, fileIconHueOnActiveTab, fileIconId } from './fileIcon'
import { RepoFileEditor } from './RepoFileEditor'
import { RepoSearchView } from './RepoSearchView'
import { RepoTreeView, toggleDirectory, treeViewState, type TreeOps } from './RepoTreeView'
import { RepoNote } from './repoNote'
import { insertMention } from '../../lib/mentionInsert'
import { PanelFixedControls, panelMenuIconFor, type BandOverflowEntry } from './bandControls'
import {
  panelMenuEntries, panelMenuEntriesWithoutMove, type PanelMenuEntryId, type PanelMenuIconId,
} from '../../lib/panelMenu'
import type { OpenPlacement } from '../../lib/panelSlots'
import type { HarnessId } from '@agentistics/core'

export interface StudioProps {
  sessionId: string
  lang: 'pt' | 'en'
  /** The user's own autosave preference; see `Preferences.editorAutosave`. */
  autosave: boolean
  /** The Live tab's own feed, passed in rather than polled again. */
  turns: readonly LiveTurn[]
  /**
   * Leave the Studio and put the normal aside back.
   *
   * REQUIRED, and the whole reason is in the header: this component covers the aside's own header
   * and tab strip, so its top edge is the only chrome a reader has. An optional exit is an exit
   * somebody forgets to pass, and the result is a panel with no way out of it.
   *
   * It may never unmount this component — see the third paragraph of the header. A callback is what
   * makes that possible: the parent flips which layer is SHOWN and keeps both mounted.
   */
  onExit: () => void
  /**
   * The session's own harness — picks the mention FORMAT for both "Mencionar seleção" (Monaco) and
   * "Mencionar na conversa" (the tree's own context menu) via `mentionSpec.ts`. Omitted (or
   * unverified) falls back to the plain, harness-agnostic form — never a guessed `@`.
   */
  harness?: HarnessId
  /**
   * Whether the message composer is on screen for this session RIGHT NOW — see `mentionInsert.ts`'s
   * `insertMention`. This component has no visibility into which centre view (chat/terminal) is
   * showing, so the caller passes it in; omitted defaults to `true` (no forced switch).
   */
  composerMounted?: boolean
  /**
   * Fired after EITHER mention gesture this component owns (the tree's "Mencionar na conversa", and
   * — forwarded from `RepoFileEditor` through `EditorStack` — Monaco's "Mencionar seleção") queues a
   * reference into the draft store. The reference is queued either way; this is only for
   * `needsSwitch`, which tells the caller when to switch the centre to the conversation and show the
   * "Adicionado à mensagem" toast (`MENTION_ADDED_TOAST`, `mentionInsert.ts`).
   */
  onMention?: (result: { text: string; needsSwitch: boolean }) => void
  /**
   * IS THE STUDIO CURRENTLY TRUE FULL SCREEN — the whole viewport, not merely "fills the centre
   * column". Owned by whoever mounts this component (`SessionsPage`), because the box that actually
   * draws the full-screen COVER is a SIBLING of this one, reached a different way depending on the
   * slot (`StudioBand` in `SessionPanel.tsx` at the bottom; `SessionsPage`'s own `rightSlotContent`
   * wrapper on the right, added 2026-09-19) — this component only reads the flag to draw its own
   * fixed button's "current value" and to answer Esc, never to size anything itself.
   */
  fullscreen?: boolean
  /**
   * OFFERED IN EITHER SLOT as of 2026-09-19 (`fullscreenModeFor`'s own `'overlay'` mode in
   * `lib/panelMenu.ts`) — it used to be absent while the Studio sat in the right slot, back when
   * full screen there had nowhere to go; `SessionsPage`'s own right-slot wrapper is that missing
   * piece. Still optional in the type, defensively, though every real caller now provides it.
   */
  onToggleFullscreen?: () => void
  /**
   * WHERE THE STUDIO IS CURRENTLY SHOWN ON SCREEN — `right` or `bottom`. Drives the VISUAL
   * questions only (the minimize icon's own gating below): on a phone `resolveForViewport`
   * (`lib/panelSlots.ts`) folds a `bottom`-placed, bottom-band-active Studio into `right` (there is
   * no bottom band on a phone — the fold is what lets the mobile switcher show it as a full sheet),
   * so `slot` can read `'right'` there even while the panel's own PLACEMENT is genuinely `'bottom'`.
   * That is exactly why the gear's move label is driven by `placement` below and NOT by this prop —
   * see that prop's own header for the bug this split fixes (rail-loose-ends, item 4).
   */
  slot: 'right' | 'bottom'
  /**
   * THE STUDIO'S OWN REAL PLACEMENT (`lib/panelSlots.ts`'s `OpenPlacement` — `'rail'` or
   * `'bottom'`), never folded for a phone's viewport the way `slot` above is. This is what the ONE
   * gear menu's move label is computed from ("Mover Studio para baixo" while placed on the rail,
   * "…para a direita" while placed at the bottom) — `studioGearEntries` used to derive this from
   * `slot` instead (`slot === 'right' ? 'rail' : 'bottom'`), which agrees with the real placement
   * on desktop (there is no fold) but reads backwards on a phone whenever the Studio's real
   * placement is `'bottom'`: `resolveForViewport` had already folded the occupancy to `'right'`,
   * so the derived placement came out `'rail'` and the label read "para baixo" — offering to move
   * it somewhere it already was, and never offering the move that would actually relocate it.
   * Reported live: the mobile gear read "Mover Studio para baixo" while the Studio sat at the
   * bottom already. The VERB was never wrong (`onMove` below always toggles the real placement
   * correctly); only this LABEL was reading the folded value.
   */
  placement: OpenPlacement
  /**
   * Move the Studio to the OTHER slot from wherever `placement` says it is now. Always offered — a
   * panel always has somewhere else to go (`allowed()`, `lib/panelSlots.ts`) — so this is never
   * optional the way `onToggleFullscreen` is.
   */
  onMove: () => void
  /**
   * THE ALWAYS-VISIBLE MINIMIZE ICON, beside the gear — present ONLY while the Studio sits in the
   * RIGHT slot. At the bottom, `StudioBand`'s own collapse chevron already IS this control (see
   * `panelMenu.ts`'s own `panelMinimizeAction`'s `collapse-bottom` case) — a second one here would
   * be the exact "two controls, one meaning" duplication this feature exists to remove. Minimizing
   * PARKS the Studio (`SessionsPage`'s own `studioTarget`, reading `rightOpen`) — its unsaved
   * buffers survive, and it never asks the "discard?" question `onExit`'s own close does.
   */
  onMinimizeRight?: () => void
  /**
   * PIN (narrow-overlay pass, 2026-09-22, spec §11) — present ONLY while `slot === 'right'`, same
   * gating `onMinimizeRight` already follows and for the same reason: the bottom band keeps today's
   * behaviour exactly, and pin is a right-slot-only fact. `SessionsPage`'s own caller passes it
   * conditionally on `rightIsStudio`, mirroring `onMinimizeRight`'s own call site exactly.
   */
  pinned?: { active: boolean; onToggle: () => void }
}

/** Which layer the panel is showing while no file is open. */
type View = 'tree' | 'search'

/**
 * Where an editor should jump on open — set by a CONTENT search hit, which names a line.
 *
 * `seq` is what makes RE-CLICKING THE SAME HIT work: `RepoFileEditor`'s reveal effect depends on the
 * line NUMBER (it has to — the number is what it scrolls to), so a second `{path, line}` object
 * carrying the identical number left that effect's dependency array unchanged and the jump silently
 * did nothing the second time. `seq` is a value that is NEVER the same twice in a row (see
 * `nextGoTo`), so the effect always has something new to depend on even when the destination is the
 * one it just visited.
 */
interface GoTo { path: string; line: number; seq: number }

/**
 * The "new entry" row: what has been typed, whether a request is out, and the last refusal.
 *
 * `parentPath` and `kind` are what let ONE inline row serve every create, not only the toolbar's
 * root-level one: the context menu's "Novo arquivo"/"Nova pasta" on a deep folder set these to that
 * folder and `'file'`/`'dir'`, and `NewFileRow` shows the destination in its own label rather than
 * this panel growing a second create slot positioned at that folder's row — a cheaper, equally
 * honest answer given there is already exactly one place on screen this question is asked from.
 */
interface Creating { parentPath: string; kind: 'file' | 'dir'; name: string; busy: boolean; error: string | null }

/** The row mid-rename: its current text, whether a request is out, and the last refusal. */
interface Renaming { path: string; kind: 'file' | 'dir'; name: string; busy: boolean; error: string | null }

/** The entry pending a delete confirmation. */
interface PendingDelete { path: string; kind: 'file' | 'dir' }

/** The entry the "Mover para…" picker is choosing a destination for. */
interface Moving { path: string; kind: 'file' | 'dir' }

/** One ephemeral, auto-dismissing message — a move's undo offer, or a copy's quiet confirmation. */
interface ToastState { id: number; text: string; action?: { label: string; onClick: () => void } }

// --- the rules, as functions ---------------------------------------------------------------------
//
// Each of these is the part of this component that can be WRONG, so each is a pure function this
// repo can actually test: there is no jsdom and no `@testing-library/react` here (see
// `ConnectionCard.test.tsx`'s own note), so a click is not something a test can perform.

/**
 * WHICH FILES KEEP A LIVE EDITOR — the invariant at the top of this file, as one expression.
 *
 * The active file, plus every file with unsaved changes. Nothing else: a clean buffer holds nothing
 * the server cannot hand back, so unmounting it costs a request and loses nothing, while a dirty one
 * holds text that exists in exactly one place in the world.
 *
 * The order is the STRIP's order, so the editors are mounted in the order their tabs are drawn and a
 * re-render cannot reshuffle them.
 */
export function mountedEditors(tabs: readonly OpenTab[], activePath: string | null): string[] {
  const out = tabs.filter(t => t.dirty || t.path === activePath).map(t => t.path)
  // An active path the strip does not carry cannot happen through any path in this file; it is
  // admitted anyway, because the alternative is an active tab with no editor under it.
  if (activePath !== null && !out.includes(activePath)) out.push(activePath)
  return out
}

/**
 * Closing one tab: what is left, and which file is then on screen.
 *
 * Closing a BACKGROUND tab never moves the reader — the file they are looking at is not the one
 * they closed. Closing the ACTIVE one lands on the tab that slid into its place (the one to its
 * right), and on the last tab when it was the rightmost, which is what every editor does and what
 * keeps a run of closes moving in one direction. An empty strip returns to the tree.
 */
export function closeOutcome(
  tabs: readonly OpenTab[], activePath: string | null, path: string,
): { tabs: OpenTab[]; activePath: string | null } {
  const index = tabs.findIndex(t => t.path === path)
  const rest = closeTab(tabs, path)
  if (activePath !== path) return { tabs: rest, activePath }
  if (rest.length === 0) return { tabs: rest, activePath: null }
  const pick = Math.min(Math.max(index, 0), rest.length - 1)
  return { tabs: rest, activePath: rest[pick]!.path }
}

/**
 * Is the event's path the file on screen?
 *
 * The feed carries whatever path the harness wrote — usually absolute — while a tab is named
 * relative to the session's own folder, so the test is a SEGMENT-aligned suffix. `'/' + open` is
 * what makes it segment-aligned: a bare `endsWith` would match `bar.ts` against `foobar.ts`. A
 * truncated path (the feed caps a line at 160 characters) simply fails to match, which is the right
 * direction to be wrong in — the badge claims nothing rather than claiming the wrong file.
 */
export function sameFile(eventPath: string, openPath: string): boolean {
  return eventPath === openPath || eventPath.endsWith(`/${openPath}`)
}

export interface AgentActivity {
  /** The session's most recent events are still pending — the agent is doing something now. */
  working: boolean
  /** One of those pending events WROTE the file currently on screen. */
  here: boolean
}

/**
 * What the agent is doing, from the feed the Live tab already has.
 *
 * The pending TAIL rather than the single last event: one pending turn can carry several calls, so
 * a write to the open file followed by a shell command would otherwise read as "working, but not
 * here" a moment after it edited the very file being read.
 */
export function agentActivity(events: readonly LiveEvent[], openPath: string | null): AgentActivity {
  let start = events.length
  while (start > 0 && events[start - 1]!.live) start -= 1
  const tail = events.slice(start)
  return {
    working: tail.length > 0,
    here: openPath !== null
      && tail.some(e => e.kind === 'wrote' && sameFile(e.text, openPath)),
  }
}

/**
 * The watermark's opacity, per theme.
 *
 * TWO VALUES, because one does not serve both: the mark is painted in the theme's own text colour,
 * and a near-white line on `#16161f` reads at a strength a near-black line on `#ffffff` does not.
 * Measured against both backgrounds before choosing (see this task's report) — the light theme takes
 * the lower number, since the panel's own text sits on top of it there at full contrast.
 */
export const WATERMARK_OPACITY = { dark: 0.085, light: 0.065 }

export function watermarkOpacity(theme: string | null): number {
  return theme === 'light' ? WATERMARK_OPACITY.light : WATERMARK_OPACITY.dark
}

// --- the split: how wide the tree may be, and whether there is room for it at all ----------------

/**
 * Which arrangement the two panes are in.
 *
 * `split` is the tree in a column of its own beside the editor; `layers` is the two of them stacked
 * with exactly one visible, which is what this panel did everywhere before the split existed and
 * still does on a phone and in a narrow aside.
 */
export type StudioLayout = 'layers' | 'split'

/**
 * Narrower than this and the tree is a column of ellipses: `src/components/sessions/` is already
 * three levels of indent before a name starts, and a name is the only thing a row is for.
 */
export const TREE_MIN = 150

/**
 * What the editor keeps, whatever the tree is dragged to.
 *
 * It is the floor the CLAMP is written against rather than a `min-width` on the pane, because the
 * two are not the same promise: a `min-width` lets the flex row overflow its container, and an
 * overflowing row is the horizontal page scroll this repo checks for at 390px.
 */
export const EDITOR_MIN = 220

/** The grip between the panes. A 1px line is not something a pointer can land on. */
export const DIVIDER_W = 6

/**
 * What the tree opens at.
 *
 * Read against the panel it lives in rather than against a screen: the artifacts aside is 620px by
 * default (`SessionsPage`), so 200 leaves the editor 414 — enough for real code — while still
 * showing a nested path. Only a reader who has never dragged the handle ever sees this number.
 */
export const TREE_DEFAULT = 200

/**
 * An absolute ceiling, so a stored width is bounded even before anything has been measured.
 *
 * The clamp's real ceiling is what the editor can spare, which needs the panel's own width; this is
 * the answer for the first render, where that is not known yet.
 */
export const TREE_MAX = 520

/** Below this the two panes cannot both hold their minimum, so there is no split to offer. */
export const SPLIT_MIN = TREE_MIN + DIVIDER_W + EDITOR_MIN

/**
 * Where the dragged width is remembered.
 *
 * `localStorage`, per DEVICE — a width depends on the SCREEN, and a phone and a desktop must not
 * fight over one value (the line `user-ui-prefs.ts` on the server draws: choices go to
 * `/api/user-prefs`, screen facts stay here). Every read and write is guarded, because a private
 * window makes the accessor itself throw.
 */
export const TREE_WIDTH_KEY = 'agentistics:studio-tree-w'

/**
 * Which arrangement the panel is in.
 *
 * `available` is the MEASURED width of the region the panes share, and `0` means "not measured
 * yet" — the first render, before the ref callback has seen a box. That case answers `split` rather
 * than `layers` because the common desktop panel (620px) holds one comfortably, and guessing the
 * other way flashes a full-width tree for a frame on every single open.
 */
export function studioLayout(
  { isMobile, fileOpen, available }: { isMobile: boolean; fileOpen: boolean; available: number },
): StudioLayout {
  // A phone has one column, and nothing open needs no editor beside anything.
  if (isMobile || !fileOpen) return 'layers'
  if (!Number.isFinite(available) || available <= 0) return 'split'
  return available >= SPLIT_MIN ? 'split' : 'layers'
}

/**
 * The tree's width, held inside its bounds AND inside what the editor can spare.
 *
 * The ceiling MOVES: the aside this sits in is itself draggable, so a width chosen at 900px is
 * reopened at 400px, and a tree that keeps its number there leaves the editor a gutter. Deriving
 * the ceiling from `available` on every render is what makes the narrowing automatic instead of
 * something the reader has to undo by hand.
 */
export function clampTreeWidth(width: number, available?: number): number {
  const room = available !== undefined && Number.isFinite(available) && available > 0
    ? available - DIVIDER_W - EDITOR_MIN
    : TREE_MAX
  const ceiling = Math.max(TREE_MIN, Math.min(TREE_MAX, room))
  const wanted = Number.isFinite(width) ? width : TREE_DEFAULT
  return Math.round(Math.max(TREE_MIN, Math.min(ceiling, wanted)))
}

/** The stored width, with anything unreadable — absent, empty, `NaN`, negative — as the default. */
export function resolveTreeWidth(stored: string | null, available?: number): number {
  const n = Number(stored)
  return clampTreeWidth(stored === null || stored.trim() === '' || !Number.isFinite(n) || n <= 0
    ? TREE_DEFAULT
    : n, available)
}

/** The remembered width. Guarded: a private window throws on the accessor itself, not on the value. */
function readTreeWidth(): number {
  try { return resolveTreeWidth(localStorage.getItem(TREE_WIDTH_KEY)) } catch { return TREE_DEFAULT }
}

/**
 * Remember the width — on the END of a drag and on each keyboard step, never on every pointer move.
 */
function storeTreeWidth(width: number): void {
  try { localStorage.setItem(TREE_WIDTH_KEY, String(width)) } catch { /* private mode */ }
}

/**
 * WHETHER THE TREE IS MINIMIZED, remembered per browser (UX pass item 9).
 *
 * This REVERSES an earlier decision recorded right here: the collapse used to be treated as
 * "momentary" and deliberately left unstored, on the reasoning that a Studio reopening with its
 * tree hidden would look broken. The owner asked for the opposite — a reader who minimizes the
 * tree to read one file wide wants that choice to hold across sessions, not to be silently undone
 * on the next open. `resolveTreeCollapsed` is the pure reading of whatever was stored; anything
 * that is not exactly `'1'` — absent, cleared, junk — reads as NOT collapsed, the same shape every
 * other guarded flag in this file takes when the record cannot be trusted.
 */
export const TREE_COLLAPSED_KEY = 'agentistics:studio-tree-collapsed'

export function resolveTreeCollapsed(stored: string | null): boolean {
  return stored === '1'
}

function readTreeCollapsed(): boolean {
  try { return resolveTreeCollapsed(localStorage.getItem(TREE_COLLAPSED_KEY)) } catch { return false }
}

function storeTreeCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(TREE_COLLAPSED_KEY, collapsed ? '1' : '0') } catch { /* private mode */ }
}

/**
 * Whether a search request (item 8) must force the tree pane back open — fix-wave review, Important
 * #3. The search view is rendered INSIDE the tree pane's own content, so a minimized tree clips it
 * to nothing regardless of why it is minimized (a file open beside it, or none open at all). Pure:
 * the caller decides HOW to expand it (never persisting the reader's own stored preference — see
 * the effect that calls this).
 */
export function searchRequestNeedsExpand(treeCollapsed: boolean): boolean {
  return treeCollapsed
}

/**
 * WHETHER THE READER CAN MINIMIZE THE TREE AT ALL — pure (fix-wave review, Critical #1: "with no
 * file open... there is no collapse toggle, no rail, nothing"). Extracted so the fix can be tested
 * without mounting the whole `Studio` component, which fetches over the network from its first
 * effect.
 *
 * The split obviously qualifies — it is the arrangement the toggle was built for. But `layers` with
 * NOTHING open is not the same `layers` as a phone or a too-narrow panel: there the tree fills the
 * whole region only because it is the only pane there IS, and minimizing it is exactly as
 * meaningful as minimizing it beside an editor — the reader gets their width back either way.
 * Mobile stays excluded outright: `studioLayout` never offers anything but the one-pane phone
 * arrangement there, and a toggle nothing on screen can act on is worse than no toggle.
 */
export function treeCollapsible(isMobile: boolean, split: boolean, fileOpen: boolean): boolean {
  return !isMobile && (split || !fileOpen)
}

/**
 * WHICH PANE IS SHOWN, and the two readings of that question. Pure, for the same reason
 * `treeCollapsible` is.
 *
 * In the SPLIT both panes are on screen and the collapse is the only thing that hides one of them.
 * STACKED WITH A FILE OPEN, it is the open file that decides — which is exactly what it decided
 * before the split existed, so the phone and the too-narrow desktop panel keep the behaviour they
 * have always had. STACKED WITH NOTHING OPEN, the tree is the only pane there is, so `treeCollapsed`
 * reaches in here too — guarded by `collapsible` (the caller's own `treeCollapsible` result), which
 * is what keeps it inert on a phone.
 *
 * `treeCollapsed` survives a layout change on purpose rather than being reset by one: closing the
 * last file drops back to `layers`, where the flag now DOES still say something (on a desktop), and
 * opening the next file should honour the standing "keep it out of my way" instead of quietly
 * undoing it.
 */
export function resolveTreeShown(split: boolean, fileOpen: boolean, treeCollapsed: boolean, collapsible: boolean): boolean {
  return split ? !treeCollapsed : !fileOpen && !(collapsible && treeCollapsed)
}

/**
 * WHICH PANE THE EDITOR SIDE SHOWS — the companion reading to `resolveTreeShown`, pure for the same
 * reason (fix-wave review, Critical #1: "cliquei pra ocultar a arvore e agora simplesmente se tornou
 * inutil o studio... nao aparece nada").
 *
 * STACKED, EXACTLY ONE OF THE TWO PANES IS SHOWN — never neither. The previous reading was `fileOpen`
 * alone, which left a THIRD state unaccounted for: no file open AND the tree minimized (item 9 made
 * that combination reachable — the collapse now survives past the last closed tab). There,
 * `resolveTreeShown` already answers `false`, and `fileOpen` is ALSO `false`, so both panes read
 * "not shown" and `StudioBody` rendered nothing at all — no tree, no editor, and, because the
 * toolbar used to live INSIDE the tree pane's own `Layer`, no way back either (see `Studio`'s own
 * render for the toolbar's hoist, the other half of this fix). `!treeShown` covers exactly that
 * third state: whenever the tree pane has nothing to show, the editor pane is what is left, and its
 * own `mounted.length === 0` empty state (`StudioEditorEmptyState`) is what actually draws something
 * into it. In the SPLIT the editor is unconditionally on screen already (`split` short-circuits),
 * unaffected by any of this — a file is what put the layout into `split` to begin with.
 */
export function resolveEditorShown(split: boolean, treeShown: boolean): boolean {
  return split || !treeShown
}

/**
 * WHICH SIDE THE TREE SITS ON (UX pass item 10 — "move side bar right", VS Code's own phrase for
 * this). `resolveTreeSide` treats anything but the literal `'right'` as `'left'` — the tree's
 * position since before this option existed, and the safer floor for a value a hand edit or an
 * older build left unreadable.
 */
export const TREE_SIDE_KEY = 'agentistics:studio-tree-side'
export type TreeSide = 'left' | 'right'

export function resolveTreeSide(stored: string | null): TreeSide {
  return stored === 'right' ? 'right' : 'left'
}

/** Which side the tree sits on is a CHOICE (unlike its width), so it lives on the server
 *  (`/api/user-prefs`, `studioTreeSide`); the browser copy keeps its bare-string format. */
const treeSideStore = createSharedPref<TreeSide>({
  key: TREE_SIDE_KEY, prefKey: 'studioTreeSide', fallback: 'left', adoptLocalWhenAbsent: true,
  parse: raw => (raw === 'left' || raw === 'right' ? raw : null),
  decode: raw => resolveTreeSide(raw), encode: v => v,
})

function readTreeSide(): TreeSide {
  return treeSideStore.get()
}

function storeTreeSide(side: TreeSide): void {
  treeSideStore.set(side)
}

// --- the toolbar's own fit (owner, 2026-09-19, follow-up) -----------------------------------------

/**
 * WHICH OF THE TOOLBAR'S OPTIONAL ITEMS SURVIVE AT THIS WIDTH — the fix for a bug this very feature
 * introduced: with a file open, the tree column can narrow to `TREE_MIN` (150px), and this row's
 * trailing content (the BETA tag, the fixed trio) was pushed past the column's own edge and CLIPPED
 * by the tree pane's `overflow: hidden` — present in the DOM, invisible, unreachable by mouse. A
 * control the reader cannot click is the dead control this whole feature exists to remove, so a
 * clipped one is a bug in this change, not a pre-existing one to route around.
 *
 * THE RULE, STATED ONCE: **`PanelFixedControls` (full screen, minimize, gear) is NEVER negotiable.**
 * It is reserved first (`FIXED_TRIO_W`) and every other item on this row is added back only if
 * there is still room, most-important-first — the same "give up the least important cell first"
 * shape `fitColumns`/`fitKpis` already use for the TUI's own tables (`packages/tui/src/components/
 * Primitives.tsx`, `packages/tui/src/screens/Overview.tsx`), applied here to a row of BUTTONS
 * instead of a row of DATA. Nothing about this feature's own point (the fixed trio, present and
 * reachable on every open panel) is ever traded away for a search icon or a beta badge.
 *
 * EVERY DROPPABLE ITEM HAS A ROUTE THAT DOES NOT NEED THIS ROW, so dropping it loses convenience,
 * never capability:
 *  - Search — global `Ctrl+Shift+F` / `Cmd+Shift+F` (`useStudioSearchRequest`) opens the exact same
 *    whole-tree content search view from anywhere, key or no key visible here.
 *  - New file / New folder — any row's own "⋯" menu (`RepoTreeView.tsx`'s `handleMenuAction`) offers
 *    both `new-file`/`new-folder`, created beside that row rather than at the root.
 *  - The working dot and the BETA badge are both purely informational (no `onClick`), so hiding them
 *    costs a reader nothing to click through — only something to read.
 *
 * ADDED BACK IN THIS ORDER (most useful first, so the first thing lost as the column narrows is the
 * least useful): the three tree actions, icon-only — Search, then New file, then New folder, since
 * losing all three at once would be the worst reading and Search is asked for most; the working dot;
 * the BETA badge, as its existing `compact` dot; labels on the tree actions, ALL AT ONCE — half the
 * row labelled and half not reads as broken, the same reasoning `PanelBar`'s own `compact` flag
 * already applies uniformly rather than per-tab; the BETA badge's full word, last, because a beta
 * caveat is worth a wider screen but never worth crowding the very controls being fixed here.
 *
 * `width <= 0` (not measured yet) reads as the WIDEST state, the same convention `useElementWidth`'s
 * own header documents for every other caller — a first frame that assumed narrow would flash
 * compact-then-wide on every mount instead of the other way around.
 *
 * THIS IS A STRICT PREFIX, NOT AN INDEPENDENT PER-ITEM CHECK — the first item on the priority list
 * that does not fit STOPS the whole list there, exactly the shape `fitKpis` already uses for its own
 * KPI row (`packages/tui/src/screens/Overview.tsx`) rather than skipping a large item to try a
 * smaller one behind it. That is not only fidelity to the existing convention: a "skip and keep
 * trying" reading is not MONOTONIC in width. A first version of this function tried every item
 * independently, and widening the toolbar by a single pixel could let a higher-priority item start
 * fitting, spend the room a LOWER-priority item was already sitting in, and make that one disappear
 * again — a control flickering in and out as a reader drags the tree wider. A strict prefix cannot:
 * widening the toolbar only ever EXTENDS how far down this list gets, never retracts it (pinned by
 * this file's own `studioToolbarFit — ... monotonic` test).
 *
 * THE COSTS BELOW ARE TAKEN FROM THE REAL RENDERED DOM, NOT GUESSED — and the first version of this
 * function guessed, which is exactly what let the bug this whole feature exists to fix reappear
 * inside its own repair. A live check at 390×844 (mobile) found the trio pushed to `x≈417` on a
 * 390px-wide screen — clipped by an ancestor and unreachable by touch, invisible in a screenshot,
 * exactly the defect item 1 describes, just reached through mobile's full-width row instead of
 * desktop's narrow tree column. The cause: the first version charged one flat, invented width for
 * "a labelled tree-action button" (46px) and one flat gap (6px) for every step alike. Measured off a
 * live `BarButton` (a detached clone, same font/padding/border, both languages): the labelled
 * buttons are 86–125px each — "Novo arquivo" alone is 124px, not 46 — and the row spends TWO
 * different gaps, not one: `Toolbar`'s own row (`gap: 6`) between Search/New file/New folder and the
 * trailing span, and a SEPARATE `gap: 8` inside that trailing span, between the working dot, the
 * BETA tag and `PanelFixedControls` itself. Charging every step the row's 6px hid that the working
 * dot and the BETA tag actually cost 8, and the flat 46px-per-button label estimate was less than a
 * third of what "New file"/"Novo arquivo" actually spends — so the function told the row it could
 * afford full labels at a width the row could not, and the trio was pushed off the end of a
 * container that clips instead of scrolling. Every constant below is now the MEASURED figure (the
 * wider of the English and Portuguese label, rounded up), so the function is wrong only in the safe
 * direction: it may give up an item the real row still had a pixel or two of room for, it must never
 * claim room the real row does not have. See `Studio.test.tsx`'s own
 * `studioToolbarFit — measured against the DOM` block for the values themselves, cross-checked
 * against a live clone of the exact buttons.
 *
 * `width` IS ALREADY NET OF THE ROW'S OWN PADDING — do not reserve it a second time. This is the
 * THIRD thing measurement caught, at the true `TREE_MIN` (150px) itself: a live probe (a debug attr
 * echoing the exact `toolbarWidth` this function receives) read `134`, not `150`, at a tree column
 * whose own `getBoundingClientRect().width` was genuinely `150`. `useElementWidth`'s ref callback
 * measures the FIRST frame with `getBoundingClientRect()` (border box, padding included) but every
 * frame after a resize with `ResizeObserver`'s `contentRect` (content box, padding already
 * subtracted) — the two disagree by exactly this row's own `16px` of horizontal padding, and every
 * width this function is ever asked about in practice has been through at least one resize by the
 * time a reader can act on it. Reserving `STUDIO_TOOLBAR_ROW_PADDING` on top of an already-padding-
 * exclusive number double-spent those 16px and hid `Search` outright at the real `TREE_MIN` — the
 * DOM had room for it (122 needed, 134 available) and the function claimed it did not (138 needed
 * against the same 134, since the padding was subtracted twice). There is nothing to reserve for the
 * row's padding here for exactly that reason: `useElementWidth` already spent it before this
 * function ever sees the number.
 *
 * TWO KINDS OF STEP, not one — this is the second thing the first version got wrong.
 * A step that adds a NEW element (an icon-only tree action, the working dot, the compact BETA dot)
 * pays its own gap on top of its own width — that gap did not exist on the row before it. A step
 * that only WIDENS an element already on the row (labels appearing on the three tree actions, the
 * BETA tag growing from its dot to the word) pays no gap at all — nothing new joined the row, an
 * existing flex item simply grew. Charging every step a gap, as the first version did, overcounted
 * the two upgrade steps and undercounted nothing, which is a safe direction to be wrong in — it is
 * fixed here anyway because it produced a wrong THRESHOLD the labels test below had to special-case.
 */
export interface StudioToolbarFit {
  showSearch: boolean
  showNewFile: boolean
  showNewFolder: boolean
  showWorking: boolean
  beta: 'full' | 'compact' | 'hidden'
  /** All three tree actions gain their visible word together, or none do. */
  treeLabels: boolean
}

/** `PanelFixedControls`' own three 26px buttons (`BAND_CONTROL_H`) plus the two 8px gaps its own
 *  parent flex span uses between them — measured, unchanged from the first version (it was already
 *  right: 94px on a live DOM, exactly `26*3+8*2`). Reserved before anything else on this row is even
 *  considered. THE ROW'S OWN `padding: '6px 8px'` / `'5px 8px'` (8px each side) IS DELIBERATELY NOT
 *  reserved here on top of it — `width` already has it subtracted before this function ever sees it
 *  (`useElementWidth`'s `contentRect`, the block comment above), and reserving it twice hid `Search`
 *  outright at the real `TREE_MIN`. */
const STUDIO_TOOLBAR_FIXED_W = 26 * 3 + 8 * 2
/** One tree-action `BarButton`, icon only. `BarButton` sizes it `22px` on mobile and `20px` on
 *  desktop — this function takes no `isMobile` parameter, so it uses the larger, safe figure for
 *  both; on desktop that undercounts the real room by up to 2px per icon, never overcounts it. */
const STUDIO_TOOLBAR_ICON_BTN_W = 22
/** The row's own `gap` — between Search / New file / New folder and the trailing span. Paid once per
 *  NEW tree-action icon added; see the block comment above on why this differs from the gap below. */
const STUDIO_TOOLBAR_ROW_GAP = 6
/** The trailing span's OWN `gap` (`Toolbar`'s inner `<span style={{ gap: 8, marginLeft: 'auto' }}>`)
 *  — between the working dot, the BETA tag and `PanelFixedControls`. Paid once per NEW item added
 *  inside that span (the working dot, the compact BETA dot); never for the two upgrade-only steps
 *  below, which grow an item already inside it rather than adding one. */
const STUDIO_TOOLBAR_INNER_GAP = 8
const STUDIO_TOOLBAR_WORKING_DOT_W = 7
const STUDIO_TOOLBAR_BETA_COMPACT_W = 5
/** `BetaTag`'s full "BETA" word, measured off a live clone (`8.5px`/`700`/uppercase/its own
 *  border+padding): ≈36.8px, rounded up. The first version guessed a flat +30px delta over the dot;
 *  this is the real word's width, and the delta the function actually spends is computed below. */
const STUDIO_TOOLBAR_BETA_FULL_W = 37
const STUDIO_TOOLBAR_BETA_FULL_DELTA = STUDIO_TOOLBAR_BETA_FULL_W - STUDIO_TOOLBAR_BETA_COMPACT_W
/** Icon → labelled deltas for each of the three tree actions, taken individually rather than as one
 *  flat number — "Search"/"Buscar" (≈87px full width), "New file"/"Novo arquivo" (≈125px — the
 *  longest of the six strings, and the one the first version's flat 46px-per-button guess was least
 *  right about) and "New folder"/"Nova pasta" (≈113px), each measured in BOTH languages and rounded
 *  up to the wider one, each minus the icon-only width above. They are still spent TOGETHER, in one
 *  step — see `treeLabels`'s own doc comment on why the three change as one or not at all — but
 *  charging their real, unequal costs is what makes the total add up to the row's real DOM width
 *  instead of a fraction of it. */
const STUDIO_TOOLBAR_SEARCH_LABEL_DELTA = 65
const STUDIO_TOOLBAR_NEWFILE_LABEL_DELTA = 103
const STUDIO_TOOLBAR_NEWFOLDER_LABEL_DELTA = 91
const STUDIO_TOOLBAR_LABEL_UPGRADE_W =
  STUDIO_TOOLBAR_SEARCH_LABEL_DELTA + STUDIO_TOOLBAR_NEWFILE_LABEL_DELTA + STUDIO_TOOLBAR_NEWFOLDER_LABEL_DELTA

export function studioToolbarFit(width: number): StudioToolbarFit {
  const widest: StudioToolbarFit = {
    showSearch: true, showNewFile: true, showNewFolder: true, showWorking: true,
    beta: 'full', treeLabels: true,
  }
  if (width <= 0) return widest
  const fit: StudioToolbarFit = {
    showSearch: false, showNewFile: false, showNewFolder: false, showWorking: false,
    beta: 'hidden', treeLabels: false,
  }
  let used = STUDIO_TOOLBAR_FIXED_W
  // Each step is either a NEW element (pays its own gap) or an UPGRADE of one already on the row
  // (pays only its width delta) — see the block comment above on why the two must not share one
  // shape. Strict prefix: the first step that does not fit stops every step after it, which is what
  // keeps this monotonic in width (its own test below).
  const steps: ReadonlyArray<{ cost: number; apply: () => void }> = [
    { cost: STUDIO_TOOLBAR_ROW_GAP + STUDIO_TOOLBAR_ICON_BTN_W, apply: () => { fit.showSearch = true } },
    { cost: STUDIO_TOOLBAR_ROW_GAP + STUDIO_TOOLBAR_ICON_BTN_W, apply: () => { fit.showNewFile = true } },
    { cost: STUDIO_TOOLBAR_ROW_GAP + STUDIO_TOOLBAR_ICON_BTN_W, apply: () => { fit.showNewFolder = true } },
    { cost: STUDIO_TOOLBAR_INNER_GAP + STUDIO_TOOLBAR_WORKING_DOT_W, apply: () => { fit.showWorking = true } },
    { cost: STUDIO_TOOLBAR_INNER_GAP + STUDIO_TOOLBAR_BETA_COMPACT_W, apply: () => { fit.beta = 'compact' } },
    { cost: STUDIO_TOOLBAR_LABEL_UPGRADE_W, apply: () => { fit.treeLabels = true } },
    { cost: STUDIO_TOOLBAR_BETA_FULL_DELTA, apply: () => { fit.beta = 'full' } },
  ]
  for (const step of steps) {
    if (used + step.cost > width) break
    used += step.cost
    step.apply()
  }
  return fit
}

// --- the gear menu (§2: replacing the header row) -------------------------------------------------

export type StudioGearItemId = 'tree-toggle' | 'tree-side' | PanelMenuEntryId

export interface StudioGearItem { id: StudioGearItemId; label: string; iconId?: PanelMenuIconId }

/**
 * THE GEAR MENU'S OWN ROWS, AS DATA — what each one SAYS, given the state it is offered in.
 *
 * Split out from the JSX that wires an icon and an `onSelect` to each row so the LABELS — the part
 * a reader actually reads, and the part most likely to drift — are testable without a DOM: this
 * package has none, so a menu built only ever inline inside JSX would leave "does it say the RIGHT
 * thing" untested, the same gap `studioLayout`/`resolveTreeShown` already exist to close for the
 * panes themselves. Each label STATES its current value rather than a bare verb — "Ocultar árvore"
 * / "Mostrar árvore", "Mover árvore para a direita" / "…para a esquerda", "Tela cheia" / "Sair da
 * tela cheia" — because a menu a reader cannot glance at and tell apart from its own opposite is a
 * menu they have to open to find out, every time.
 *
 * ORDER is stable and deliberate: the tree's own two rows first — what this menu REPLACED
 * (`StudioBar`'s former "Ocultar árvore"/"Árvore à direita") stay adjacent to each other, exactly
 * as they were two separate buttons side by side — MOVE next (the panel's own placement, from the
 * ONE shared builder, `lib/panelMenu.ts`), close LAST (the one row whose effect is leaving the
 * panel). FULL SCREEN IS NO LONGER IN THIS LIST (2026-09-19) — it is `PanelFixedControls`' own
 * fixed button now, beside this very menu's trigger; see this file's own render for where it lives.
 *
 * THIS IS NOW THE ONE MENU THE STUDIO CARRIES WHEREVER IT IS (owner, 2026-09-19). It used to have
 * TWO: this one, and `StudioBand`'s own separate "Mais ações" when bottom-docked — two menus that
 * could (and did) disagree about what "move" meant the moment the Studio moved to the right, since
 * only THIS one travels with the component. `StudioBand`'s overflow is gone; its "close" row is
 * the shared builder's own `close` row, merged in here instead.
 *
 * MOVE IS GONE FROM HERE ON DESKTOP ONLY (addendum, 2026-09-21) — it now lives on the Studio's own
 * rail icon / bottom tab right-click menu (`PanelRail`/`PanelBar`'s shared `PanelContextMenu`, both
 * already built generically over every panel including this one), exactly once rather than in two
 * places that could drift the way this gear and `StudioBand`'s old one once did on desktop.
 * `panelMenuEntriesWithoutMove` is the filter that removes it there.
 *
 * ON MOBILE, MOVE STAYS (`mobile: true` keeps `panelMenuEntries`' full list) — spec §8 already
 * states the reason for every OTHER panel's gear ("drag, right-click and the rail's config area are
 * desktop-only; the gear menu covers those verbs there") and this menu is no exception, even though
 * it travels with the Studio rather than living in `rightSlotBar`/`SimpleDockedBand`. There is no
 * rail on a phone to right-click and no `contextmenu` gesture a touch reader can rely on, so
 * stripping move here unconditionally left NO way to move the Studio on mobile at all — reproduced
 * live at 390px: the gear opened with only "Fechar Studio", where "Mover Studio para a
 * direita/baixo" used to be.
 *
 * A row is ABSENT rather than present-and-refusing when it has nothing to act on: `treeCollapsible`
 * (the exact gate `StudioBar` used to read for both tree rows). "Close" has no gate: it is the one
 * row this menu always carries, the reason `onExit` stays a REQUIRED prop on `Studio` itself (see
 * this file's header on why an exit that can be absent is a reader trapped in a panel).
 */
export function studioGearEntries({
  lang, treeCollapsible: canToggleTree, treeCollapsed, treeSide, placement, mobile = false,
}: {
  lang: 'pt' | 'en'
  treeCollapsible: boolean
  treeCollapsed: boolean
  treeSide: TreeSide
  /**
   * THE STUDIO'S OWN REAL PLACEMENT (`lib/panelSlots.ts`'s `OpenPlacement`), never a visual `slot`
   * a phone's viewport fold may have overridden — see `StudioProps.placement`'s own header
   * (rail-loose-ends, item 4) for the bug this parameter, taken directly rather than derived from
   * `slot`, replaced.
   */
  placement: OpenPlacement
  /** Keeps the move row — see this function's own header. Defaults to `false` (desktop) so an
   *  existing caller that has not been updated keeps today's (correct-on-desktop) behavior. */
  mobile?: boolean
}): StudioGearItem[] {
  const pt = lang === 'pt'
  const items: StudioGearItem[] = []
  if (canToggleTree) {
    items.push({
      id: 'tree-toggle',
      label: treeCollapsed ? (pt ? 'Mostrar árvore' : 'Show tree') : (pt ? 'Ocultar árvore' : 'Hide tree'),
    })
    items.push({
      id: 'tree-side',
      label: treeSide === 'left'
        ? (pt ? 'Mover árvore para a direita' : 'Move tree to the right')
        : (pt ? 'Mover árvore para a esquerda' : 'Move tree to the left'),
    })
  }
  const menuInput = { panel: 'studio' as const, placement, lang, panelName: 'Studio' }
  for (const entry of mobile ? panelMenuEntries(menuInput) : panelMenuEntriesWithoutMove(menuInput)) {
    items.push({ id: entry.id, label: entry.label, iconId: entry.iconId })
  }
  return items
}

/**
 * Applying the root's re-read the same way EVERYWHERE it happens: on success, the real listing; on
 * refusal, the tree's own error state carrying the SAME sentence every other failure in this feature
 * shows — never a second wording table and never a stale tree that says nothing about being stale.
 * The session-reset effect and `submitCreate`'s post-create re-read both go through this, so the one
 * path that used to drop the refusal silently now cannot drift from the one that never did.
 */
export function applyRootRefresh(prev: TreeNode, res: TreeListResult, lang: RepoLang): TreeNode {
  return applyDirRefresh(prev, '', res, lang)
}

/**
 * `applyRootRefresh`, generalized to a directory other than the root.
 *
 * A rename, a move or a delete can touch TWO directories at once — a move's old parent and its new
 * one — and each is re-read and applied through this exact function, so a refusal on either one
 * renders through the SAME error state `RepoTreeView` already draws, never a second wording table.
 * It only ever UPDATES a node that is already in the tree: `applyChildren`/`applyError` walk from
 * the root looking for `path` and leave the tree untouched when they do not find it, which is
 * harmless here because every caller only ever refreshes a directory that was already visible — the
 * parent a moved/renamed/deleted entry was filed under, or a destination the picker listed, both of
 * which can only appear in the tree once they have already been read at least once.
 */
export function applyDirRefresh(prev: TreeNode, path: string, res: TreeListResult, lang: RepoLang): TreeNode {
  return res.ok
    ? applyChildren(prev, path, res.children)
    : applyError(prev, path, repoFailureText(res, lang))
}

/**
 * Does ANY open tab under `path` (the entry itself, or something inside it) carry unsaved text?
 *
 * Read BEFORE a delete is confirmed, so the confirmation can say so — deleting a file is not the
 * one place this feature is allowed to drop an edit silently; asking once, with the fact stated, is
 * the same posture `pendingClose`'s own dialog already takes for a single tab.
 */
export function hasDirtyUnder(tabs: readonly OpenTab[], path: string): boolean {
  return tabs.some(t => t.dirty && isSelfOrDescendant(t.path, path))
}

/**
 * Has the session moved on since an async continuation for it was kicked off?
 *
 * `submitCreate` awaits twice — the create itself, then the root re-read — and either can outlive a
 * session switch. Applying a LATE answer would put the old session's file listing onto the new
 * session's tree and open a tab for a path under a root that is no longer on screen. Every
 * continuation checks this before touching any state.
 */
export function sessionMovedOn(startedFor: string, currentSession: string): boolean {
  return startedFor !== currentSession
}

/**
 * The next `goTo` request, and the counter it consumes.
 *
 * The counter (`seq`) is the whole fix for re-clicking the same search hit: `{path, line}` alone can
 * repeat exactly (same file, same line, clicked twice), and `RepoFileEditor`'s reveal effect depends
 * on the line NUMBER, so a repeated object left nothing in its dependency array different and the
 * jump silently did not happen the second time. `seq` always advances, so the effect always has a
 * reason to re-run even when the destination is identical to the one it just visited.
 */
export function nextGoTo(
  counter: number, path: string, line: number | undefined,
): { goTo: GoTo | null; counter: number } {
  if (line === undefined || line <= 0) return { goTo: null, counter }
  const seq = counter + 1
  return { goTo: { path, line, seq }, counter: seq }
}

// --- the component -------------------------------------------------------------------------------

export function Studio({
  sessionId, lang, autosave, turns, onExit, harness, composerMounted = true, onMention,
  fullscreen = false, onToggleFullscreen, slot, placement, onMove, onMinimizeRight, pinned,
}: StudioProps) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const [tree, setTree] = useState<TreeNode>(makeRootNode())
  const [view, setView] = useState<View>('tree')
  /**
   * Ctrl+Shift+F / Cmd+Shift+F (design item 8) switches to the whole-tree content search from
   * ANYWHERE — the global shortcut (App.tsx) and each Monaco instance's own registered command
   * (`RepoFileEditor.tsx`) both reach this ONE mounted Studio through `lib/studioSearchRequest.ts`,
   * since neither of them is anywhere near it in the React tree (the Studio is mounted once per
   * session and portaled into whichever slot shows it). `0` is "no request has ever been made" —
   * the same "absent, not a stale default" shape `artifactsStore.ts`'s own `tabRequest` uses — so
   * the initial render, which always calls this hook, never itself flips the view.
   *
   * The EFFECT that consumes this is declared further down, once `treeCollapsed`'s own setters
   * exist — see it there for why a search request must also touch the tree's collapsed state
   * (fix-wave review, Important #3).
   */
  const searchRequest = useStudioSearchRequest()
  const [tabs, setTabs] = useState<OpenTab[]>([])
  /**
   * REPORT WHAT IS UNSAVED to the page's guard — see the file header. Keyed on this INSTANCE, not on
   * the session: a session switch runs this effect before the reset has emptied `tabs`, and an owner
   * named after the session would briefly file the previous session's dirty paths under the new one.
   * The joined key keeps the effect from re-running on a re-render that changed nothing dirty.
   */
  const unsavedOwner = useId()
  const dirtyKey = tabs.filter(t => t.dirty).map(t => t.path).join('\0')
  useEffect(() => {
    reportUnsaved(unsavedOwner, dirtyKey === '' ? [] : dirtyKey.split('\0'))
  }, [unsavedOwner, dirtyKey])
  // Unmounted, the buffers are gone — there is nothing left for anybody to ask about.
  useEffect(() => () => clearUnsaved(unsavedOwner), [unsavedOwner])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [goTo, setGoTo] = useState<GoTo | null>(null)
  /** The counter behind `goTo.seq` — see `nextGoTo`. */
  const goToCounter = useRef(0)
  /**
   * The session every in-flight async continuation of THIS render was started for, kept current so a
   * late answer can tell it arrived after the reader has already moved on — see `sessionMovedOn`.
   * A ref rather than a dependency of the effect below: it must be readable from `submitCreate`,
   * which is not itself an effect.
   */
  const currentSession = useRef(sessionId)
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const [creating, setCreating] = useState<Creating | null>(null)
  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [moving, setMoving] = useState<Moving | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [treeWidth, setTreeWidth] = useState<number>(readTreeWidth)
  // Persisted per browser (item 9) — see `resolveTreeCollapsed`'s own header for why this reverses
  // an earlier decision recorded there.
  const [treeCollapsed, setTreeCollapsedState] = useState<boolean>(readTreeCollapsed)
  const setTreeCollapsed = useCallback((next: boolean) => {
    setTreeCollapsedState(next)
    storeTreeCollapsed(next)
  }, [])
  // Persisted per browser (item 10 — "move side bar right").
  const [treeSide, setTreeSideState] = useState<TreeSide>(readTreeSide)
  useEffect(() => treeSideStore.subscribe(() => setTreeSideState(treeSideStore.get())), [])
  const setTreeSide = useCallback((next: TreeSide) => {
    setTreeSideState(next)
    storeTreeSide(next)
  }, [])

  /**
   * THE SEARCH REQUEST EFFECT (item 8) — see `searchRequest`'s own comment above for the request
   * itself. A collapsed tree clips the search view to nothing: `RepoSearchView` is rendered INSIDE
   * the tree pane's own content (the `tree` prop passed to `StudioBody` further down), so whenever
   * `treeCollapsed` is holding that pane at zero width — with a file open (the split) or, since item
   * 9, with none open at all — the shortcut flips `view` to `'search'` and nothing visible changes:
   * a search box nobody can see or focus (fix-wave review, Important #3).
   *
   * `setTreeCollapsedState`, deliberately NOT `setTreeCollapsed`: this expands the pane for THIS
   * view only and never touches `localStorage`, so the reader's own "keep it minimized" choice
   * survives — the next explicit minimize, and the next time the Studio opens, both read exactly
   * what they last chose, not what one search happened to need.
   */
  useEffect(() => {
    if (searchRequest === 0) return
    setView('search')
    if (searchRequestNeedsExpand(treeCollapsed)) setTreeCollapsedState(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRequest])

  /**
   * The width of the region the two panes share, MEASURED.
   *
   * It cannot be derived: the aside this sits in is dragged by the reader, the window is resized,
   * and the layout below has to answer "is there room for both" against what is actually there.
   * `0` is "not measured yet", and `studioLayout` states what it does with that.
   *
   * The ref callback measures at ATTACH as well as observing, so the first paint already holds a
   * real number — a `ResizeObserver`'s first callback lands after the frame that mounted the box.
   */
  const [available, setAvailable] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (el === null) return
    setAvailable(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) setAvailable(w)
    })
    ro.observe(el)
    observer.current = ro
  }, [])
  useEffect(() => () => { observer.current?.disconnect() }, [])

  /**
   * The root loads exactly like any other node — through `applyChildren`, and a failure through
   * `applyError`, so the root cannot drift out of the rules the rest of the tree follows and
   * `RepoTreeView` draws the failure with its own sentence rather than this file inventing a second
   * error surface.
   *
   * A SESSION CHANGE RESETS EVERYTHING, strip included: those tabs name files under the previous
   * session's folder, and leaving them would have the editor read a path against the wrong root.
   * Dirty buffers are not dropped here unasked: the switch is a navigation, and `SessionsPage`'s
   * guard held it behind a question before this prop ever changed (see the file header).
   */
  useEffect(() => {
    currentSession.current = sessionId
    let cancelled = false
    setTree(makeRootNode())
    setTabs([])
    setActivePath(null)
    setGoTo(null)
    setPendingClose(null)
    setCreating(null)
    setRenaming(null)
    setPendingDelete(null)
    setMoving(null)
    setToast(null)
    setView('tree')
    void fetchTree(sessionId, '', lang).then(res => {
      if (cancelled) return
      setTree(prev => applyRootRefresh(prev, res, lang))
    })
    return () => { cancelled = true }
    // `lang` is deliberately absent: it changes only the WORDING of a refusal, and re-running this
    // would throw away every open buffer to translate a sentence — the same rule `RepoFileEditor`
    // states over its own read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const openFile = (path: string, line?: number) => {
    setTabs(prev => openTab(prev, path))
    setActivePath(path)
    const next = nextGoTo(goToCounter.current, path, line)
    goToCounter.current = next.counter
    setGoTo(next.goTo)
    // The view underneath is deliberately left ALONE. Opening from a search hit lands on the file
    // (an active path is what decides which layer is shown), and the back control then returns to
    // the results the hit came from — a reader opening the second of twelve matches should not have
    // to type the query again. The search's own back control is the way out to the tree.
  }

  const requestClose = (path: string) => {
    if (tabs.find(t => t.path === path)?.dirty === true) { setPendingClose(path); return }
    doClose(path)
  }

  const doClose = (path: string) => {
    const next = closeOutcome(tabs, activePath, path)
    setTabs(next.tabs)
    setActivePath(next.activePath)
    setPendingClose(null)
  }

  const submitCreate = async (name: string) => {
    if (creating === null) return
    const base = name.trim()
    if (base === '') return
    const { parentPath, kind } = creating
    const path = parentPath === '' ? base : `${parentPath}/${base}`
    const forSession = sessionId
    setCreating({ parentPath, kind, name, busy: true, error: null })
    const out = await createRepoEntry(sessionId, path, kind, lang)
    // The reader may have left this session while the request was out — see `sessionMovedOn`. A late
    // answer from a session nobody is looking at any more touches nothing: not the create row (which
    // the reset effect already put back to `null`), not the tree, and no tab is opened under a root
    // that is no longer on screen.
    if (sessionMovedOn(forSession, currentSession.current)) return
    if (!out.ok) {
      setCreating({ parentPath, kind, name, busy: false, error: repoFailureText(out, lang) })
      return
    }
    setCreating(null)
    // Re-read the PARENT rather than inserting the row here: the real listing is gitignore-aware and
    // sorted by the server, and a second implementation of that is a second thing to disagree with
    // what was actually created.
    const res = await fetchTree(forSession, parentPath, lang)
    if (sessionMovedOn(forSession, currentSession.current)) return
    // The create itself already succeeded, so a new FILE is opened either way — what the re-read
    // decides is whether the TREE shows the fresh listing or a visible refusal. Leaving it silently
    // stale (the old defect) would mean the new file exists on disk and nowhere on screen.
    setTree(prev => applyDirRefresh(prev, parentPath, res, lang))
    if (kind === 'file') openFile(path)
  }

  // --- rename --------------------------------------------------------------------------------------

  const startRename = (path: string, kind: 'file' | 'dir') => {
    setRenaming({ path, kind, name: baseNameOf(path), busy: false, error: null })
  }
  const changeRename = (name: string) => {
    setRenaming(r => (r === null ? r : { ...r, name }))
  }
  const cancelRename = () => setRenaming(null)

  const commitRename = async () => {
    if (renaming === null) return
    const fromPath = renaming.path
    const newBase = renaming.name.trim()
    // Nothing typed, or the SAME name back — a no-op rather than an `already-exists` round trip.
    if (newBase === '' || newBase === baseNameOf(fromPath)) { setRenaming(null); return }
    const dir = parentOf(fromPath)
    const toPath = dir === '' ? newBase : `${dir}/${newBase}`
    const forSession = sessionId
    setRenaming({ ...renaming, busy: true, error: null })
    const out = await renameRepoEntry(forSession, fromPath, toPath, lang)
    if (sessionMovedOn(forSession, currentSession.current)) return
    if (!out.ok) {
      setRenaming({ ...renaming, busy: false, error: repoFailureText(out, lang) })
      return
    }
    setRenaming(null)
    retarget(fromPath, toPath)
    await refreshDirs([dir])
  }

  // --- delete --------------------------------------------------------------------------------------

  const requestDelete = (path: string, kind: 'file' | 'dir') => setPendingDelete({ path, kind })
  const cancelDelete = () => setPendingDelete(null)

  const confirmDelete = async () => {
    if (pendingDelete === null) return
    const { path, kind } = pendingDelete
    setPendingDelete(null)
    const forSession = sessionId
    const out = await deleteRepoEntry(forSession, path, kind === 'dir', lang)
    if (sessionMovedOn(forSession, currentSession.current)) return
    if (!out.ok) { showToast(repoFailureText(out, lang)); return }
    // Every open tab the deleted entry was carrying — itself, or anything under it — is gone on
    // disk, so it closes here too: a dirty one has already been warned about in the confirm dialog's
    // own message (see `hasDirtyUnder`), not asked about a second time.
    setTabs(prev => prev.filter(t => !isSelfOrDescendant(t.path, path)))
    setActivePath(prev => (prev !== null && isSelfOrDescendant(prev, path) ? null : prev))
    await refreshDirs([parentOf(path)])
  }

  // --- move (drag, or the "Mover para…" picker) -----------------------------------------------------

  const openMovePicker = (path: string, kind: 'file' | 'dir') => setMoving({ path, kind })
  const closeMovePicker = () => setMoving(null)

  /** One rename under the hood, shared by a drag-drop and the picker's own "Mover aqui". */
  const performMove = async (itemPath: string, itemKind: 'file' | 'dir', targetDir: string) => {
    if (!canMoveInto(itemPath, targetDir)) return
    const fromPath = itemPath
    const toPath = destinationPath(itemPath, targetDir)
    const forSession = sessionId
    const out = await renameRepoEntry(forSession, fromPath, toPath, lang)
    if (sessionMovedOn(forSession, currentSession.current)) return
    if (!out.ok) { showToast(repoFailureText(out, lang)); return }
    retarget(fromPath, toPath)
    await refreshDirs([parentOf(fromPath), targetDir])
    const destLabel = toPath.slice(0, toPath.length - baseNameOf(toPath).length)
    showToast(
      pt ? `Movido para ${destLabel === '' ? '/' : destLabel}` : `Moved to ${destLabel === '' ? '/' : destLabel}`,
      { label: pt ? 'Desfazer' : 'Undo', onClick: () => { void undoMove(fromPath, toPath, itemKind) } },
    )
  }

  const undoMove = async (originalPath: string, currentPath: string, kind: 'file' | 'dir') => {
    const forSession = sessionId
    const out = await renameRepoEntry(forSession, currentPath, originalPath, lang)
    if (sessionMovedOn(forSession, currentSession.current)) return
    if (!out.ok) {
      showToast(pt ? `Não foi possível desfazer: ${repoFailureText(out, lang)}` : `Could not undo: ${repoFailureText(out, lang)}`)
      return
    }
    retarget(currentPath, originalPath)
    await refreshDirs([parentOf(currentPath), parentOf(originalPath)])
    void kind // kept for symmetry with performMove's signature; nothing here reads it
  }

  // --- copy ------------------------------------------------------------------------------------------

  const copyRelativePath = (path: string) => {
    void copyText(path).then(ok => {
      showToast(ok ? (pt ? 'Caminho copiado' : 'Path copied') : (pt ? 'Não foi possível copiar' : 'Could not copy'))
    })
  }
  const copyPath = (path: string) => {
    // No absolute filesystem path reaches this panel (the server never exposes the session's real
    // directory to the client — see `repoApi.ts`'s own header), so this is the same relative path
    // in a form meant to be pasted somewhere that reads a LITERAL relative reference (a shell, an
    // import statement) rather than the bare name this product's own tree already shows.
    void copyText(`./${path}`).then(ok => {
      showToast(ok ? (pt ? 'Caminho copiado' : 'Path copied') : (pt ? 'Não foi possível copiar' : 'Could not copy'))
    })
  }

  // --- the tree-operations toast ----------------------------------------------------------------------

  const toastSeq = useRef(0)
  const showToast = (text: string, action?: { label: string; onClick: () => void }) => {
    const id = ++toastSeq.current
    setToast({ id, text, action })
    setTimeout(() => setToast(t => (t?.id === id ? null : t)), action !== undefined ? 6000 : 2500)
  }

  // --- refreshing exactly the directories a tree operation could have changed ------------------------

  const refreshDirs = async (dirs: readonly string[]) => {
    const forSession = sessionId
    for (const dir of new Set(dirs)) {
      const res = await fetchTree(forSession, dir, lang)
      if (sessionMovedOn(forSession, currentSession.current)) return
      setTree(prev => applyDirRefresh(prev, dir, res, lang))
    }
  }

  /** Re-key the open tabs and the active path the same way the entry on disk was just re-keyed. */
  const retarget = (from: string, to: string) => {
    setTabs(prev => retargetOpenPaths(prev, from, to))
    setActivePath(prev => (prev === null ? null : retargetPath(prev, from, to) ?? prev))
  }

  const agent = agentActivity(liveEvents(turns), activePath)
  const mounted = mountedEditors(tabs, activePath)
  const rootLoading = treeViewState(tree) === 'loading'

  const fileOpen = activePath !== null
  const layout = studioLayout({ isMobile, fileOpen, available })
  const split = layout === 'split'
  const collapsible = treeCollapsible(isMobile, split, fileOpen)
  const shownTreeWidth = clampTreeWidth(treeWidth, available)
  const treeShown = resolveTreeShown(split, fileOpen, treeCollapsed, collapsible)
  // See `resolveEditorShown`'s own header for the third state this closes.
  const editorShown = resolveEditorShown(split, treeShown)
  const resize = (want: number) => setTreeWidth(clampTreeWidth(want, available))
  const commit = (want: number) => {
    const w = clampTreeWidth(want, available)
    setTreeWidth(w)
    storeTreeWidth(w)
  }
  /**
   * OPEN SEARCH / OPEN CREATE — shared by both the mobile and the desktop toolbar (see the render
   * below for why there are two call sites). Both views they open live INSIDE the tree pane's own
   * content, so either one must also un-collapse the tree exactly as the global search shortcut
   * already does (`searchRequestNeedsExpand`, above) — a "New file" pressed from the ALWAYS-VISIBLE
   * desktop toolbar while the tree is minimized must not open a row nobody can see.
   */
  const openSearch = () => {
    setView('search')
    if (searchRequestNeedsExpand(treeCollapsed)) setTreeCollapsedState(false)
  }
  const openCreate = (kind: 'file' | 'dir') => {
    setView('tree')
    setCreating({ parentPath: '', kind, name: '', busy: false, error: null })
    if (searchRequestNeedsExpand(treeCollapsed)) setTreeCollapsedState(false)
  }

  /**
   * ESC LEAVES FULL SCREEN — unless the editor has focus, where Escape already belongs to Monaco
   * (closing a suggestion widget, clearing a multi-cursor selection, …) and stealing it would break
   * typing in the one place a keystroke matters most. `.monaco-editor` is Monaco's own root class on
   * every instance it creates, so this reads whichever of `EditorStack`'s several mounted editors
   * currently holds focus without reaching into any one editor's own JS handle.
   */
  useEffect(() => {
    if (!fullscreen || !onToggleFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (active instanceof Element && active.closest('.monaco-editor')) return
      onToggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, onToggleFullscreen])

  /**
   * THE GEAR MENU (§2 — replacing the header row; §3, 2026-09-19: now the Studio's ONE menu in
   * either slot — see `studioGearEntries`'s own header). `studioGearEntries` decides WHAT is
   * offered and what each row SAYS; this only wires an icon and an action to each id, and only for
   * the ids that come back — a row this function did not return is a row with nothing to act on,
   * never a disabled one.
   */
  const gearIds = studioGearEntries({
    lang, treeCollapsible: collapsible, treeCollapsed, treeSide, placement, mobile: isMobile,
  })
  const gearAction: Record<StudioGearItemId, { icon: ReactNode; onSelect: () => void }> = {
    'tree-toggle': {
      icon: treeCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />,
      onSelect: () => setTreeCollapsed(!treeCollapsed),
    },
    'tree-side': {
      icon: <ArrowLeftRight size={14} />,
      onSelect: () => setTreeSide(treeSide === 'left' ? 'right' : 'left'),
    },
    // MOVE — both directions call the SAME `onMove`, since `slot` already decides which single one
    // of the two rows the builder actually returned; `panelMenuIconFor` is the one place either
    // icon is resolved, the ARROW convention `panelMenu.ts`'s own header states.
    'move-right': { icon: panelMenuIconFor('arrow-right'), onSelect: onMove },
    'move-bottom': { icon: panelMenuIconFor('arrow-down'), onSelect: onMove },
    close: { icon: panelMenuIconFor('x'), onSelect: onExit },
  }
  const gearEntries: BandOverflowEntry[] = gearIds.map(item => ({
    id: item.id, label: item.label, ...gearAction[item.id],
  }))
  /**
   * THE FIXED TRIO (owner, 2026-09-19: "botões que ficaram fixos... tela cheia, minimizar... a
   * engrenagem sera responsavel pelas configurações") — `bandControls.tsx`'s own
   * `PanelFixedControls`, the SAME cluster every other panel's own bar now renders, IN THE SAME
   * ORDER: full screen, minimize, gear. Full screen is OFFERED IN EITHER SLOT as of this pass
   * (`onToggleFullscreen` is no longer bottom-only — see `SessionsPage`'s own call site); minimize
   * is present ONLY in the right slot — at the bottom, `StudioBand`'s own collapse chevron (drawn a
   * few pixels above this toolbar, in the SAME band) already is this exact control
   * (`panelMenu.ts`'s own `panelMinimizeAction`'s `collapse-bottom` case), so a second one here
   * would be the very duplication this whole feature exists to remove.
   */
  /**
   * THE TOOLBAR'S OWN MEASURED WIDTH (owner, 2026-09-19, follow-up: "the trio... unreachable by
   * mouse" once a file narrows the tree). `studioToolbarFit` decides what survives; this is the
   * ONE measurement both the toolbar's own tree actions AND the trailing BETA badge read, so the
   * two can never disagree about how much room there actually is — see `Toolbar`'s own doc comment
   * on why the fit is computed here rather than inside either of them.
   */
  const [toolbarRef, toolbarWidth] = useElementWidth()
  const toolbarFit = studioToolbarFit(toolbarWidth)

  const fixedControls = (
    <PanelFixedControls
      lang={lang}
      panelName="Studio"
      {...(onToggleFullscreen
        ? { fullscreen: { active: fullscreen, onToggle: onToggleFullscreen } }
        : {})}
      {...(slot === 'right' && onMinimizeRight
        ? {
          onMinimize: onMinimizeRight,
          minimizeLabel: pt ? 'Minimizar o Studio' : 'Minimize the Studio',
        }
        : {})}
      // PIN = FLOAT (`lib/floatingPanels.ts`) — offered in any slot and on the floating window
      // itself (where it docks back); the caller omits it on a phone.
      {...(pinned ? { pinned } : {})}
      gearLabel={pt ? 'Opções do Studio' : 'Studio options'}
      gearEntries={gearEntries}
      isMobile={isMobile}
    />
  )

  return (
    <div style={{
      flex: 1, minHeight: 0, minWidth: 0, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
    }}>
      {tabs.length > 0 && (
        <TabStrip
          tabs={tabs}
          activePath={activePath}
          agentHere={agent.here}
          isMobile={isMobile}
          lang={lang}
          onSelect={setActivePath}
          onClose={requestClose}
          {...(!split && activePath !== null ? { onBack: () => setActivePath(null) } : {})}
        />
      )}

      {/*
        THE TWO LAYERS ARE BOTH MOUNTED, AND THE LAYOUT ONLY DECIDES WHERE THEY SIT. Swapping them
        instead — rendering the tree OR the stack — was written first, and the live run caught what
        it costs: pressing "back to the tree" over an unsaved file unmounted the whole stack, so the
        buffer `mountedEditors` exists to protect was destroyed by the one control that promises to
        change nothing. Measured on a real session: `tsconfig.json` came back re-read from disk with
        the typed characters gone, while the strip still showed its unsaved dot. The hiding rule is
        therefore the SAME one the stack applies to its own inactive editors, one level up — and the
        split changes none of it, because `StudioBody` moves the boxes and never the `Layer`s.

        It buys a second thing: the tree keeps its expanded folders AND its scroll position across a
        visit to a file, and a search keeps its query and its results — so a collapse, or a back
        control where there is one, returns you to what you were actually looking at.
      */}
      {/*
        THE TOOLBAR IS HOISTED OUT OF THE TREE PANE ON DESKTOP (fix-wave review, Critical #1 and its
        sibling layout report — "tudo empilhado em cima da tree, deveriam ficar a direita"). It used
        to be rendered as part of the tree pane's own content (`view === 'tree'`, inside the `tree`
        prop below), which is exactly what its own header comment already called it — "Studio's own
        header ROW" — while its ACTUAL position made it neither: mounted inside a `Layer` that goes
        `inert` the moment the tree is minimized (so the gear carrying "Mostrar árvore" vanished with
        the very pane it is supposed to bring back — the dead panel), and in the SPLIT confined to
        the narrow tree COLUMN rather than the row spanning the whole Studio, so its trailing content
        (the BETA tag, `fixedControls`) sat pinned to the right edge of a 150–500px sliver instead of
        the panel's own right edge every other panel in this workspace uses.

        Rendering it here, a sibling of `StudioBody` rather than a child of one of its panes, fixes
        both at once: it is never inside a `Layer`, so it is on screen (and `fixedControls`' gear is
        reachable) in EVERY arrangement including the one that used to be dead, and it is measured
        against the FULL Studio width (`toolbarRef`/`toolbarWidth`), not the tree column's — so
        `studioToolbarFit` needs no change at all, only a wider real-world input.

        `onSearch`/`onNew` still target content that lives INSIDE the tree pane (the search view, the
        new-file row), so they go through `openSearch`/`openCreate` above rather than the bare
        setters this used to call directly — either one un-collapses the tree first, exactly as the
        global search shortcut already does, or a press from this now-always-reachable row would ask
        for a view nothing on screen shows.

        MOBILE IS DELIBERATELY UNTOUCHED — see the second `<Toolbar>` further down, inside the tree
        pane's own content, gated on `isMobile` and otherwise byte-for-byte what this used to be. On
        mobile `treeCollapsible` is always false (see that function's own header), so the dead state
        this fixes cannot occur there, and this file stays scoped to the desktop half of a bug report
        that explicitly asked for that scope.
      */}
      {!isMobile && (
        <Toolbar
          working={agent.working}
          isMobile={false}
          lang={lang}
          onSearch={openSearch}
          onNew={openCreate}
          fit={toolbarFit}
          rootRef={toolbarRef}
          trailing={<>
            {toolbarFit.beta !== 'hidden' && (
              <BetaTag what={pt ? 'O Studio' : 'The Studio'} compact={toolbarFit.beta === 'compact'} />
            )}
            {/* THE FIXED TRIO — gear, full screen, minimize (right slot only, and always LAST, so
                it keeps one position whether the panel is open or not) — see `fixedControls`' own
                header for why minimize is absent here at the bottom. NEVER negotiated away by `toolbarFit` — see that function's own
                header for why. */}
            {fixedControls}
          </>}
        />
      )}
      <StudioBody
        layout={layout}
        side={treeSide}
        treeWidth={shownTreeWidth}
        treeShown={treeShown}
        editorShown={editorShown}
        available={available}
        lang={lang}
        containerRef={measure}
        onResize={resize}
        onCommit={commit}
        onCollapse={() => setTreeCollapsed(true)}
        tree={<>
          {/* MOBILE ONLY — desktop's copy of this exact row is hoisted above `StudioBody` now (see
              that render's own comment). Kept here, unchanged, for the one viewport where the tree
              pane is never truly hidden while nothing is open (`treeCollapsible` is always false on
              mobile), so there is no dead state for the hoist to fix and no reason to touch it. */}
          {isMobile && view === 'tree' && (
            <Toolbar
              working={agent.working}
              isMobile
              lang={lang}
              onSearch={openSearch}
              onNew={openCreate}
              fit={toolbarFit}
              rootRef={toolbarRef}
              trailing={<>{fixedControls}</>}
            />
          )}

          {view === 'tree' && creating !== null && (
            <NewFileRow
              state={creating}
              isMobile={isMobile}
              lang={lang}
              onChange={name => setCreating(c => (c === null ? c : { ...c, name }))}
              onSubmit={() => { void submitCreate(creating.name) }}
              onCancel={() => setCreating(null)}
            />
          )}

          {view === 'search' ? (
            <RepoSearchView
              sessionId={sessionId}
              onOpenFile={openFile}
              onBack={() => setView('tree')}
              lang={lang}
            />
          ) : rootLoading ? (
            <RepoNote
              icon={<Loader size={15} className="ag-working-spin" />}
              text={pt ? 'Lendo os arquivos desta sessão…' : 'Reading this session’s files…'}
            />
          ) : (
            /* The watermark sits UNDER the tree, in the region a document would occupy if one were
               open. In the SPLIT that region is the editor pane beside it, so the mark reads as the
               tree column's own backdrop rather than as an empty document — which is what it is. It
               is decoration: `aria-hidden`, no text, and it can never take a click. */
            <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
              <Watermark />
              <RepoTreeView
                sessionId={sessionId}
                tree={tree}
                onTreeChange={setTree}
                onOpenFile={openFile}
                lang={lang}
                ops={{
                  renaming,
                  onRenameStart: startRename,
                  onRenameChange: changeRename,
                  onRenameCommit: () => { void commitRename() },
                  onRenameCancel: cancelRename,
                  onNewAt: (parentPath, kind) => setCreating({ parentPath, kind, name: '', busy: false, error: null }),
                  onDelete: requestDelete,
                  onMovePicker: openMovePicker,
                  onCopyRelativePath: copyRelativePath,
                  onCopyPath: copyPath,
                  onDropMove: (itemPath, itemKind, targetDir) => { void performMove(itemPath, itemKind, targetDir) },
                  // "Mencionar na conversa" (§6, gesture 2). A directory is mentioned exactly like a
                  // file — gesture 1 (drag onto the composer) already does this with no special case,
                  // and refusing it here only for THIS gesture would make the two disagree about
                  // what a directory mention means; see `mentionSpec.ts`'s `mentionFor`, which treats
                  // any path identically. `insertMention` is the ONE function every mention gesture
                  // calls (`lib/mentionInsert.ts`); `onMention` (this component's own prop) is fired
                  // afterward so the caller can switch the centre and toast on `needsSwitch`.
                  onMention: (path, _kind) => {
                    const result = insertMention(sessionId, harness, { path }, composerMounted)
                    onMention?.(result)
                  },
                }}
              />
            </div>
          )}
        </>}
        editor={
          <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
            <EditorStack
              sessionId={sessionId}
              paths={mounted}
              keys={mounted.map(p => tabs.find(t => t.path === p)?.id ?? p)}
              activePath={activePath}
              autosave={autosave}
              lang={lang}
              goTo={goTo}
              onDirtyChange={(path, dirty) => setTabs(prev => markDirty(prev, path, dirty))}
              harness={harness}
              composerMounted={composerMounted}
              onMention={onMention}
              onOpenPath={path => openFile(path)}
            />
            {/* NOTHING IS OPEN — this is the state the hoisted toolbar above exists to make
                recoverable, drawn rather than left blank (fix-wave review, Critical #1: "pick one,
                state the reason"). Hiding the tree with no file open is left ALLOWED — refusing it
                would take away a legitimate "minimal chrome" preference for a reader who has nothing
                open yet and wants the toolbar/gear alone — so this is the other half of that choice:
                an editor pane that says what happened and how to get a file into it, instead of the
                blank region the dead panel used to leave. It costs `mounted.length === 0` to compute,
                which is already read a few lines above for `EditorStack`'s own props. */}
            {mounted.length === 0 && (
              <StudioEditorEmptyState lang={lang} onShowTree={() => setTreeCollapsed(false)} />
            )}
          </div>
        }
      />

      <ConfirmModal
        open={pendingClose !== null}
        title={pt ? 'Fechar sem salvar?' : 'Close without saving?'}
        message={pt
          ? 'Este arquivo tem mudanças que não foram salvas. Fechar descarta o que ainda não foi salvo.'
          : 'This file has changes that have not been saved. Closing discards what has not been saved.'}
        confirmLabel={pt ? 'Fechar mesmo assim' : 'Close anyway'}
        cancelLabel={pt ? 'Continuar editando' : 'Keep editing'}
        onConfirm={() => { if (pendingClose !== null) doClose(pendingClose) }}
        onCancel={() => setPendingClose(null)}
      />

      <ConfirmModal
        open={pendingDelete !== null}
        title={pt ? 'Excluir?' : 'Delete?'}
        message={pendingDelete === null ? '' : deleteMessage(pendingDelete, hasDirtyUnder(tabs, pendingDelete.path), pt)}
        confirmLabel={pt ? 'Excluir' : 'Delete'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => { void confirmDelete() }}
        onCancel={cancelDelete}
      />

      {moving !== null && (
        <MoveToPicker
          sessionId={sessionId}
          item={moving}
          tree={tree}
          isMobile={isMobile}
          lang={lang}
          onPick={targetDir => { closeMovePicker(); void performMove(moving.path, moving.kind, targetDir) }}
          onClose={closeMovePicker}
        />
      )}

      {toast !== null && <StudioToast toast={toast} isMobile={isMobile} onDismiss={() => setToast(null)} />}
    </div>
  )
}

/** The delete confirmation's own sentence — naming what is about to go, and what else goes with it. */
export function deleteMessage(entry: PendingDelete, hasDirty: boolean, pt: boolean): string {
  const base = entry.kind === 'dir'
    ? (pt
      ? `A pasta "${entry.path}" e tudo dentro dela serão apagados. Esta ação não pode ser desfeita.`
      : `The folder "${entry.path}" and everything inside it will be deleted. This cannot be undone.`)
    : (pt
      ? `O arquivo "${entry.path}" será apagado. Esta ação não pode ser desfeita.`
      : `The file "${entry.path}" will be deleted. This cannot be undone.`)
  if (!hasDirty) return base
  return pt
    ? `${base} Há mudanças não salvas nele — elas serão perdidas.`
    : `${base} It has unsaved changes — they will be lost.`
}

// --- the chrome ----------------------------------------------------------------------------------
//
// Every piece below takes its state as a PROP and is exported for the reason `RepoSearchResults` is:
// `useEffect` never runs under `renderToStaticMarkup`, so anything reachable only by fetching and
// clicking could not be asserted at all.

/**
 * ONE REGION, SEVERAL MOUNTED TREES, EXACTLY ONE OF THEM VISIBLE.
 *
 * **IT IS NESTED, AND `visibility` COULD NOT SURVIVE THAT.** This used to hide with
 * `visibility: hidden`, which is wrong here for a reason CSS states outright: `visibility` is
 * INHERITED AND OVERRIDABLE, so a descendant setting `visibility: visible` re-shows itself inside a
 * hidden ancestor. And a descendant always does — `Studio` renders two of these inside itself and
 * one of them is always `shown`, while `ArtifactsAside` now renders the whole Studio inside one
 * more. Reproduced in Chromium on exactly this nesting: the inner layer computed `visible` under an
 * ancestor computing `hidden`, `elementsFromPoint` returned it ABOVE the tab body, and a screenshot
 * showed the file tree painted over the tab the reader had switched to. Because the box is
 * `position: absolute; inset: 0` it covered the region completely; because `inert` IS inherited and
 * cannot be undone by a descendant, what you got was a frozen, unclickable panel over your content.
 *
 * So the hide is `opacity: 0`, which a descendant cannot reverse (it is not inherited — it composites
 * the whole subtree), plus `pointer-events: none` for the clicks `opacity` leaves live and `inert`
 * for the keyboard, the accessibility tree AND hit-testing — `inert`, not `pointer-events`, is what
 * makes the last of those a guarantee, because a descendant CAN set `pointer-events: auto` and
 * become the hit target again while an inherited `inert` cannot be lifted from inside. That puts a
 * browser-support floor under this component (`inert`: Safari 16.4, Chrome 102, Firefox 112), which
 * is stated on the style itself. **`display: none` is the one thing this component
 * exists to avoid**: a display-less box measures ZERO, and a zero-sized Monaco is the one state its
 * `automaticLayout` then has to recover from — which is why the layer has to keep measuring while it
 * is hidden.
 *
 * THE COST IS STATED RATHER THAN DISCOVERED: `opacity: 0` keeps the subtree in the DOCUMENT's text,
 * which `visibility: hidden` would not — the browser's own find-in-page can still match a hidden
 * buffer. That is the cheaper half of the trade. `inert` is what keeps it out of the ACCESSIBILITY
 * tree and away from the keyboard, so a screen reader never reads it, and nothing here is ever the
 * only copy of anything on screen: the hidden layer is always a file the reader has open and can
 * bring back. Measured on a live session — the hidden layer computed `opacity: 0`,
 * `pointer-events: none` (inherited by its own shown children, which is exactly the point) and
 * `inert`, and `elementsFromPoint` over the middle of the region returned the visible content.
 *
 * `data-layer-shown` is the attribute the tests read; it is also the only honest way to ask this
 * question from outside, since every style here is inline.
 */
export function Layer({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div
      data-layer-shown={shown}
      inert={!shown}
      style={{
        position: 'absolute', inset: 0, minWidth: 0,
        display: 'flex', flexDirection: 'column',
        // NOT `visibility` — see the note above.
        //
        // TWO of these three cannot be undone from inside, and they are not the two you would guess.
        // `opacity: 0` composites the whole subtree to nothing and is not inherited, so a child's
        // `opacity: 1` composites WITHIN it and stays invisible. `inert` IS inherited and a
        // descendant has no way to lift it, which is what actually keeps the hidden layer out of the
        // keyboard, the accessibility tree AND hit-testing. `pointer-events: none` is the weak leg:
        // it is inherited but a descendant may set `pointer-events: auto` and become the hit target
        // again, so it is a cheap first line and never the guarantee.
        //
        // THE FLOOR IS `inert`: Safari 16.4 (March 2023), Chrome 102, Firefox 112. On anything older
        // the hidden layer is invisible and unfocusable only as far as `opacity` and
        // `pointer-events` reach — a descendant that re-enables pointer events would be clickable
        // while invisible. Stated rather than discovered.
        opacity: shown ? 1 : 0,
        pointerEvents: shown ? undefined : 'none',
      }}
    >
      {children}
    </div>
  )
}

/**
 * WHETHER A STACKED PANE'S OWN BOX MAY TAKE A TAP — the half of `Layer`'s rule that lives out here.
 *
 * `Layer` makes a hidden pane's CONTENT untouchable (`opacity: 0`, `pointer-events: none`, `inert`
 * over the whole subtree) and that was read as making the PANE untouchable. It does not. The box
 * the layer sits in is a different element, and in `layers` both boxes are `position: absolute;
 * inset: 0` over one region — an absolutely positioned div with no background of its own paints
 * nothing and is still a perfectly good hit target, and the EDITOR's box is the one that comes last
 * in the DOM. So on a phone every tap meant for the file tree landed on an invisible editor pane:
 * the tree was fully drawn, scrolled correctly, and did nothing at all — no file would open, and
 * neither would `Buscar` or `Novo`, which are inside it. The only control that still worked was the
 * bar above the region, i.e. the one that leaves.
 *
 * Measured at 390x844 against a live session before the fix — `document.elementsFromPoint` over the
 * middle of the `AGENTS.md` row answered, topmost first:
 *   DIV[data-studio-pane=editor] pe=auto op=1 inert=false pos=absolute box=0,45 390x799
 *   SPAN … BUTTON box=0,102 390x44   ← the row, underneath it
 * and Playwright refused the click with `<div data-studio-pane="editor"> intercepts pointer
 * events`. The desktop never saw it because `split` makes the two boxes flex SIBLINGS, which
 * overlap nothing; `layers` is the phone and the narrow aside.
 *
 * It is `pointer-events` and deliberately NOT `inert`. `inert` is INHERITED and cannot be lifted
 * from inside, so a box carrying it would freeze a `Layer` that became shown while the box had not
 * caught up — there is no style the layer could write to get out. `Layer`'s own comment calls
 * `pointer-events` the weak leg because a DESCENDANT may set `auto` and become the target again,
 * and that is exactly what makes it right here and wrong there: the box has no content of its own
 * to re-enable anything, and everything under it is already held by the layer's `inert`.
 *
 * Not restricted to `layers`, even though that is the arrangement that overlaps: a collapsed column
 * in the split is zero-wide and cannot be hit either way, so the narrower rule would buy nothing and
 * would have to be reasoned out again the next time a pane is positioned over another one.
 */
export function paneHits(shown: boolean): 'none' | undefined {
  return shown ? undefined : 'none'
}

/**
 * WHERE THE TWO PANES SIT — and nothing else.
 *
 * It takes the tree and the editor as NODES and decides only their boxes. That separation is the
 * whole point: every rule about what stays mounted and how a hidden pane is hidden lives in `Layer`
 * and in `mountedEditors`, one level in, and a layout that reached into either would be a second
 * place for the rules this panel exists to keep to be got wrong. Drop the split tomorrow and the
 * buffers are untouched.
 *
 * ONE DOM SHAPE FOR BOTH ARRANGEMENTS, and that is load-bearing rather than tidy. Rendering a
 * different tree per layout would REMOUNT everything under it the moment the aside was dragged past
 * `SPLIT_MIN` or a phone was turned sideways — which is `RepoFileEditor` re-reading its file and
 * disposing its Monaco model, i.e. exactly the silent loss of typed text this composition is
 * arranged to make impossible. So the panes are the same two boxes in both cases and only their
 * STYLES differ: absolutely stacked over one region when `layers`, side by side in a flex row when
 * `split`.
 *
 * THE COLLAPSE IS A WIDTH, NOT A `display`. The pane goes to zero and clips, while the SIZER inside
 * it keeps the tree laid out at its full width the whole time — so the tree's scroll position and
 * its wrapping survive being hidden, which reflowing it to zero would destroy, and `display: none`
 * would destroy along with everything `Layer`'s own comment says about measuring. The `Layer` is
 * told `shown={false}` for the same reasons it always is: `inert` is what takes a clipped-but-alive
 * column out of the keyboard's reach and out of the accessibility tree.
 *
 * The pane BOXES carry `data-studio-pane` and the region `data-studio-layout` — every style here is
 * inline, so those attributes are the only honest way to ask this question from outside.
 */
export function StudioBody({
  layout, side = 'left', treeWidth, treeShown, editorShown, available, lang,
  containerRef, onResize, onCommit, onCollapse, tree, editor,
}: {
  layout: StudioLayout
  /**
   * WHICH SIDE THE TREE SITS ON (design item 10). Read here as one CSS property
   * (`flexDirection: row-reverse`) rather than by swapping which of the two DOM nodes is written
   * first — the pane order is the exact invariant `both arrangements are the SAME two boxes in the
   * same order` (this file's own test) exists to protect, and a component that reordered its
   * children to flip sides would need a second reason to never break that. `row-reverse` flips only
   * what is PAINTED where; `mountedEditors`, `Layer` and every buffer under either pane are
   * untouched. Defaults to `'left'` — the tree's position before this option existed.
   */
  side?: TreeSide
  /** Already clamped by the caller — this component measures nothing and decides nothing. */
  treeWidth: number
  treeShown: boolean
  editorShown: boolean
  /** The measured region width, for the separator's `aria-valuemax`. `0` = not measured yet. */
  available: number
  lang: 'pt' | 'en'
  containerRef?: (el: HTMLDivElement | null) => void
  onResize: (width: number) => void
  onCommit: (width: number) => void
  onCollapse: () => void
  tree: ReactNode
  editor: ReactNode
}) {
  const split = layout === 'split'
  /*
   * COLLAPSED means "the reader minimized the tree", not merely "the tree is not on screen" — the
   * ordinary layers arrangement already hides the tree behind an open file (`editorShown === true`
   * there), and that state has its own way back already (the tab strip's own back arrow), not this
   * rail. What this catches is the state where NEITHER pane is showing anything: the split always
   * qualifies once its tree is hidden (the editor is what is left standing beside it), and so does
   * the no-file-open `layers` panel once its one and only pane is minimized — `editorShown` is false
   * there because there is nothing to show beside it (fix-wave review, Critical #1).
   */
  const collapsed = !treeShown && (split || !editorShown)
  const reverse = side === 'right'
  return (
    <div
      ref={containerRef}
      data-studio-layout={layout}
      data-studio-side={side}
      style={{
        position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex',
        flexDirection: reverse ? 'row-reverse' : 'row',
      }}
    >
      <div
        data-studio-pane="tree"
        style={split
          ? {
            position: 'relative', minWidth: 0, flexShrink: 0, overflow: 'hidden',
            width: collapsed ? 0 : treeWidth,
          }
          : { position: 'absolute', inset: 0, pointerEvents: paneHits(treeShown) }}
      >
        {/*
          THE SIZER. It holds the tree at a CONSTANT width while the pane around it collapses to
          zero, so nothing inside reflows and the scroll position of a long listing is exactly where
          it was when the column comes back. Reflowing a file tree to 0px and back is how a reader
          loses their place in it — a cost paid for nothing, since the column is clipped either way.
        */}
        <div style={{
          position: 'relative', height: '100%', minWidth: 0,
          width: split ? treeWidth : '100%',
        }}>
          <Layer shown={treeShown}>{tree}</Layer>
        </div>
      </div>

      {/*
        NO RAIL HERE ANY MORE (design item 4, screenshot 3 — "there is a floating aside button when
        the tree is closed"). This used to render a `CollapsedTreeRail` in place of the divider
        whenever `collapsed`, so a minimized tree had TWO ways back on screen at once: this rail AND
        the Studio bar's own labelled "Mostrar árvore" toggle, floating with no other chrome around
        it in the no-file-open case (screenshot 3's own capture). `StudioBar`'s toggle is now the
        ONLY way back — see `Studio`'s own `treeCollapsible`/`resolveTreeShown` for why it is
        offered whenever there is something to act on. Collapsed and split, there is simply no
        divider to drag (nothing to resize at zero width); collapsed and NOT split, there is nothing
        here at all.
      */}
      {split && !collapsed && (
        <TreeDivider
          width={treeWidth}
          available={available}
          lang={lang}
          reverse={reverse}
          onResize={onResize}
          onCommit={onCommit}
          onCollapse={onCollapse}
        />
      )}

      <div
        data-studio-pane="editor"
        style={split
          ? { position: 'relative', flex: 1, minWidth: 0 }
          : { position: 'absolute', inset: 0, pointerEvents: paneHits(editorShown) }}
      >
        <Layer shown={editorShown}>{editor}</Layer>
      </div>
    </div>
  )
}

/** How far one arrow key moves the column. `AsideResizer`'s own step, so the two feel the same. */
const DIVIDER_STEP = 16

/**
 * THE WIDTH A DRAG ASKS FOR (design item 10). Dragging the divider AWAY from the tree must always
 * GROW the column, whichever side it sits on — with the tree on the LEFT the divider sits to its
 * RIGHT, so moving the pointer right (a positive `deltaX`) grows it; flipped to the RIGHT side, the
 * divider now sits on the tree's LEFT, and the same rightward drag would move INTO the column,
 * shrinking it, unless the sign is reversed. Pure so the arithmetic is testable without a pointer.
 */
export function dividerWantedWidth(startWidth: number, deltaX: number, reverse: boolean): number {
  return startWidth + (reverse ? -deltaX : deltaX)
}

/**
 * The KEYBOARD, deliberately UNAFFECTED by `side`. `ArrowRight` always means "grow the column",
 * never "move toward the right edge of the screen" — the same LOGICAL-VALUE convention `Home`/`End`
 * already use here (they jump to `TREE_MIN`/the real maximum regardless of which side the tree is
 * on, never to "the left edge of the screen"/"the right edge"). A physical mapping would flip the
 * meaning of the key depending on where the tree happens to sit, which is the opposite of what a
 * keyboard shortcut is for — a slider's ArrowRight/ArrowUp increases its value on every slider ever
 * built, whichever way the slider itself is drawn.
 */
export function dividerKeyDelta(key: string): number {
  return key === 'ArrowLeft' ? -DIVIDER_STEP : key === 'ArrowRight' ? DIVIDER_STEP : 0
}

/**
 * The grip between the tree and the editor.
 *
 * A 6px hit area over a 2px line, the trade `AsideResizer` already records: the line is what you
 * should see and it is not something a pointer can reliably land on.
 *
 * IT IS OPERABLE FROM THE KEYBOARD, and that is not a nicety — a column you can only reach by
 * dragging is a column some readers cannot move at all. `separator` with a `valuenow` is the role
 * ARIA has for exactly this: arrows step, Home and End go to the bounds, and `Enter` minimizes,
 * which is the same act the Studio's own bar offers with a word on it. The bar is what brings it
 * BACK — a collapsed column has no separator left to press, so a keyboard-only way out would be a
 * control that can hide itself and nothing else.
 *
 * IT DECIDES NO WIDTH. Every number it emits is a WANT; the clamp lives with the component that
 * knows how much room there is (`clampTreeWidth` against the measured region), so there is one
 * answer to how wide the column may be and it is testable without a pointer.
 */
export function TreeDivider({ width, available, lang, reverse = false, onResize, onCommit, onCollapse }: {
  width: number
  available: number
  lang: 'pt' | 'en'
  /** The tree sits on the RIGHT (design item 10) — the divider is now on the tree's LEFT rather
   *  than its right, so the pointer/keyboard direction that GROWS the column flips too. See
   *  `dividerWantedWidth`/`dividerKeyDelta`. */
  reverse?: boolean
  onResize: (width: number) => void
  onCommit: (width: number) => void
  onCollapse: () => void
}) {
  const pt = lang === 'pt'
  const drag = useRef<{ x: number; w: number } | null>(null)
  const latest = useRef(width)
  latest.current = width
  /**
   * What the LAST move asked for, which is not the same as what is currently on screen.
   *
   * Committing the rendered `width` reads the state as of the last render, and a `mouseup` that
   * arrives in the same task as the final `mousemove` is one React has not re-rendered for yet — so
   * the drag would be remembered at the width it had BEFORE its last step. The want is the fact the
   * pointer stated; `onCommit` clamps it exactly as `onResize` did.
   */
  const wanted = useRef<number | null>(null)

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const from = drag.current
      // The delta from where the drag STARTED, never the pointer's absolute x: this column's left
      // edge is wherever the aside happens to be, and reading it every frame is a forced layout.
      if (from === null) return
      const want = dividerWantedWidth(from.w, e.clientX - from.x, reverse)
      wanted.current = want
      onResize(want)
    }
    const up = () => {
      if (drag.current === null) return
      drag.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persisted ONCE, at the end — a write per pointer move is a write per frame.
      onCommit(wanted.current ?? latest.current)
      wanted.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [onResize, onCommit, reverse])

  // What the column could reach HERE, so the announced maximum is the real one rather than the
  // absolute cap. Unmeasured falls back to the cap, which is the only honest answer then.
  const max = available > 0
    ? Math.max(TREE_MIN, Math.min(TREE_MAX, available - DIVIDER_W - EDITOR_MIN))
    : TREE_MAX

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={pt ? 'Redimensionar a árvore de arquivos' : 'Resize the file tree'}
      aria-valuenow={width}
      aria-valuemin={TREE_MIN}
      aria-valuemax={max}
      tabIndex={0}
      // `.ag-resize-handle` (design item 6) is on top of, not instead of, this divider's own
      // background wash on hover/focus — the wash marks the whole strip, the grip marks the exact
      // spot to grab, and the two read as one control together.
      className="ag-resize-handle"
      onMouseDown={e => {
        e.preventDefault()
        drag.current = { x: e.clientX, w: width }
        wanted.current = null
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onDoubleClick={() => onCommit(TREE_DEFAULT)}
      onKeyDown={e => {
        const delta = dividerKeyDelta(e.key)
        if (delta !== 0) { e.preventDefault(); onCommit(width + delta); return }
        if (e.key === 'Home') { e.preventDefault(); onCommit(TREE_MIN); return }
        if (e.key === 'End') { e.preventDefault(); onCommit(max); return }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCollapse() }
      }}
      style={{
        position: 'relative', width: DIVIDER_W, flexShrink: 0, alignSelf: 'stretch',
        cursor: 'col-resize', background: 'transparent', border: 'none', padding: 0,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--anthropic-orange-dim)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      onFocus={e => { e.currentTarget.style.background = 'var(--anthropic-orange-dim)' }}
      onBlur={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, bottom: 0, left: 2, width: 1,
        background: 'var(--border)', pointerEvents: 'none',
      }} />
      <ResizeGrip orientation="vertical" />
    </div>
  )
}

/**
 * Every mounted buffer, stacked — exactly one of them visible.
 *
 * This is where "switching tabs does not destroy what you typed" is actually spent, so it is its own
 * exported component: a test can render it with two paths and see BOTH editors in the markup, which
 * is the one fact the pure `mountedEditors` cannot carry on its own.
 *
 * The editors are stacked absolutely inside one relative box so that every one of them has the full
 * region's size, visible or not — which is exactly what `Layer` is, so it is `Layer` that draws them
 * rather than a second copy of the same three styles. That matters beyond tidiness: this stack sits
 * INSIDE two more layers, and `Layer`'s doc comment records why the hide may not be `visibility`
 * (a descendant can set `visibility: visible` and re-show itself through a hidden ancestor, which
 * shipped once and painted a frozen file tree over the tab the reader had switched to). One hiding
 * rule, in one place, for every level of the nest.
 *
 * `data-editor-path` stays on a wrapper of its own: it is what the tests count mounted buffers by,
 * and `Layer` carries no identity.
 *
 * **`keys` IS WHAT LETS A RENAME SURVIVE.** The `React.key` here used to be `path` itself, which is
 * exactly right for every ORDINARY case — a path only ever changes by the host swapping in a
 * different file, which must remount — and exactly wrong for the one case that is not that: a
 * rename or a move changes an open tab's `path` while it stays the SAME logical file. Keying by
 * `path` there would unmount `RepoFileEditor` and remount a fresh one, which disposes the live
 * Monaco model and re-reads the new name from disk — the unsaved text and the undo stack the rename
 * was never meant to touch, gone. `keys[i]` is each path's STABLE identity (`OpenTab.id`, minted once
 * when the tab is opened and never the path itself — see `repoTreeModel.ts`'s own header for why a
 * path-derived id collided with a freshly created file reusing a renamed tab's old name), so a
 * renamed tab keeps the SAME React instance and only its `path` PROP changes; `RepoFileEditor` detects that on its own
 * (comparing the prop against the path it saw last render) and treats it as a retarget rather than
 * a new file — see its own header. `keys` is OPTIONAL and defaults to `path` itself, which is
 * today's exact behaviour, so every caller that never renames anything (every test below, and every
 * caller before this task) is unaffected.
 */
export function EditorStack({
  sessionId, paths, keys, activePath, autosave, lang, goTo, onDirtyChange,
  harness, composerMounted, onMention, onOpenPath,
}: {
  sessionId: string
  paths: readonly string[]
  /** Same length and order as `paths` — see the note above. Absent falls back to `path` itself. */
  keys?: readonly string[]
  activePath: string | null
  autosave: boolean
  lang: 'pt' | 'en'
  goTo: GoTo | null
  onDirtyChange: (path: string, dirty: boolean) => void
  /** Threaded straight through to every `RepoFileEditor` — §6's "Mencionar seleção" (gesture 3). See
   *  `StudioProps`' own doc comments; `Studio.tsx` is the one caller and passes its own props here. */
  harness?: HarnessId
  composerMounted?: boolean
  onMention?: (result: { text: string; needsSwitch: boolean }) => void
  /** A relative link the markdown preview renders — opens that repo file in the Studio, the same
   *  way a tree click does. See `RepoFileEditor`'s own doc comment for the prop this forwards. */
  onOpenPath?: (path: string) => void
}) {
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
      {paths.map((path, i) => {
        const active = path === activePath
        return (
          <Layer key={keys?.[i] ?? path} shown={active}>
            <div data-editor-path={path} style={{
              flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
            }}>
              <RepoFileEditor
                sessionId={sessionId}
                path={path}
                autosave={autosave}
                onDirtyChange={dirty => onDirtyChange(path, dirty)}
                lang={lang}
                {...(goTo !== null && goTo.path === path
                  ? { gotoLine: goTo.line, gotoSeq: goTo.seq }
                  : {})}
                harness={harness}
                composerMounted={composerMounted}
                onMention={onMention}
                onOpenPath={onOpenPath}
              />
            </div>
          </Layer>
        )
      })}
    </div>
  )
}

/**
 * StudioEditorEmptyState — nothing is open (fix-wave review, Critical #1). Drawn over the editor
 * pane whenever `mounted.length === 0`, which now includes the state that used to be a dead panel:
 * the tree minimized with no file open, where `editorShown` (above) makes this pane the one thing on
 * screen instead of neither.
 *
 * IT NAMES THE WAY BACK RATHER THAN ONLY POINTING AT IT — the toolbar's own gear ("Mostrar árvore")
 * is already reachable in every arrangement after the hoist above, so this button is a SECOND route
 * to the exact same `setTreeCollapsed(false)` call, offered here for discoverability (a reader who
 * has never opened the gear should not have to) rather than as a competing implementation — there is
 * still exactly one ACTION, `treeCollapsed -> false`, only two places a reader can trigger it from,
 * the same relationship the tab strip's own "back to tree" arrow already has with this same toggle.
 *
 * `aria-hidden` on the watermark only — the sentence and the button are real content, not decoration.
 */
function StudioEditorEmptyState({ lang, onShowTree }: { lang: 'pt' | 'en'; onShowTree: () => void }) {
  const pt = lang === 'pt'
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center',
    }}>
      <Watermark />
      <p style={{
        position: 'relative', margin: 0, fontSize: 12.5, lineHeight: 1.5,
        color: 'var(--text-tertiary)', maxWidth: 280,
      }}>
        {pt ? 'Nenhum arquivo aberto.' : 'No file open.'}
      </p>
      <button
        type="button"
        className="ag-tap-icon"
        onClick={onShowTree}
        style={{
          position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border-subtle)',
          background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 12,
        }}
      >
        <PanelLeftOpen size={13} />
        {pt ? 'Mostrar árvore' : 'Show tree'}
      </button>
    </div>
  )
}

/** The mark, as a CSS MASK: the alpha channel is the shape, so the file's own colour is irrelevant. */
const MARK_URL = '/markMask.png'
/** The asset's own aspect, so the box is the mark's box and the mask fills it exactly. */
const MARK_ASPECT = '323 / 441'

/**
 * The mark, behind the tree.
 *
 * ONE ASSET FOR BOTH THEMES. It is painted with `currentColor` through a mask rather than drawn as
 * an image, so the colour is the theme's own text colour and there is no second file to keep in
 * sync — the dark and light marks cannot drift apart because there is only one. The OPACITY is the
 * one thing that differs, and it differs because it must (`watermarkOpacity`).
 *
 * The theme is read off `<html data-theme>`, the one place `App.tsx` writes it, and followed with an
 * observer — the same route `RepoFileEditor` takes for Monaco's own theme, rather than threading a
 * second copy of one fact through two components.
 */
export function Watermark() {
  const [theme, setTheme] = useState<string | null>(() => (
    typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme')
  ))

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(root.getAttribute('data-theme')))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <div style={{
        width: 'min(46%, 168px)', aspectRatio: MARK_ASPECT, maxHeight: '62%',
        maskImage: `url(${MARK_URL})`, WebkitMaskImage: `url(${MARK_URL})`,
        maskSize: 'contain', WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center', WebkitMaskPosition: 'center',
        backgroundColor: 'currentColor', color: 'var(--text-primary)',
        opacity: watermarkOpacity(theme),
      }} />
    </div>
  )
}

/**
 * Search, New, whether the agent is busy, and — since §2 — everything that used to sit in the
 * Studio's own header ROW: the BETA badge and the gear menu (layout options, full screen, close).
 *
 * The dot is not a decoration: it is the answer to "is something else writing in here right now",
 * which is the question a person is about to edit a file against. It carries its own label, because
 * a coloured circle says nothing to a reader who cannot see it.
 *
 * `trailing` is a slot, not a name this component knows anything about: `Studio.tsx` decides what
 * goes there (the badge, the gear) so this row stays reusable and stays ignorant of the gear menu's
 * own contract. It shares ONE `marginLeft: 'auto'` wrapper with the working dot rather than the dot
 * keeping its own — two independently-right-aligned items would sit apart instead of as a group.
 *
 * `fit` (`studioToolbarFit`, above) decides which of THIS component's own items survive at the
 * measured width — `rootRef` is the hook the caller measures through (`useElementWidth`, the same
 * "the bar's OWN measured width, never the window's" pattern `ShellBand`'s bar already uses), passed
 * in rather than owned here because `trailing`'s own BETA badge needs the SAME `fit` to decide its
 * mode, and a value two siblings both read is computed once by whoever renders both — `Studio.tsx`.
 * `PanelFixedControls` (inside `trailing`) is NEVER part of this negotiation: `fit`'s own header
 * states why, and this component enforces nothing about it — it only draws the three tree actions
 * and the working dot the fit describes.
 */
export function Toolbar({ working, isMobile, lang, onSearch, onNew, trailing, fit, rootRef }: {
  working: boolean
  isMobile: boolean
  lang: 'pt' | 'en'
  onSearch: () => void
  onNew: (kind: 'file' | 'dir') => void
  trailing?: ReactNode
  fit: StudioToolbarFit
  rootRef?: (el: HTMLDivElement | null) => void
}) {
  const pt = lang === 'pt'
  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, minWidth: 0,
        boxSizing: 'border-box',
        padding: isMobile ? '6px 8px' : '5px 8px',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {fit.showSearch && (
        <BarButton
          label={pt ? 'Buscar' : 'Search'}
          icon={<Search size={12} />}
          isMobile={isMobile}
          showLabel={fit.treeLabels}
          onClick={onSearch}
        />
      )}
      {fit.showNewFile && (
        <BarButton
          label={pt ? 'Novo arquivo' : 'New file'}
          icon={<Plus size={12} />}
          isMobile={isMobile}
          showLabel={fit.treeLabels}
          onClick={() => onNew('file')}
        />
      )}
      {fit.showNewFolder && (
        <BarButton
          label={pt ? 'Nova pasta' : 'New folder'}
          icon={<FolderPlus size={12} />}
          isMobile={isMobile}
          showLabel={fit.treeLabels}
          onClick={() => onNew('dir')}
        />
      )}
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
        {working && fit.showWorking && (
          <span
            role="img"
            aria-label={pt ? 'O agente está trabalhando nesta sessão' : 'The agent is working in this session'}
            title={pt ? 'O agente está trabalhando nesta sessão' : 'The agent is working in this session'}
            style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: 'var(--accent-green, #22c55e)',
            }}
          />
        )}
        {trailing}
      </span>
    </div>
  )
}

/**
 * Creating a file, asked INSIDE the panel.
 *
 * Never `window.prompt`: it blocks the whole tab, and this panel is mounted inside a workspace that
 * polls the fleet every few seconds — the objection `BackupSettings.tsx` already records three times
 * for `window.confirm`. It is also the only form of this question that can be 16px on a phone (below
 * that iOS Safari zooms the viewport and takes the workspace's sticky header with it), that follows
 * the theme, and that can keep a REFUSAL on screen beside the name that caused it instead of
 * throwing it away with an alert.
 */
export function NewFileRow({ state, isMobile, lang, onChange, onSubmit, onCancel }: {
  state: Creating
  isMobile: boolean
  lang: 'pt' | 'en'
  onChange: (name: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const pt = lang === 'pt'
  const ready = state.name.trim() !== '' && !state.busy
  const isFile = state.kind === 'file'
  // A nested create has nowhere of its own to sit — this is the one create slot this panel has —
  // so the DESTINATION is said in the field's own label instead of moving the input to that
  // folder's row.
  const destLabel = state.parentPath === '' ? '' : (pt ? ` em ${state.parentPath}/` : ` in ${state.parentPath}/`)
  const ariaLabel = isFile
    ? (pt ? `Nome do novo arquivo${destLabel}` : `New file name${destLabel}`)
    : (pt ? `Nome da nova pasta${destLabel}` : `New folder name${destLabel}`)
  return (
    <div style={{
      flexShrink: 0, minWidth: 0, boxSizing: 'border-box',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
        padding: isMobile ? '5px 8px' : '4px 8px',
      }}>
        {isFile
          ? <FilePlus size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          : <FolderPlus size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />}
        {state.parentPath !== '' && (
          <span style={{
            flexShrink: 0, fontSize: isMobile ? 13.5 : 12, color: 'var(--text-tertiary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '35%',
          }}>
            {state.parentPath}/
          </span>
        )}
        <input
          value={state.name}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          disabled={state.busy}
          onChange={ev => onChange(ev.target.value)}
          onKeyDown={ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); if (ready) onSubmit() }
            if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); onCancel() }
          }}
          aria-label={ariaLabel}
          placeholder={isFile ? (pt ? 'arquivo.ts' : 'file.ts') : (pt ? 'pasta' : 'folder')}
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box',
            background: 'transparent', border: 'none', outline: 'none',
            fontFamily: 'inherit', color: 'var(--text-primary)',
            // 16px on a phone is not a taste: below it, iOS Safari zooms the viewport on focus.
            fontSize: isMobile ? 16 : 13,
            minHeight: isMobile ? 44 : undefined,
          }}
        />
        {/*
          CONFIRM AND CANCEL, AND ON A PHONE THEY ARE WORDS.

          They were two `IconButton`s, 22x22 and six painted pixels apart, and `.ag-tap-icon` grows a
          hit box 7px on each side — which is the overlap index.css's own comment says must never be
          waved away, sitting here on the one pair where it costs something: a mis-tap CANCELS what
          you just typed. MEASURED at 390x844 on a live session, by probing `elementFromPoint`
          outward from each centre: Create painted `x:332..354` but only answered over `325..352`,
          because Cancel answered from `353` — the right TWO PIXELS of the Create button already
          cancelled. Neither reached 44 in either axis (27x35 and 35x35).

          Labels fix both halves at once: a word is wider than a finger, so the targets stop
          overlapping, and the reader can see which is which — the `title` that used to carry that
          is not something a phone can show. Height only, never a 44x44 square: see `BarButton`.
        */}
        {isMobile ? (
          <>
            <BarButton
              label={pt ? 'Criar' : 'Create'}
              icon={state.busy ? <Loader size={14} className="ag-working-spin" /> : <Check size={14} />}
              isMobile
              // A disabled CONFIRM is the honest state while the name is empty — the `ready` rule is
              // the same one the desktop button reads and the Enter key applies.
              disabled={!ready}
              onClick={onSubmit}
            />
            <BarButton
              label={pt ? 'Cancelar' : 'Cancel'}
              icon={<X size={14} />}
              isMobile
              onClick={onCancel}
            />
          </>
        ) : (
          <>
            <IconButton
              label={isFile
                ? (pt ? 'Criar o arquivo' : 'Create the file')
                : (pt ? 'Criar a pasta' : 'Create the folder')}
              disabled={!ready}
              onClick={onSubmit}
            >
              {state.busy ? <Loader size={14} className="ag-working-spin" /> : <Check size={14} />}
            </IconButton>
            <IconButton label={pt ? 'Cancelar' : 'Cancel'} onClick={onCancel}>
              <X size={14} />
            </IconButton>
          </>
        )}
      </div>

      {/* The server's own sentence, kept BESIDE the name that caused it — `already-exists` is only
          useful next to the thing that already exists. */}
      {state.error !== null && (
        <p role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: 6, margin: 0, minWidth: 0,
          padding: '0 10px 6px', fontSize: 11, lineHeight: 1.45, color: 'var(--accent-red)',
        }}>
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ minWidth: 0 }}>{state.error}</span>
        </p>
      )}
    </div>
  )
}

/**
 * "Mover para…" — the ONLY move gesture on a phone, and a second way in on desktop.
 *
 * SEEDED from the SAME `tree` the tree view already maintains rather than fetching its own from
 * scratch: a folder only appears here once it has already been read at least once, exactly the
 * condition `applyDirRefresh`'s own header states for refreshing it after the move — so every
 * destination this picker can offer is already a real node the move's own refresh can land on.
 *
 * **It is a COPY from that point on, not a shared reference (a review minor,
 * `session-w1c-tree-ops-review.md` — an earlier draft of this comment claimed otherwise).**
 * `liveTree` is this component's OWN state, re-seeded from `tree` only when the PROP changes;
 * expanding a folder here calls `toggleDirectory` against `liveTree`/`setLiveTree`, never against
 * the tree view's own `onTreeChange`, so a folder opened from inside this picker does NOT stay open
 * in the tree behind it once the picker closes. That is the right behaviour (a destination browsed
 * while choosing where to move something is not a request to change what the tree itself has
 * expanded) — the earlier comment simply described the wrong mechanism for it.
 *
 * Illegal targets are not merely refused on click — they are ABSENT from the list, the same rule
 * this product applies to a control that cannot act at all (`ControlService.startOptions`'s own
 * "the offer is unreachable rather than refused after the fact"): a folder that is the item itself,
 * one of its own descendants, or the folder the item is already in, offers nothing a click here
 * could do.
 */
export function MoveToPicker({ sessionId, item, tree, isMobile, lang, onPick, onClose }: {
  sessionId: string
  item: Moving
  tree: TreeNode
  isMobile: boolean
  lang: 'pt' | 'en'
  onPick: (targetDir: string) => void
  onClose: () => void
}) {
  const pt = lang === 'pt'
  const [liveTree, setLiveTree] = useState(tree)
  useEffect(() => { setLiveTree(tree) }, [tree])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  const folders = flattenVisible(liveTree).filter(r => r.kind === 'dir')
  const rootOk = canMoveInto(item.path, '')

  const onToggleFolder = (path: string) => {
    void toggleDirectory(liveTree, path, lang, setLiveTree, p => fetchTree(sessionId, p, lang))
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
        padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: isMobile ? undefined : 420,
          height: isMobile ? '100%' : undefined, maxHeight: isMobile ? undefined : '70vh',
          background: 'var(--bg-card)', border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 12,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          boxShadow: isMobile ? undefined : '0 12px 48px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: isMobile ? '12px 12px' : '14px 16px 10px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>
            {pt ? `Mover "${item.path}" para…` : `Move "${item.path}" to…`}
          </span>
          <IconButton label={pt ? 'Fechar' : 'Close'} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}>
          {rootOk && (
            <MoveTargetRow
              label={pt ? '/ (raiz)' : '/ (root)'}
              depth={0}
              isMobile={isMobile}
              onPick={() => onPick('')}
            />
          )}
          {folders.map(row => {
            const legal = canMoveInto(item.path, row.path)
            return (
              <div key={row.path}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="ag-tap-icon"
                    aria-label={row.expanded
                      ? (pt ? `Recolher ${row.name}` : `Collapse ${row.name}`)
                      : (pt ? `Expandir ${row.name}` : `Expand ${row.name}`)}
                    onClick={() => onToggleFolder(row.path)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      // PAINTED small on every width; `.ag-tap-icon` projects the 44px a phone
                      // needs without the box itself becoming three times the chevron inside it.
                      width: 28, height: 28, flexShrink: 0,
                      marginLeft: row.depth * (isMobile ? 14 : 16),
                      background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {row.loading
                      ? <Loader size={13} className="ag-working-spin" />
                      : row.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  {legal
                    ? <MoveTargetRow label={row.name} depth={0} isMobile={isMobile} onPick={() => onPick(row.path)} grow />
                    : (
                      <span style={{
                        flex: 1, minWidth: 0, padding: isMobile ? '6px 12px' : '5px 10px',
                        fontSize: isMobile ? 13.5 : 12.5, color: 'var(--text-tertiary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {row.name}
                      </span>
                    )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** One clickable destination row in the picker. */
function MoveTargetRow({ label, depth, isMobile, onPick, grow }: {
  label: string
  depth: number
  isMobile: boolean
  onPick: () => void
  grow?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', textAlign: 'left',
        width: grow === true ? undefined : '100%', flex: grow === true ? 1 : undefined, minWidth: 0,
        boxSizing: 'border-box',
        minHeight: isMobile ? 44 : undefined,
        padding: isMobile ? '6px 12px' : '5px 10px',
        paddingLeft: grow === true ? 0 : 12 + depth * (isMobile ? 14 : 16),
        background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
        fontSize: isMobile ? 13.5 : 12.5, color: 'var(--text-primary)',
      }}
      onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </button>
  )
}

/**
 * A move's own toast: "Movido para `dir/`" with **Desfazer** for 6s, or a quiet copy confirmation
 * with no action at all. `role="status"` — the same ephemeral-announcement role this product uses
 * everywhere else a sentence appears and disappears on its own.
 *
 * **The action button DISMISSES ON CLICK (a review minor, `session-w1c-tree-ops-review.md`)** —
 * pressing Desfazer used to leave the toast standing, live, for the rest of its 6s window, so a
 * second, impatient press sent a SECOND undo request against a rename the first had already
 * reversed, which the server correctly refused ("Não foi possível desfazer: Já existe algo nesse
 * caminho.") — a refusal about nothing, caused only by the toast outliving the action it offered.
 */
export function StudioToast({ toast, isMobile, onDismiss }: {
  toast: ToastState
  isMobile: boolean
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      style={{
        position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
        zIndex: 50, maxWidth: 'calc(100% - 24px)',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: isMobile ? '8px 10px 8px 14px' : '7px 8px 7px 14px',
        borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        boxShadow: 'var(--ag-shadow-pop)',
      }}
    >
      <span style={{
        fontSize: 12.5, color: 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {toast.text}
      </span>
      {toast.action !== undefined && (
        <button
          type="button"
          onClick={() => { toast.action?.onClick(); onDismiss() }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
            minHeight: isMobile ? 44 : undefined,
            padding: isMobile ? '0 10px' : '3px 9px',
            borderRadius: 7, border: '1px solid var(--border-subtle)', background: 'transparent',
            color: 'var(--anthropic-orange)', fontFamily: 'inherit', fontWeight: 600,
            fontSize: isMobile ? 13 : 11.5, cursor: 'pointer',
          }}
        >
          <Undo2 size={12} />
          {toast.action.label}
        </button>
      )}
    </div>
  )
}

/**
 * The open files.
 *
 * It stays on screen while the TREE is showing too, which is not a detail: the back control returns
 * to the tree without closing anything, and a strip that disappeared with the editor would leave
 * every open buffer — including an unsaved one — reachable only by finding the file again.
 *
 * The name and the close are SIBLING buttons, never a button inside a button: nesting them is
 * invalid, and it makes the close a region of the tab rather than a control of its own for anything
 * that reads the markup instead of looking at it.
 *
 * EACH TAB WEARS ITS `fileIcon.tsx` GLYPH, the same one the tree draws for that name — a strip of
 * six open files used to be six identical shapes, distinguished only by a truncated name each. Its
 * WIDTH is part of the measurement in `StudioBody`'s own contract: the icon grows every tab by a
 * fixed amount, so the overflow split (`scrollWidth <= innerWidth`) had to be re-checked at 390px
 * and 1440px after adding it, not assumed to still hold.
 */
export function TabStrip({ tabs, activePath, agentHere, isMobile, lang, onSelect, onClose, onBack }: {
  tabs: readonly OpenTab[]
  activePath: string | null
  agentHere: boolean
  isMobile: boolean
  lang: 'pt' | 'en'
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /** Absent while the tree is already showing — a back control with nothing to go back to. */
  onBack?: () => void
}) {
  const pt = lang === 'pt'
  /**
   * THE ACTIVE TAB SCROLLS INTO VIEW (fix-wave review, owner follow-up #6, W1-A). With 5+ tabs open
   * on a 390px strip the row overflows and the strip never followed which one was open — opening
   * the sixth file left it scrolled off the right edge, selected but invisible. `{block: 'nearest',
   * inline: 'nearest'}` moves only THIS scroller (the strip's own `overflowX: auto`) and only as far
   * as it takes to bring the tab on screen — never the page, and never a jump when it is already
   * visible.
   */
  const activeTabRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath])
  return (
    <div
      role="list"
      aria-label={pt ? 'Arquivos abertos' : 'Open files'}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, minWidth: 0,
        boxSizing: 'border-box',
        padding: isMobile ? '4px 6px' : '3px 6px',
        borderBottom: '1px solid var(--border-subtle)',
        overflowX: 'auto', overflowY: 'hidden', overscrollBehavior: 'contain',
      }}
    >
      {/*
        THE WAY BETWEEN THE TWO LAYERS, AND ON A PHONE IT IS THE ONLY ONE — so it carries a WORD.
        `layers` is the whole arrangement at 390px: the tree and the editor are not two columns you
        glance between, they are two screens, and this is the single control that goes from the
        second back to the first. It was an `IconButton` on both layouts — a bare 15px arrow in a
        strip of filenames, with its name reachable only through `title`, which a phone has no hover
        to show. MEASURED at 390x844 on a live session: painted 22x22, and `.ag-tap-icon`'s invisible
        box brought the real hit area to 34x35, not the 44 the class's own doc claims for it.
        Two things were wrong at once and the label is the one that mattered more: a reader who
        cannot see what a control does does not press it to find out.

        Height only, never a 44x44 square — the label is what makes it wide enough for a finger, and
        a painted square around a labelled control is what `touchTarget.lint.test.ts` refuses. On the
        DESKTOP this appears only in the narrow aside, where the strip is a few pixels tall and the
        reader has a pointer and a tooltip, so it keeps the icon it had.
      */}
      {onBack !== undefined && (isMobile
        ? <BarButton
          label={pt ? 'Arquivos' : 'Files'}
          icon={<ArrowLeft size={15} />}
          isMobile
          onClick={onBack}
        />
        : (
          <IconButton label={pt ? 'Voltar para a árvore de arquivos' : 'Back to the file tree'} onClick={onBack}>
            <ArrowLeft size={15} />
          </IconButton>
        ))}
      {tabs.map(tab => {
        const active = tab.path === activePath
        const name = tab.path.split('/').pop() ?? tab.path
        const iconId = fileIconId(tab.path, 'file')
        return (
          <span
            role="listitem"
            key={tab.path}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
              borderRadius: 6, background: active ? 'var(--bg-elevated)' : 'transparent',
            }}
          >
            <button
              type="button"
              ref={active ? activeTabRef : undefined}
              aria-current={active ? 'true' : undefined}
              // The dot beside the name is colour only, so the unsaved state is SAID as well —
              // appended to the visible name rather than replacing it, so the accessible name still
              // contains the words on screen.
              aria-label={tab.dirty ? `${name} — ${pt ? 'não salvo' : 'unsaved'}` : name}
              title={tab.path}
              onClick={() => onSelect(tab.path)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                boxSizing: 'border-box', maxWidth: 190,
                minHeight: isMobile ? 44 : undefined,
                padding: isMobile ? '0 6px 0 9px' : '3px 5px 3px 8px',
                background: 'transparent', border: 'none', borderRadius: 6,
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                fontSize: isMobile ? 13 : 11.5,
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              {/* Unsaved, said in a way that survives a column too narrow for words. */}
              <span
                aria-hidden="true"
                data-dirty={tab.dirty}
                style={{
                  width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                  background: tab.dirty ? 'var(--anthropic-orange)' : 'transparent',
                }}
              />
              {/* THE EXTENSION ICON, before the name — the same `fileIcon.tsx` glyph the tree draws.
                  On the ACTIVE tab it draws in `fileIconHueOnActiveTab`'s colour rather than the
                  default `HUE`: this tab's own background is `--bg-elevated`, a ground eight of the
                  twenty-seven hues do not clear at `MIN_UI_CONTRAST` (see that function's own
                  comment for the measurement) — an INACTIVE tab is transparent and sits on the same
                  backdrop the tree already draws on, so it takes the ordinary default. */}
              <span aria-hidden="true" style={{ flexShrink: 0, display: 'inline-flex' }}>
                <FileIcon
                  name={tab.path}
                  kind="file"
                  size={14}
                  {...(active ? { hue: fileIconHueOnActiveTab(iconId) } : {})}
                />
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
              {active && agentHere && (
                <span
                  role="img"
                  aria-label={pt ? 'O agente está editando este arquivo agora' : 'The agent is editing this file right now'}
                  title={pt ? 'O agente está editando este arquivo agora' : 'The agent is editing this file right now'}
                  style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--accent-green, #22c55e)',
                  }}
                />
              )}
            </button>
            <IconButton
              label={pt ? `Fechar ${name}` : `Close ${name}`}
              onClick={() => onClose(tab.path)}
            >
              <X size={12} />
            </IconButton>
          </span>
        )
      })}
    </div>
  )
}

/**
 * A control in the toolbar: a word, so the label is what makes it wide enough for a finger — unless
 * `showLabel` is `false` (`studioToolbarFit`'s own `treeLabels`), in which case only the glyph
 * paints and the label survives as `title`/`aria-label` instead — never dropped outright, since an
 * icon with no accessible name is a control a screen reader cannot announce at all. On mobile an
 * icon-only button still reads at 44px through `.ag-tap-icon`'s invisible box
 * (`--ag-tap-grow`), the same technique `IconButton` below already uses, rather than a literally
 * painted square.
 */
function BarButton({ label, icon, isMobile, disabled, showLabel = true, onClick }: {
  label: string
  icon: ReactNode
  isMobile: boolean
  /** A control that cannot act yet SAYS so rather than failing silently — `NewFileRow`'s confirm. */
  disabled?: boolean
  showLabel?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={showLabel ? undefined : 'ag-tap-icon'}
      disabled={disabled === true}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: showLabel ? 5 : 0,
        flexShrink: 0, boxSizing: 'border-box',
        // 44px of HEIGHT only when labelled: the label is what makes it wide enough for a finger,
        // and a 44px box painted around a labelled control is what `touchTarget.lint.test.ts`
        // refuses. Icon-only relies on `.ag-tap-icon`'s own invisible grow instead — the same rule
        // `IconButton` already follows, so the touch target never depends on `showLabel`.
        minHeight: showLabel && isMobile ? 44 : undefined,
        width: showLabel ? undefined : (isMobile ? 22 : 20),
        height: showLabel ? undefined : (isMobile ? 22 : 20),
        padding: showLabel ? (isMobile ? '0 12px' : '3px 9px') : 0,
        borderRadius: 6, border: '1px solid var(--border-subtle)',
        background: 'transparent', fontFamily: 'inherit',
        fontSize: isMobile ? 13 : 11.5, color: 'var(--text-secondary)',
        cursor: disabled === true ? 'not-allowed' : 'pointer',
        opacity: disabled === true ? 0.45 : 1,
        ...(showLabel ? {} : { ['--ag-tap-grow' as string]: '11px' }),
      }}
    >
      {icon}
      {showLabel && label}
    </button>
  )
}

/**
 * An icon-only control: PAINTED small, TARGETED at 44px by `.ag-tap-icon`'s invisible box — the
 * repo's rule, and the reason a 13px glyph here is not a 44x44 square on a phone.
 *
 * A review minor (`session-w1c-tree-ops-review.md`): the CLASS was there, but `.ag-tap-icon`'s
 * DEFAULT grow (7px a side) around a 22px button only reaches 36px, 8px short of the floor this
 * doc comment already claimed. `--ag-tap-grow: 11px` is what a 22px control actually needs to clear
 * 44 (`22 + 2×11`) — set here, on this one control, rather than raised for every `.ag-tap-icon` in
 * the app, most of which sit on a larger painted button and do not need it.
 */
function IconButton({ label, onClick, disabled, pressed, children }: {
  label: string
  onClick: () => void
  disabled?: boolean
  /** A TOGGLE says which of its two states it is in; a plain action has none and omits this. */
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <button
      className="ag-tap-icon"
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled === true}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, flexShrink: 0, boxSizing: 'border-box',
        padding: 0, background: 'transparent', border: 'none', borderRadius: 6,
        cursor: disabled === true ? 'not-allowed' : 'pointer',
        color: 'var(--text-tertiary)', opacity: disabled === true ? 0.45 : 1,
        ['--ag-tap-grow' as string]: '11px',
      }}
    >
      {children}
    </button>
  )
}

// The Studio's own header row is gone (§2) — the tree controls (collapse toggle, flip-side) and
// close it used to carry as separate bordered pills now render as ROWS of the gear menu
// (`studioGearEntries`, above, plus the `gearAction` map in `Studio` itself); full screen is a
// FIXED BUTTON since 2026-09-19, not a row (see `fixedControls`). Both the gear and the fixed
// button go through `bandControls.tsx`'s `PanelFixedControls` — the SAME cluster every other
// panel's own bar now renders, so this reads as one control language across all five rather than
// the Studio's own local one. A local `LabeledIconButton` used to live here before that, agreeing
// on height with the band's own `labeledBtn` but not on border/background (a ghost button beside
// bordered pills) — see that shared file's header for the fuller history.
