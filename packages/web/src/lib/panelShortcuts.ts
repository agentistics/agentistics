/**
 * panelShortcuts.ts — PURE: which keystroke means what, for the three VS-Code-style panel
 * shortcuts on the desktop Sessions workspace (floating-panels design, owner addition).
 *
 * `Ctrl+B` (`Cmd+B` on macOS) toggles the LEFT sessions list; `Ctrl+Shift+B` (`Cmd+Shift+B`)
 * toggles the RIGHT aside; `Ctrl+'` and `Ctrl+`` (both, so the owner's ABNT2 keyboard — where the
 * `'` key can report either code depending on layout — and a plain US layout both work) toggle the
 * BOTTOM band. One matcher, mirroring `studioShortcuts.ts`'s shape, because the two files answer
 * the identical two questions ("which shortcut is this" and "may this target's keystroke be
 * stolen") for a different set of combos.
 *
 * `Ctrl+B` COLLIDES WITH THE EXISTING STUDIO TOGGLE (`studioShortcuts.ts`'s `matchStudioShortcut`,
 * also bare `Ctrl`/`Cmd`+`B`, also scoped to the Sessions workspace with a session selected) — the
 * owner named this exact combo for the sessions list, so `App.tsx`'s wiring makes THIS module win
 * that combo in the workspace; see its own call site for the one-line guard this needs on the
 * Studio effect. `Ctrl+Shift+F` (Studio search) is untouched — it shares no combo with anything
 * here.
 *
 * THE TERMINAL EXCLUSION IS PER-SHORTCUT, NOT ALL-OR-NOTHING. `Ctrl+B` is readline's
 * backward-char and the tmux prefix, and `Ctrl+Shift+B` is nothing special to either but is grouped
 * with it here because both toggle a PANEL a terminal reader is unlikely to reach for mid-session —
 * so with focus inside a terminal (the xterm surface in the band, Shell or the session's own
 * pane), those two are left alone for the shell/tmux to interpret. `Ctrl+'`/`` Ctrl+` `` carry no
 * conflicting meaning in a shell and are explicitly how the owner closes the band FROM inside it,
 * so they fire regardless of where focus is.
 */

export type PanelShortcutId = 'toggle-left' | 'toggle-right' | 'toggle-band'

/** The subset of a keyboard event this module reads — narrowed so a test can hand in a plain
 *  object rather than constructing a real DOM `KeyboardEvent`. `code` is the LAYOUT-INDEPENDENT
 *  physical key (what makes the ABNT2 case work: its `'` key reports `Quote` in some browsers and
 *  `BracketLeft`-adjacent placements in others, but the owner's own keyboard was verified to report
 *  `Quote` — `key` is checked too as the fallback for a combo that reports neither known `code`).
 *  `platform` is carried for callers that need to render the right modifier glyph (`⌘` vs `Ctrl`);
 *  matching itself never branches on it — `ctrl` OR `meta` is accepted uniformly on every platform,
 *  since the owner asked for both to work everywhere rather than one per OS. */
export interface PanelShortcutInput {
  key: string
  code: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
  isComposing: boolean
  focusInTerminal: boolean
  platform?: 'mac' | 'other'
}

const QUOTE_CODES = new Set(['Quote', 'Backquote'])
const QUOTE_KEYS = new Set(["'", '`'])

/**
 * Which shortcut (if either) this keystroke names, with NO gating yet — see `shouldHandlePanelShortcut`
 * for the target/terminal/composition rules. A bare mod (`Ctrl` or `Cmd`, never neither) plus `Alt`
 * matches nothing, the same guard `studioShortcuts.ts` keeps, so an OS-level accelerator that adds
 * `Alt` is never misread as one of these.
 */
export function matchPanelShortcut(e: PanelShortcutInput): PanelShortcutId | null {
  if (e.isComposing) return null
  const mod = e.ctrl || e.meta
  if (!mod || e.alt) return null
  const key = e.key.toLowerCase()
  if (key === 'b') return e.shift ? 'toggle-right' : 'toggle-left'
  if (!e.shift && (QUOTE_CODES.has(e.code) || QUOTE_KEYS.has(key))) return 'toggle-band'
  return null
}

/** The subset of an `Element`/`EventTarget` this module reads — same shape `studioShortcuts.ts`
 *  already exports as `ShortcutFocusTarget`; re-declared here so this module has no import-time
 *  dependency on that one beyond the one helper it actually reuses. */
export interface PanelShortcutFocusTarget {
  tagName?: string
  isContentEditable?: boolean
}

function isOrdinaryTypingTarget(el: PanelShortcutFocusTarget | null | undefined): boolean {
  if (!el) return false
  const tag = (el.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true
}

/**
 * Should the workspace's global handler act on this keystroke — the one gate every caller goes
 * through. `toggle-left`/`toggle-right` are refused with focus inside a terminal OR an ordinary
 * text field (the composer, chief among them); `toggle-band` is refused for an ordinary text field
 * only — it is explicitly the way back OUT of a terminal, so it must keep working there.
 */
export function shouldHandlePanelShortcut(
  e: PanelShortcutInput, target: PanelShortcutFocusTarget | null | undefined,
): PanelShortcutId | null {
  const shortcut = matchPanelShortcut(e)
  if (shortcut === null) return null
  // The terminal's own input surface (xterm's hidden textarea) IS an ordinary `<textarea>` by tag,
  // so `focusInTerminal` — a fact the caller establishes by DOM ancestry, not by tag name — must be
  // checked FIRST: it is the more specific signal, and it is what lets `toggle-band` reach the
  // terminal at all despite the generic typing-target check below that would otherwise catch it.
  if (e.focusInTerminal) return shortcut === 'toggle-band' ? shortcut : null
  if (isOrdinaryTypingTarget(target)) return null
  return shortcut
}
