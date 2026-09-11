/**
 * terminalEndpoint.ts — PURE. Which routes a terminal channel talks to, decided in ONE place.
 *
 * There are two kinds of pane this dashboard reads and writes, and they are not interchangeable:
 * a FLEET row (an assistant's own screen, resolved against `managed-sessions.json`) and a SHELL
 * (the per-session utility terminal, resolved against `shells.json`, on its own tmux socket). The
 * routes are deliberately separate on the server — `/api/shell` is registered in
 * `capability-guard.ts` rather than riding the `/api/fleet` prefix, because "a shell is not a fleet
 * row, and filing it under that prefix would be the first step toward it becoming one".
 *
 * The client end of that same argument lives here. `useTerminalStream` and `useTerminalWrite` are
 * generic over the SCOPE and interpolate nothing themselves, so a shell id can never be handed to a
 * route that would resolve it against the session registry — and a test says so, over the strings
 * rather than over a comment.
 */

/** Which of the two channels an id belongs to. Never inferred from the id — an id is opaque. */
export type TerminalScope = 'fleet' | 'shell'

const BASE: Record<TerminalScope, string> = {
  fleet: '/api/fleet',
  shell: '/api/shell',
}

/** What a box can show at natural size — the pane's target geometry. */
export interface PaneGeometry { cols: number; rows: number }

function usable(g: PaneGeometry | undefined): g is PaneGeometry {
  return Boolean(g)
    && Number.isInteger(g!.cols) && Number.isInteger(g!.rows)
    && g!.cols > 0 && g!.rows > 0
}

/**
 * The SSE read channel for one pane, optionally stating the geometry the reader's box wants.
 *
 * A pane has ONE size and the last viewer to ask wins, so a shell opened on a phone and then on a
 * desktop starts at the phone's width: the first frames arrive hard-broken at 52 columns and the
 * band visibly snaps a quarter-second later, when the emulator has measured itself and the
 * debounced `POST /api/shell/resize` lands. Saying the size UP FRONT closes that window — the
 * server resizes before the first capture, so frame one is already right. It is a REQUEST, not a
 * promise: an assistant's pane may refuse to shrink below its floor, and the measured geometry
 * corrects a stale one moments later either way.
 *
 * A geometry that is not a pair of positive whole numbers is left off rather than sent and refused
 * — a browser mid-layout reports anything, and a query string is not the place to argue about it.
 */
export function streamUrl(scope: TerminalScope, id: string, want?: PaneGeometry): string {
  const base = `${BASE[scope]}/stream?id=${encodeURIComponent(id)}`
  return usable(want) ? `${base}&cols=${want.cols}&rows=${want.rows}` : base
}

/**
 * The WebSocket write channel for one pane.
 *
 * `protocol` and `host` are passed in rather than read off `window`, so the mapping is testable and
 * the module stays free of the DOM — the same split every other pure module here makes.
 */
export function inputWsUrl(scope: TerminalScope, id: string, protocol: string, host: string): string {
  const proto = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${host}${BASE[scope]}/input?id=${encodeURIComponent(id)}`
}
