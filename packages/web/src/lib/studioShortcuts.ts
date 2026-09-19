/**
 * studioShortcuts.ts — PURE: which keystroke means what, for the two global Studio shortcuts the
 * UX pass adds (items 8 and 11).
 *
 * `Ctrl+B` (`Cmd+B` on macOS) opens or closes the Studio wherever it currently lives; `Ctrl+Shift+F`
 * (`Cmd+Shift+F`) opens it and switches straight to a whole-tree content search. Both share ONE
 * matcher and ONE "should this even reach the Studio" gate, because the two questions — "which
 * shortcut is this" and "is this keystroke's target one the shortcut may steal from" — are answered
 * the same way for either of them: never from an ordinary text field (the chat composer, chief
 * among them), always from inside Monaco (handled separately — see the module header on why).
 *
 * NEITHER SHORTCUT CAN EVER COLLIDE WITH `Ctrl+F` (the browser's own find). `search` requires
 * `Shift`; `toggle` requires the letter `B`. A bare `Ctrl+F` matches neither, structurally — there
 * is no code path here that could be reached by it, which is a stronger guarantee than a comment
 * promising not to check for it.
 */

export type StudioShortcutId = 'toggle' | 'search'

/** The subset of `KeyboardEvent` this module reads — narrowed so a test can hand in a plain object
 *  rather than constructing a real DOM event. */
export interface ShortcutKeyInfo {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Which shortcut (if either) this keystroke names — a MOD key (`Ctrl` OR `Cmd`, never neither, and
 * an `Alt` chord is never one of these two, which keeps the door open for an OS-level accelerator
 * that happens to add `Alt`) plus the letter and `Shift` state that tells `toggle` from `search`.
 * `key` is compared case-insensitively: browsers report `B`/`b` depending on `Shift`, and `Shift` is
 * read from `shiftKey` directly rather than from the letter's case, which is what makes `Ctrl+Shift+B`
 * (an unclaimed combination) correctly answer neither rather than being misread as `toggle`.
 */
export function matchStudioShortcut(e: ShortcutKeyInfo): StudioShortcutId | null {
  const mod = e.ctrlKey || e.metaKey
  if (!mod || e.altKey) return null
  const key = e.key.toLowerCase()
  if (key === 'b' && !e.shiftKey) return 'toggle'
  if (key === 'f' && e.shiftKey) return 'search'
  return null
}

/** The subset of an `Element`/`EventTarget` this module reads. */
export interface ShortcutFocusTarget {
  tagName?: string
  isContentEditable?: boolean
}

/**
 * Is this DOM target an ORDINARY text field — the chat composer, chief among them — that a global
 * shortcut must never steal a keystroke from? Monaco's own surface is deliberately NOT tested for
 * here: it needs its own registered command regardless (Monaco swallows an unregistered keystroke
 * before a `document`-level listener ever sees it — see the design brief), so this function only
 * ever has to answer for the REST of the page.
 */
export function isTypingTarget(el: ShortcutFocusTarget | null | undefined): boolean {
  if (!el) return false
  const tag = (el.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true
}

/**
 * Should the GLOBAL (`document`-level) handler act on this keystroke at all?
 *
 * Pure composition of the two questions above, kept as its own function because it is the ONE
 * gate every caller must go through — a handler that inlined `matchStudioShortcut(e) &&
 * !isTypingTarget(e.target)` at its own call site is a second place that rule could be written
 * slightly differently the next time someone touches it.
 */
export function shouldHandleGlobally(
  e: ShortcutKeyInfo, target: ShortcutFocusTarget | null | undefined,
): StudioShortcutId | null {
  const shortcut = matchStudioShortcut(e)
  if (shortcut === null || isTypingTarget(target)) return null
  return shortcut
}
