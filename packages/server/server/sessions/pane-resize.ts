/**
 * pane-resize.ts — PURE. What a viewer's box may do to the pane behind it, and the one asymmetry
 * that makes this its own module.
 *
 * The complaint is ordinary: "a largura não tá indo até o final". A pane is created at a fixed
 * `PANE_COLS` x `PANE_ROWS` and `SessionTerminal` SCALES rather than reflows (the capture is already
 * hard-broken at the pane's own width, so reflowing scatters the text), which leaves a correct
 * 120-column terminal with dead margin beside it in a 1500px band. The fix is to resize the PANE,
 * not the rendering.
 *
 * **But the two panes are not equally free, and getting that wrong is expensive.**
 *
 * A SHELL's screen is read by nothing in this product: it exists for the person looking at it. So a
 * shell follows its box exactly, in both directions.
 *
 * An ASSISTANT's pane is read by `attention.ts`, `readDialog` and `approvalTail`, in the cockpit, in
 * the VS Code panel and in the web — all of them at once, for every viewer of that session.
 * `PANE_COLS`/`PANE_ROWS` are not a default: a 24-row pane redrew the top of an `AskUserQuestion`
 * off the screen, so the parsers could not find their anchor and the card could not say what the
 * session was asking. It was invisible from a terminal, because ATTACHING resizes the pane to the
 * client. So an assistant's pane may GROW — a wider pane is strictly better for those readers — and
 * may never shrink below that floor, however small the box asking is.
 *
 * STATED LIMIT, not solved here: a tmux pane has ONE size, so two viewers at different widths mean
 * the last to resize wins. That is already what happens with two attached tmux clients, so it is
 * not a new class of problem — but it is why this returns a plan for a CALLER to debounce rather
 * than something that runs on every frame.
 */

import { PANE_COLS, PANE_ROWS } from './tmux-cli'

export interface PaneGeometry { cols: number; rows: number }

/** The widest and tallest a pane may be asked for. A browser mid-layout can report anything. */
const MAX_COLS = 1000
const MAX_ROWS = 500

function sane(g: PaneGeometry): boolean {
  return Number.isInteger(g.cols) && Number.isInteger(g.rows)
    && g.cols > 0 && g.rows > 0 && g.cols <= MAX_COLS && g.rows <= MAX_ROWS
}

/**
 * The geometry a READER stated when it opened the stream, or `null` for "it said nothing".
 *
 * A pane has one size and the last viewer to ask wins, so a shell last read on a phone hands a
 * desktop its first frames hard-broken at 52 columns and the band snaps a quarter-second later,
 * once the emulator has measured itself and the debounced resize lands. Letting the reader state
 * the size on the way in closes that window — the pane is resized BEFORE the first capture.
 *
 * It is untrusted input arriving before the stream exists, so it is REFUSED rather than clamped:
 * a value nobody can read costs the caller its resize, never its stream. The ceiling is the same
 * one `resizePlan` holds, applied here so the plan is never asked a question it would only reject.
 */
export function readWantedGeometry(params: URLSearchParams): PaneGeometry | null {
  const read = (name: string): number | null => {
    const raw = params.get(name)
    if (!raw) return null
    // `Number` so `1.5` and `1e400` are read as themselves and then refused — `parseInt` would
    // truncate both into perfectly usable numbers nobody asked for.
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }
  const cols = read('cols')
  const rows = read('rows')
  if (cols === null || rows === null) return null
  const want = { cols, rows }
  return sane(want) ? want : null
}

/**
 * The geometry to apply, or `null` for "do nothing".
 *
 * `null` covers three different situations on purpose — the numbers are unusable, the clamp landed
 * back on what is already there, or nothing changed — because the caller's action is the same in
 * all three and inventing a distinction would only be a reason to spawn a process.
 */
export function resizePlan(o: {
  scope: 'fleet' | 'shell'
  want: PaneGeometry
  current: PaneGeometry
}): PaneGeometry | null {
  if (!sane(o.want)) return null
  const next: PaneGeometry = o.scope === 'shell'
    ? o.want
    // GROW ONLY. The floor is the whole reason this module exists — see the header.
    : { cols: Math.max(o.want.cols, PANE_COLS), rows: Math.max(o.want.rows, PANE_ROWS) }
  if (next.cols === o.current.cols && next.rows === o.current.rows) return null
  return next
}
