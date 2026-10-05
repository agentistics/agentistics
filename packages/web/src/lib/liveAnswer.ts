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
  const kept: string[] = [head]
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
    if (RULE.test(t) || SPINNER.test(t) || HINT.test(t) || BLOCK.test(t)) break
    // Claude indents a block's continuation by two; a raw-mode program wrapped by the pane does not.
    kept.push(line.replace(/^ {1,2}/, ''))
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
  const text = kept.join('\n').trim()
  if (text === '') return null
  if (input.lastCommitted && collapse(input.lastCommitted).startsWith(collapse(text))) return null
  return text
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
