/**
 * nayDock.ts — PURE: the Nay chat's geometry and WHERE a session opens.
 *
 * The chat is a docked panel (opened beside the chat button wherever it was dragged, `anchorDock`,
 * and resizable by the edges facing away from it) plus any number of
 * DETACHED windows, each holding one session. The rule the owner asked for: picking a session opens
 * it where it already is. If a window holds it, that window is raised and restored; otherwise it
 * opens inside the panel. One session is never on screen twice, because two composers typing into
 * one pane is the duplicate-send defect `SessionPanel` keys itself against.
 */

export interface Size { w: number; h: number }
export interface Viewport { w: number; h: number }

export interface NayWindow {
  id: string
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  /** Stacking order: the higher the number, the nearer the front. */
  z: number
}

export interface DockState {
  open: boolean
  /** The session shown inside the docked panel, or null for the tab list. */
  panelSession: string | null
  windows: NayWindow[]
}

export const PANEL_MIN: Size = { w: 360, h: 480 }
/** Tall enough for an approval card and the composer together — measured at 620 the card clipped. */
export const PANEL_DEFAULT: Size = { w: 480, h: 720 }
/** The panel sits this far from the right and bottom edges; the rest is its room to grow. */
export const PANEL_MARGIN = { right: 24, bottom: 80, top: 16, left: 16 }
export const WINDOW_DEFAULT: Size = { w: 460, h: 560 }

/** Clamp a panel size into what the viewport can hold, never below the minimum. */
export function clampPanelSize(size: Size, vp: Viewport): Size {
  const maxW = Math.max(PANEL_MIN.w, vp.w - PANEL_MARGIN.right - PANEL_MARGIN.left)
  const maxH = Math.max(PANEL_MIN.h, vp.h - PANEL_MARGIN.bottom - PANEL_MARGIN.top)
  return {
    w: Math.round(Math.min(maxW, Math.max(PANEL_MIN.w, size.w))),
    h: Math.round(Math.min(maxH, Math.max(PANEL_MIN.h, size.h))),
  }
}

/**
 * A drag on the panel's resize handles. The panel is anchored to the bottom-right corner, so pulling
 * the LEFT edge left (negative dx) widens it and pulling the TOP edge up (negative dy) heightens it.
 */
export function resizePanel(start: Size, dx: number, dy: number, edges: { left: boolean; top: boolean }, vp: Viewport): Size {
  return clampPanelSize({
    w: edges.left ? start.w - dx : start.w,
    h: edges.top ? start.h - dy : start.h,
  }, vp)
}

const topZ = (windows: readonly NayWindow[]) => windows.reduce((m, w) => Math.max(m, w.z), 0)

/**
 * Open a session: RAISE its window if one holds it (restoring a minimized one), otherwise show it
 * in the panel and open the panel.
 */
export function openSession(state: DockState, id: string): DockState {
  const win = state.windows.find(w => w.id === id)
  if (win) {
    const z = topZ(state.windows) + 1
    return { ...state, windows: state.windows.map(w => (w.id === id ? { ...w, minimized: false, z } : w)) }
  }
  return { ...state, open: true, panelSession: id }
}

/** Move the panel's session into a window of its own, cascaded so windows never stack exactly. */
export function detachSession(state: DockState, id: string, vp: Viewport): DockState {
  if (state.windows.some(w => w.id === id)) return openSession(state, id)
  const n = state.windows.length
  const size = { w: Math.min(WINDOW_DEFAULT.w, vp.w - 32), h: Math.min(WINDOW_DEFAULT.h, vp.h - 32) }
  const x = Math.max(16, Math.min(vp.w - size.w - 16, Math.round((vp.w - size.w) / 2) + n * 28))
  const y = Math.max(16, Math.min(vp.h - size.h - 16, Math.round((vp.h - size.h) / 3) + n * 28))
  return {
    ...state,
    panelSession: state.panelSession === id ? null : state.panelSession,
    windows: [...state.windows, { id, x, y, ...size, minimized: false, z: topZ(state.windows) + 1 }],
  }
}

/** Bring a window's session back into the panel. */
export function dockSession(state: DockState, id: string): DockState {
  return { open: true, panelSession: id, windows: state.windows.filter(w => w.id !== id) }
}

export function minimizeWindow(state: DockState, id: string): DockState {
  return { ...state, windows: state.windows.map(w => (w.id === id ? { ...w, minimized: true } : w)) }
}

export function closeWindow(state: DockState, id: string): DockState {
  return { ...state, windows: state.windows.filter(w => w.id !== id) }
}

/** Move/resize a window, kept on screen by at least its header. */
export function placeWindow(state: DockState, id: string, next: Partial<Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>, vp: Viewport): DockState {
  return {
    ...state,
    windows: state.windows.map(w => {
      if (w.id !== id) return w
      const width = Math.max(320, Math.min(vp.w, next.w ?? w.w))
      const height = Math.max(240, Math.min(vp.h, next.h ?? w.h))
      const x = Math.max(80 - width, Math.min(vp.w - 80, next.x ?? w.x))
      const y = Math.max(0, Math.min(vp.h - 40, next.y ?? w.y))
      return { ...w, x, y, w: width, h: height }
    }),
  }
}

/**
 * Forget sessions that are gone (a window over a session nobody can find any more would show an
 * empty frame forever). `known` answers whether an id still names a row.
 */
export function pruneDock(state: DockState, known: (id: string) => boolean): DockState {
  const windows = state.windows.filter(w => known(w.id))
  const panelSession = state.panelSession && known(state.panelSession) ? state.panelSession : null
  if (windows.length === state.windows.length && panelSession === state.panelSession) return state
  return { ...state, windows, panelSession }
}

/** Read a stored dock state, tolerating anything malformed — it is a per-viewer convenience. */
export function parseDockState(raw: unknown): Pick<DockState, 'windows'> {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { windows?: unknown }).windows)) return { windows: [] }
  const windows = ((raw as { windows: unknown[] }).windows).flatMap(v => {
    if (typeof v !== 'object' || v === null) return []
    const w = v as Record<string, unknown>
    const num = (k: string) => (typeof w[k] === 'number' && Number.isFinite(w[k]) ? w[k] as number : null)
    const [x, y, ww, hh, z] = [num('x'), num('y'), num('w'), num('h'), num('z')]
    if (typeof w.id !== 'string' || !w.id || x === null || y === null || ww === null || hh === null) return []
    return [{ id: w.id, x, y, w: ww, h: hh, z: z ?? 1, minimized: w.minimized === true }]
  })
  return { windows }
}

/** The count on the chat button when windows are minimized: nothing at zero, a cap past nine. */
export function minimizedBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return count > 9 ? '9+' : String(Math.floor(count))
}

export interface MenuPlacement { vertical: 'above' | 'below'; horizontal: 'left' | 'right' }

/** Room the list needs on its preferred side before it flips to the other one. */
export const MENU_MIN_ABOVE = 240

/**
 * Which way the minimized list opens from the chat button — the SAME rule as the dock
 * (`anchorDock`), so the two never open in opposite directions from one button: toward the
 * vertical half of the screen with more room (up from a button in the lower half, down from one in
 * the upper half), falling back to the other side when the preferred one cannot hold the list, and
 * growing leftward from a button in the right half, rightward from one in the left half — unless
 * that would leave the screen.
 */
export function menuPlacement(anchor: { top: number; bottom: number; left: number; right: number }, vp: Viewport, menuWidth: number): MenuPlacement {
  const roomAbove = anchor.top
  const roomBelow = vp.h - anchor.bottom
  const lowerHalf = (anchor.top + anchor.bottom) / 2 > vp.h / 2
  let vertical: MenuPlacement['vertical'] = lowerHalf ? 'above' : 'below'
  const preferredRoom = vertical === 'above' ? roomAbove : roomBelow
  const otherRoom = vertical === 'above' ? roomBelow : roomAbove
  if (preferredRoom < MENU_MIN_ABOVE && otherRoom > preferredRoom) vertical = vertical === 'above' ? 'below' : 'above'
  const rightHalf = (anchor.left + anchor.right) / 2 > vp.w / 2
  let horizontal: MenuPlacement['horizontal'] = rightHalf ? 'right' : 'left'
  if (horizontal === 'right' && anchor.right - menuWidth < 8) horizontal = 'left'
  if (horizontal === 'left' && anchor.left + menuWidth > vp.w - 8) horizontal = 'right'
  return { vertical, horizontal }
}

// ---------------------------------------------------------------------------------------------
// THE DOCK FOLLOWS THE BUTTON (owner, 2026-09-30). The chat button can be dragged anywhere, and the
// docked panel used to open at its fixed bottom-right place regardless — so a button moved to the
// top-left opened a panel on the far side of the screen from the hand that clicked it.

export interface AnchorRect { x: number; y: number; w: number; h: number }

export interface DockPlacement {
  left: number
  top: number
  w: number
  h: number
  /** Which way the panel grows when resized: the edges facing AWAY from the button carry the handles. */
  grow: { x: 'left' | 'right'; y: 'up' | 'down' }
}

/** Space between the button and the panel it opens. */
export const DOCK_GAP = 10
/** Nothing is placed closer than this to the window's edge. */
export const DOCK_MARGIN = 16

/**
 * Where the docked panel opens for a button at `btn`. Pure: every input is a number.
 *
 *  - It opens ABOVE a button in the lower half of the screen and BELOW one in the upper half, and
 *    takes the other side only when the preferred one cannot hold `PANEL_MIN.h`.
 *  - It is aligned to the button's outer edge: its right edge on the button's right edge for a
 *    button in the right half (growing leftward), its left edge on the button's left edge otherwise.
 *  - When neither side above nor below can hold the minimum height, it opens BESIDE the button.
 *  - It is always clamped inside the window, and it never covers the button: above/below and beside
 *    are separated from it by `DOCK_GAP` on the axis they share.
 *  - `want` is the person's stored size; it is only ever SHRUNK to fit here, never saved shrunk.
 */
export function anchorDock(btn: AnchorRect, want: Size, vp: Viewport, margin = DOCK_MARGIN, gap = DOCK_GAP): DockPlacement {
  return placeDock(btn, want, vp, dockSides(btn, vp), margin, gap)
}

/** Which halves of the screen the button is in — the input every placement decision starts from. */
export interface DockSides { right: boolean; lower: boolean }

/** How far past a midline the button must travel before the dock changes sides. */
export const DOCK_SIDE_HYSTERESIS = 16

/**
 * The halves the button is in, with HYSTERESIS against the previous answer: while the dock follows a
 * dragged button, a button resting ON a midline would otherwise flip the dock between sides on
 * every pixel of jitter. Without `prev` it is the plain midpoint test.
 */
export function dockSides(btn: AnchorRect, vp: Viewport, prev?: DockSides, hyst = DOCK_SIDE_HYSTERESIS): DockSides {
  const cx = btn.x + btn.w / 2, cy = btn.y + btn.h / 2
  if (!prev) return { right: cx > vp.w / 2, lower: cy > vp.h / 2 }
  return {
    right: prev.right ? cx > vp.w / 2 - hyst : cx > vp.w / 2 + hyst,
    lower: prev.lower ? cy > vp.h / 2 - hyst : cy > vp.h / 2 + hyst,
  }
}

/** `anchorDock` with the halves already decided — see `dockSides`. */
export function placeDock(btn: AnchorRect, want: Size, vp: Viewport, sides: DockSides, margin = DOCK_MARGIN, gap = DOCK_GAP): DockPlacement {
  const btnRight = btn.x + btn.w, btnBottom = btn.y + btn.h
  const rightHalf = sides.right
  const lowerHalf = sides.lower
  const fitW = Math.max(0, Math.min(want.w, vp.w - 2 * margin))
  const roomAbove = btn.y - gap - margin
  const roomBelow = vp.h - btnBottom - gap - margin
  const minH = Math.min(PANEL_MIN.h, want.h)

  const vertical: 'up' | 'down' | null =
    (lowerHalf ? roomAbove : roomBelow) >= minH ? (lowerHalf ? 'up' : 'down')
      : (lowerHalf ? roomBelow : roomAbove) >= minH ? (lowerHalf ? 'down' : 'up')
        : null

  if (vertical) {
    const h = Math.min(want.h, vertical === 'up' ? roomAbove : roomBelow)
    const top = vertical === 'up' ? btn.y - gap - h : btnBottom + gap
    const rawLeft = rightHalf ? btnRight - fitW : btn.x
    const left = Math.min(Math.max(margin, rawLeft), Math.max(margin, vp.w - margin - fitW))
    return { left, top, w: fitW, h, grow: { x: rightHalf ? 'left' : 'right', y: vertical } }
  }

  // BESIDE the button: toward the horizontal half with more room.
  const roomLeft = btn.x - gap - margin
  const roomRight = vp.w - btnRight - gap - margin
  const minW = Math.min(PANEL_MIN.w, want.w)
  const preferredRoom = rightHalf ? roomLeft : roomRight
  const toLeft = preferredRoom >= minW ? rightHalf : roomLeft > roomRight
  const w = Math.max(0, Math.min(want.w, toLeft ? roomLeft : roomRight))
  const h = Math.max(0, Math.min(want.h, vp.h - 2 * margin))
  const left = toLeft ? btn.x - gap - w : btnRight + gap
  const rawTop = lowerHalf ? btnBottom - h : btn.y
  const top = Math.min(Math.max(margin, rawTop), Math.max(margin, vp.h - margin - h))
  return { left, top, w, h, grow: { x: toLeft ? 'left' : 'right', y: lowerHalf ? 'up' : 'down' } }
}

/**
 * A drag on one of the anchored panel's resize handles. The handles sit on the edges facing away
 * from the button, so pulling a `left`-growing edge left (negative dx) widens it and pulling an
 * `up`-growing edge up (negative dy) heightens it — and the mirror for `right`/`down`.
 */
export function resizeAnchored(start: Size, dx: number, dy: number, handle: { x?: 'left' | 'right'; y?: 'up' | 'down' }, vp: Viewport): Size {
  return clampPanelSize({
    w: handle.x === 'left' ? start.w - dx : handle.x === 'right' ? start.w + dx : start.w,
    h: handle.y === 'up' ? start.h - dy : handle.y === 'down' ? start.h + dy : start.h,
  }, vp)
}
