/**
 * liveAnswer.ts — PURE. The assistant's answer AS IT IS BEING WRITTEN, read off a CLI's screen.
 *
 * Why: Claude writes a message to its JSONL only once the message is FINISHED, so the transcript —
 * and the chat-stream that pushes it — can never show an answer growing; it lands whole. The screen
 * is the only place the text exists while it is typed (the terminal hub follows a changing frame
 * at 150 ms, PERF.1). Owner report on v2.103.1: "o stream da conversa do Claude não está
 * funcionando, vem tudo de uma vez" — the frame was read (`liveTurnText`) but only ever used to
 * keep the view scrolled, because the whole-screen reading once leaked a CLI's chrome into a
 * full-size bubble and was taken off the page.
 *
 * So this reads NARROWLY, which is what makes drawing it safe: only the LAST assistant block of
 * Claude Code's own screen — the line opened by `●` (or the older `⏺`) and its continuation, up to
 * the first line that is chrome (a rule, the spinner's status, a prompt caret, a box). Anything it
 * cannot recognise as that block yields `null` and nothing is drawn: a missing live bubble is what
 * the page did before, a bubble full of chrome is the defect that removed it. A tool call
 * (`● Bash(…)`, or a block whose next line is a `⎿` result) is not an answer. Other harnesses are
 * `null` until their screens are measured — guessing their chrome is that same leak.
 */
export interface LiveAnswerInput {
  /** The session's harness id, as the fleet row carries it. */
  harness: string
  /** The frame's lines, top to bottom, ANSI already stripped. */
  lines: readonly string[]
  /** False when the session is not working — a still screen is not an answer being written. */
  working: boolean
  /** The last COMPLETED assistant turn's text, so the screen still showing it is not drawn twice. */
  lastCommitted?: string
}

const BLOCK = /^[●⏺]\s?/
const TOOL_CALL = /^[A-Za-z_][\w-]*\(/
const RULE = /^[─━═╌┄┈╭╮╰╯┌┐└┘├┤│┃║]/
/** Claude Code's spinner status line: a spinner glyph, then a verb with an ellipsis. */
const SPINNER = /^[·✢✳✶✻✽✺⠁-⣿]\s.*…/
/** The spinner glyph once the turn is DONE: `✻ Worked for 10s · done 8:27 AM · 1 monitor still running` has no ellipsis. */
const STATUS_DONE = /^[✢✳✶✻✽✺*]\s+[A-Z][a-z]+(?:\s+for\s+\d|\b.*\b(?:done|still running)\b)/
const MONITORS = /\b\d+\s+(?:monitors?|shells?|background (?:tasks?|shells?))\s+(?:still\s+)?running\b/i
/** A collapsed tool group: `Running 1 shell command…`, `Reading 2 files…`. */
const TOOL_GROUP = /^(?:Running|Reading|Searching|Editing|Writing|Fetching|Listing)\s+\d+\s.*…$/
/** A collapsed tool header: `Bash cat >> /tmp/x …`. Needs the truncation mark so prose that opens with "Read" is untouched. */
const TOOL_HEADER = /^(?:Bash|Read|Write|Edit|MultiEdit|Grep|Glob|Task|Agent|WebFetch|WebSearch|NotebookEdit|TodoWrite)\s.*…\s*$/
const MODE_LINE = /^[⏵▶]{1,2}\s|^⏸\s/
const CARET = /^[>❯](\s|$)/
const HINT = /^\((?:esc|ctrl|shift|tab|enter)\b/i
const RESULT = /^⎿/

export function liveAnswerText(input: LiveAnswerInput): string | null {
  if (!input.working || input.harness !== 'claude') return null
  const lines = input.lines.map(l => l.replace(/\s+$/, ''))
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) if (BLOCK.test(lines[i]!.trim())) { start = i; break }
  if (start < 0) return null

  const head = lines[start]!.trim().replace(BLOCK, '')
  if (TOOL_CALL.test(head)) return null
  const kept: string[] = [head]  // continuation lines stay RAW: their indent says who wrapped them
  for (const line of lines.slice(start + 1)) {
    const t = line.trim()
    if (RESULT.test(t)) {
      // A `⎿` right under the block is the block's own tool result — the block was a call.
      if (kept.slice(1).every(k => k.trim() === '')) return null
      break
    }
    // The input box sits between two rules, so its caret is never reached: the rule ends the block
    // first. A caret reached here is the person's NEXT prompt in the history — the block above it
    // is an answer already given, and the new one has not started.
    if (CARET.test(t)) return null
    if (RULE.test(t) || SPINNER.test(t) || STATUS_DONE.test(t) || MONITORS.test(t) || TOOL_GROUP.test(t) ||
        TOOL_HEADER.test(t) || MODE_LINE.test(t) || HINT.test(t) || BLOCK.test(t)) break
    // Claude indents a block's continuation by two; a raw-mode program wrapped by the pane does not.
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
  const text = unwrap(kept).trim()
  if (text === '') return null
  if (input.lastCommitted && sameAnswer(input.lastCommitted, text)) return null
  return text
}

const STRUCTURAL = /^\s*(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s|>|\||```)/

/**
 * The pane breaks lines at ITS width; the transcript's text does not. A bubble that keeps those
 * breaks reads as a ragged poem, so lines of one paragraph are joined with a space. A blank line, a
 * list item, a heading, a quote, a table row or a fenced block keeps its own line.
 */
function unwrap(lines: readonly string[]): string {
  const out: string[] = []
  let fenced = false
  let joinable = false
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('```')) { fenced = !fenced; out.push(line.replace(/^ {1,2}/, '')); joinable = false; continue }
    if (fenced || t === '') { out.push(line.replace(/^ {1,2}/, '')); joinable = false; continue }
    // Only an INDENTED line is Claude's own wrapping at a word boundary; an unindented one comes
    // from a program the pane wrapped, possibly mid-word, so its break is kept rather than guessed.
    if (joinable && /^ {2}\S/.test(line) && !STRUCTURAL.test(line)) out[out.length - 1] += ' ' + t
    else { out.push(line.replace(/^ {1,2}/, '')); joinable = true }
  }
  return out.join('\n')
}

/**
 * Is `text` (read off the screen) the answer the transcript already holds? Compared normalised, and
 * on the FIRST characters when the screen text is long: whatever the pane drew differently from the
 * markdown (a rendered list marker, a table) sits later than the opening, and a mismatch there kept
 * the live bubble beside the finished turn for the whole hold.
 */
export function sameAnswer(committed: string, text: string): boolean {
  const c = collapse(committed)
  const t = collapse(text)
  if (t === '') return false
  return c.startsWith(t) || (t.length >= 40 && c.startsWith(t.slice(0, 40)))
}

/**
 * Compared with NO whitespace at all and WITHOUT markdown marks. The pane wraps where the transcript
 * does not — and a hard wrap falls MID-WORD (`lo` / `rem`), so even collapsing the newline into a
 * space leaves the two texts different. The transcript holds `**bold**` and `` `code` `` while the
 * screen draws them rendered. Either way a committed answer still on screen would read as a new one
 * and be drawn twice.
 */
function collapse(s: string): string {
  return s.replace(/[*_`#]/g, '').replace(/\s+/g, '')
}

/**
 * HOLDING the live answer until the finished turn is on screen.
 *
 * The live bubble is read off the screen, and the screen moves on first: the caret and the next
 * prompt are drawn the instant the answer is done, so `liveAnswerText` goes `null` — while the
 * finished turn travels another road (the transcript, its watcher, the chat-stream) and can land
 * seconds later on a loaded machine. Between the two the answer was ON NO SCREEN: it vanished and
 * came back (a CI browser measured the gap at ~3.7 s, or past its 8 s window). So once an answer
 * has been shown, it STAYS until the conversation says it has it — the committed answer starts with
 * the held text (same comparison as `liveAnswerText`'s own `lastCommitted`), or the turn list
 * changed (a turn landed, the person wrote something) — and never longer than `HOLD_MAX_MS` after
 * the screen last showed it, so an interrupted answer cannot stay forever.
 */
export const HOLD_MAX_MS = 20_000

export interface HeldLive { text: string; turns: number; seenAt: number }

export function holdLiveAnswer(
  held: HeldLive | null,
  live: string | null,
  turns: number,
  lastCommitted: string | undefined,
  now: number,
): { held: HeldLive | null; text: string | null } {
  // The screen still shows the answer AND the finished turn is on screen: never both.
  if (live && lastCommitted && sameAnswer(lastCommitted, live)) return { held: null, text: null }
  if (live) { const h = { text: live, turns, seenAt: now }; return { held: h, text: live } }
  if (!held) return { held: null, text: null }
  const landed = !!lastCommitted && sameAnswer(lastCommitted, held.text)
  if (landed || turns !== held.turns || now - held.seenAt >= HOLD_MAX_MS) return { held: null, text: null }
  return { held, text: held.text }
}
