/**
 * TreeContextMenu — the right-click menu on a tree row, and the `⋯` button that opens the same
 * menu without a pointer (hover/focus on desktop, always visible at 44px on a phone — there is no
 * long-press here, because one collides with scrolling and with selecting the row's own text).
 *
 * A PORTAL, the same posture `SessionRowMenu.tsx` already takes for exactly the same reasons: it
 * must escape the tree's own `overflow: auto` clipping, it is positioned at the pointer (or at the
 * button that opened it) and flipped rather than clamped when it would run off the viewport edge —
 * a menu pinned to the screen's corner would cover the very row it belongs to — and it closes on an
 * outside `mousedown`, on `Escape`, and after any entry is taken.
 *
 * **KEYBOARD (I4, `session-w1c-tree-ops-review.md`).** Opening the menu — by any route: a
 * right-click, Shift+F10 (which Firefox and Chrome both turn into a native `contextmenu` event when
 * a focused element is right-clicked, so this component never has to detect the chord itself), or a
 * click/Enter/Space on the row's own `⋯` button — moves focus onto the FIRST item, which is also
 * what makes Tab reach the menu rather than the next tree row: focus starts inside it, so the very
 * next Tab moves between two menu buttons that are contiguous in the DOM (the portal renders them
 * together), never out to whatever sits after the `⋯` button in the tree. ArrowUp/ArrowDown roves
 * between items (wrapping at both ends — `nextMenuIndex`, exported and pure so this arithmetic is
 * testable without a portal), Home/End jump to the first/last, and Tab/Shift+Tab from the last/first
 * item wrap back around rather than leaving the menu to whatever follows the portal in the document.
 *
 * **RETURNING FOCUS TO THE ROW IS THE CALLER'S JOB, DELIBERATELY NOT THIS COMPONENT'S.** A naive
 * "restore `document.activeElement` as it was on mount" is wrong here in a way it is not for
 * `SessionRowMenu`: picking "Renomear" swaps the whole row for `RenamingRow` in the SAME render pass
 * that closes this menu, so the button this component would try to refocus is already gone, and the
 * rename input's own `autoFocus` must be left alone rather than fought over. Only `RepoTreeView`
 * knows which of "focus the row's button", "let the rename input keep it" or "the row is gone,
 * there is nothing to return to" applies, so it owns `onClose` and does the restoring itself.
 *
 * **THIS COMPONENT DECIDES NOTHING ABOUT WHAT AN ACTION DOES.** It renders a fixed ORDER of
 * entries and reports which one was picked; `RepoTreeView` and, above it, `Studio.tsx` own every
 * rule about create/rename/delete/move. That split is what `treeMenuEntries` exists to test on its
 * own — which entries exist for a file versus a folder, and the one entry that can be absent.
 *
 * **`onMention` IS THE ONE OPTIONAL HANDLER, AND ITS ABSENCE REMOVES THE ROW RATHER THAN GREYING
 * IT.** "Mencionar na conversa" (§6) is wired in by `Studio.tsx`, which always supplies a handler —
 * kept optional here (rather than required) because a disabled row with no explanation would read as
 * a bug report waiting to be filed, while an absent row is simply a menu that does not offer
 * something nobody can use; a future caller that has no conversation to mention into is free to omit
 * it the same way.
 */

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../hooks/useIsMobile'

export type TreeMenuAction =
  | 'new-file' | 'new-folder' | 'rename' | 'move' | 'copy-relative-path' | 'copy-path'
  | 'mention' | 'delete'

export interface TreeMenuEntry {
  action: TreeMenuAction
  label: string
}

/**
 * The fixed order this menu draws in, for one row — the order the design states verbatim: create
 * (scoped to the row — a folder's own contents, or the row's own parent for a file), rename, move,
 * the two copy actions, mention, delete last (destructive actions read last, everywhere else in
 * this product's menus).
 *
 * **Exported and pure so the "one item, one condition" rule is testable without a portal, a pointer
 * or a render at all.** `mentionAvailable` mirrors the prop it is named after — see the file header.
 */
export function treeMenuEntries(
  kind: 'file' | 'dir', lang: 'pt' | 'en', mentionAvailable: boolean, copyPathAvailable: boolean,
): TreeMenuEntry[] {
  const pt = lang === 'pt'
  const entries: TreeMenuEntry[] = [
    { action: 'new-file', label: pt ? 'Novo arquivo' : 'New file' },
    { action: 'new-folder', label: pt ? 'Nova pasta' : 'New folder' },
    { action: 'rename', label: pt ? 'Renomear' : 'Rename' },
    { action: 'move', label: pt ? 'Mover para…' : 'Move to…' },
    { action: 'copy-relative-path', label: pt ? 'Copiar caminho relativo' : 'Copy relative path' },
  ]
  if (copyPathAvailable) entries.push({ action: 'copy-path', label: pt ? 'Copiar caminho' : 'Copy path' })
  if (mentionAvailable) entries.push({ action: 'mention', label: pt ? 'Mencionar na conversa' : 'Mention in the conversation' })
  entries.push({
    action: 'delete',
    label: kind === 'dir' ? (pt ? 'Excluir pasta' : 'Delete folder') : (pt ? 'Excluir' : 'Delete'),
  })
  return entries
}

/**
 * Roving focus's own arithmetic, pulled out so it can be asserted without a DOM. `current === -1`
 * (nothing in the menu focused yet, e.g. Home/End pressed before any item was) resolves to a useful
 * item rather than to nothing: the first for a "forward" key, the last for a "backward" one.
 * `count === 0` answers `-1` — there is nothing to focus, and a caller must not act on that.
 */
export function nextMenuIndex(
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End', current: number, count: number,
): number {
  if (count === 0) return -1
  switch (key) {
    case 'Home': return 0
    case 'End': return count - 1
    case 'ArrowDown': return current === -1 ? 0 : (current + 1) % count
    case 'ArrowUp': return current === -1 ? count - 1 : (current - 1 + count) % count
  }
}

function menuButtons(container: HTMLElement | null): HTMLButtonElement[] {
  return container === null ? [] : Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
}

export interface TreeContextMenuProps {
  x: number
  y: number
  kind: 'file' | 'dir'
  lang: 'pt' | 'en'
  /** Absent removes the "Mencionar na conversa" row — see the file header. */
  onMention?: () => void
  /** Absent removes the "Copiar caminho" row — see `repoTreeModel.ts`'s own note on the two copies. */
  copyPath?: () => void
  onAction: (action: Exclude<TreeMenuAction, 'mention' | 'copy-path'>) => void
  onClose: () => void
}

export function TreeContextMenu({ x, y, kind, lang, onMention, copyPath, onAction, onClose }: TreeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const entries = treeMenuEntries(kind, lang, onMention !== undefined, copyPath !== undefined)

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  // Focus enters the menu the moment it exists — see the file header for why this alone is what
  // makes Tab reach it instead of the next tree row, however the menu was opened.
  useEffect(() => { menuButtons(ref.current)[0]?.focus() }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = menuButtons(ref.current)
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const next = nextMenuIndex(e.key, current, buttons.length)
      if (next >= 0) buttons[next]?.focus()
      return
    }
    // A basic focus trap: Tab off either end wraps rather than leaving the menu for whatever
    // follows the portal in the document — the portal is the LAST thing appended to `<body>`, so
    // without this a Tab from the last item would leave the page entirely rather than cycling.
    if (e.key === 'Tab') {
      if (!e.shiftKey && current === buttons.length - 1) { e.preventDefault(); buttons[0]?.focus() }
      else if (e.shiftKey && current === 0) { e.preventDefault(); buttons[buttons.length - 1]?.focus() }
    }
  }

  const pick = (action: TreeMenuAction) => {
    if (action === 'mention') { onMention?.(); onClose(); return }
    if (action === 'copy-path') { copyPath?.(); onClose(); return }
    onAction(action)
    onClose()
  }

  // Flipped rather than clamped — the same rule `SessionRowMenu` applies, for the same reason: a
  // menu pinned to the viewport's edge would sit on top of the row it is ABOUT.
  const w = 220
  const rowH = isMobile ? 44 : 32
  const left = typeof window === 'undefined' ? x
    : x + w > window.innerWidth ? Math.max(4, x - w) : x
  const top = typeof window === 'undefined' ? y
    : y + entries.length * rowH + 8 > window.innerHeight
      ? Math.max(4, y - (entries.length * rowH + 8))
      : y

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed', top, left, width: w, zIndex: 700,
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
        padding: 4, boxShadow: 'var(--ag-shadow-pop)',
      }}
    >
      {entries.map(e => (
        <button
          key={e.action}
          type="button"
          role="menuitem"
          onClick={() => pick(e.action)}
          style={{
            display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box',
            minHeight: isMobile ? 44 : 0,
            padding: '8px 10px', borderRadius: 7, border: 'none', textAlign: 'left',
            background: 'transparent', fontFamily: 'inherit', fontSize: 12.5,
            color: e.action === 'delete' ? 'var(--accent-red)' : 'var(--text-primary)',
            cursor: 'pointer',
          }}
          onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--bg-elevated)' }}
          onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
        >
          {e.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
