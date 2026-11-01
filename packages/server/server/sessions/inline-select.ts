/**
 * inline-select.ts — PURE. A dialog whose options sit SIDE BY SIDE on one row, and whose highlight is
 * drawn in COLOUR only.
 *
 * opencode 1.19.5's permission prompt (`△ Permission required`), captured under tmux on 2026-10-31
 * (leader/qa/opencode-wp-a-probe/out2 + out3):
 *
 *     ┃   Allow once   Allow always   Reject                    ctrl+f fullscreen  ⇆ select  enter confirm
 *
 * Neither reader in `dialog-choice.ts` can see it: there is no number to type and no cursor glyph — the
 * highlighted option is the one drawn on the accent BACKGROUND, so in a plain `capture-pane -p` every
 * position reads byte-identical (the four frames of a full Right cycle were the same 412 bytes). So:
 *
 * - the OPTIONS are read off the plain row (the segments before the footer's hints, split on runs of 3+
 *   spaces), which is all the card needs to list them;
 * - WHICH ONE IS HIGHLIGHTED is read off an ANSI capture (`capture-pane -e`): the option whose background
 *   differs from every other option's. Compared, never matched against a colour — the accent is the
 *   user's theme, the difference is the widget;
 * - the widget is a RING (measured: Right three times from the first lands on the first again, Left four
 *   times lands on the last), so a pick is `(target - current) mod n` presses of `next`, and the caller
 *   LOOKS again before it confirms, the rule `sendMoveChoice` keeps.
 *
 * Every function is TOTAL and answers `null` for anything it does not positively recognise.
 */

export interface InlineSelectSpec {
  /** The footer that says THIS dialog is open, matched on the row itself. */
  footer: RegExp
  /** The hints at the end of the row, cut off before the options are split. Anchored at the end. */
  hints: RegExp
  /** The key that moves the highlight one option forward (the widget wraps). */
  next: string
  probed: string
}

/** How many of the last lines the row may sit in (it is the dialog's own bottom row, above one bar). */
const ROW_LINES = 4

/** The left bar opencode draws every block behind (see `dialog-choice.ts`'s `LEFT_BAR`). */
const LEFT_BAR = /^\s*┃/

/** Index of the dialog row in a frame, or -1. Only the last `ROW_LINES` non-blank lines are looked at. */
function rowIndex(frame: readonly string[], spec: InlineSelectSpec, plain: (l: string) => string = l => l): number {
  let seen = 0
  for (let i = frame.length - 1; i >= 0 && seen < ROW_LINES; i--) {
    const line = plain(frame[i] ?? '')
    if (line.replace(LEFT_BAR, '').trim() === '') continue
    seen++
    if (spec.footer.test(line)) return i
  }
  return -1
}

/** The option labels on the dialog row, in order — `null` unless there are at least two. */
export function readInlineOptions(frame: readonly string[], spec: InlineSelectSpec): string[] | null {
  return readInlineRow(frame, spec)?.labels ?? null
}

/** The dialog row's index in the frame and its labels — `null` unless there are at least two. */
export function readInlineRow(frame: readonly string[], spec: InlineSelectSpec): { at: number; labels: string[] } | null {
  const at = rowIndex(frame, spec)
  if (at < 0) return null
  const line = (frame[at] ?? '').replace(LEFT_BAR, '')
  const m = spec.hints.exec(line)
  if (!m) return null
  const labels = line.slice(0, m.index).trim().split(/\s{3,}/).map(s => s.trim()).filter(Boolean)
  return labels.length >= 2 ? { at, labels } : null
}

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g

/** The SGR background in force after a parameter list, given the previous one. */
function nextBackground(params: string, prev: string): string {
  if (params === '' || params === '0') return 'default'
  const p = params.split(';')
  let bg = prev
  for (let i = 0; i < p.length; i++) {
    const n = Number(p[i])
    if (n === 0) bg = 'default'
    else if (n === 49) bg = 'default'
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = String(n)
    else if (n === 48 && p[i + 1] === '2') { bg = `rgb:${p[i + 2]};${p[i + 3]};${p[i + 4]}`; i += 4 }
    else if (n === 48 && p[i + 1] === '5') { bg = `idx:${p[i + 2]}`; i += 2 }
    else if (n === 38 && p[i + 1] === '2') i += 4
    else if (n === 38 && p[i + 1] === '5') i += 2
  }
  return bg
}

/** A line with its SGR escapes removed, and the background in force at each visible character. */
function decode(line: string): { text: string; bg: string[] } {
  let text = ''
  const bg: string[] = []
  let cur = 'default'
  let last = 0
  for (const m of line.matchAll(SGR)) {
    const chunk = line.slice(last, m.index)
    for (const ch of chunk) { text += ch; bg.push(cur) }
    cur = nextBackground(m[1]!, cur)
    last = m.index! + m[0].length
  }
  for (const ch of line.slice(last)) { text += ch; bg.push(cur) }
  return { text, bg }
}

/**
 * Which option is highlighted, as a 0-based index into `readInlineOptions` — from an ANSI frame. `null`
 * when the row is not there, the labels differ from `labels`, or not exactly ONE option stands out.
 */
export function readInlineSelected(ansi: readonly string[], spec: InlineSelectSpec, labels: readonly string[]): number | null {
  const at = rowIndex(ansi, spec, l => decode(l).text)
  if (at < 0) return null
  const { text, bg } = decode(ansi[at] ?? '')
  const backgrounds: string[] = []
  let from = 0
  for (const label of labels) {
    const i = text.indexOf(label, from)
    if (i < 0) return null
    backgrounds.push(bg[i] ?? 'default')
    from = i + label.length
  }
  const counts = new Map<string, number>()
  for (const b of backgrounds) counts.set(b, (counts.get(b) ?? 0) + 1)
  const odd = backgrounds.map((b, i) => [b, i] as const).filter(([b]) => counts.get(b) === 1)
  // Exactly one option on a background no other option shares, and the rest all on one background.
  if (odd.length !== 1 || counts.size !== 2) return null
  return odd[0]![1]
}

/** How many `next` presses take a ring of `n` options from `from` to `to` (0-based). */
export function inlineSteps(from: number, to: number, n: number): number {
  return ((to - from) % n + n) % n
}
