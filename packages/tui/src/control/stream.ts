/**
 * stream.ts — PURE conversion of a command's raw output into lines a pane can hold.
 *
 * The control center now watches its long commands from INSIDE the alternate screen: `docker
 * compose up --build`, `bun run bin`. Their output no longer goes to the terminal,
 * it goes into a framed pane Ink is composing — which means every byte has to be turned into
 * something with a known width and no way to move the cursor. That is what this module is for, and
 * it is deliberately pure: bytes in, lines out, no process, no Ink, no state that outlives a call.
 *
 * THE FOUR THINGS THAT GO WRONG, each of which this module exists to prevent:
 *
 *  1. PROGRESS REDRAWS. Build tools rewrite one row over and over with a carriage return:
 *     `#5 building 1.2s\r#5 building 2.4s\r#5 DONE\n`. Split on `\n` alone and that is ONE line
 *     three states long; split on `\r` as a terminator and it is three lines of noise. It is one
 *     line whose final state is `#5 DONE` — a `\r` means "the next thing overwrites what I just
 *     said", so a run of them collapses to its last fragment.
 *  2. ESCAPE SEQUENCES. A raw `\x1b[2A` inside a pane moves the REAL cursor, and everything Ink
 *     draws after it lands somewhere else — a frame that reads as corrupted rather than as a
 *     coloured line. Colour is stripped for the same reason it is not passed through: this app
 *     owns its palette, and a cell of escape bytes is a cell nobody paid for.
 *  3. CHUNK BOUNDARIES. A pipe splits wherever it likes — mid-line, mid-escape, mid-UTF-8 — so the
 *     remainder is carried in the state and completed by the next chunk. `createLineDecoder` adds
 *     a streaming `TextDecoder` on top for the byte half of the same problem.
 *  4. UNBOUNDED GROWTH. A long build prints thousands of lines and a pane shows a few dozen, so
 *     `appendLines` keeps the newest `OUTPUT_MAX_LINES` and drops the rest: a ring, not a log.
 */

/**
 * How many lines of a task's output are kept.
 *
 * A few hundred is several screens of scrollback at any terminal size and a fixed ceiling on
 * memory: a `docker compose build` of a cold cache prints thousands of lines, and none of the ones
 * that scrolled past twenty screens ago will be read. The pane is a view of what is happening now;
 * a service's real history is the Logs screen.
 */
export const OUTPUT_MAX_LINES = 400

/**
 * Everything a terminal would act on rather than show.
 *
 * In order: CSI sequences (colour, cursor movement, erase — parameters, then intermediates, then
 * the final byte), OSC strings (window titles, hyperlinks) with either terminator, and the
 * two-character escapes (`ESC M`, `ESC 7`). A DANGLING sequence at the very end of a line is
 * matched too: a chunk can split inside one, and the piece left over is bytes, not text.
 */
const ANSI = new RegExp(
  [
    '\\x1b\\[[0-9;:?]*[ -/]*[@-~]',
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    '\\x1b[@-Z\\\\-_]',
    '\\x1b\\[?[0-9;:?]*$',
  ].join('|'),
  'g',
)

/** Control bytes that survive the escape strip and would still lie about a row's width. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** A tab's width depends on where the row starts, which a truncated pane row cannot know. */
const TAB_WIDTH = 4

/**
 * A line with nothing left in it that a terminal would obey.
 *
 * Total: any string is valid input, and the answer is always something whose `length` is its width.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\t/g, ' '.repeat(TAB_WIDTH)).replace(CONTROL, '')
}

/**
 * What a decoder carries between chunks.
 *
 * `line` is the row as a terminal would currently be showing it, still raw — the escapes are
 * stripped when it is EMITTED, so a sequence split across two chunks is whole by then.
 * `overwritten` is the `\r` we have seen but not yet acted on: the next text replaces the row
 * rather than continuing it, which is the whole of the progress-redraw rule.
 */
export interface DecoderState {
  line: string
  overwritten: boolean
}

export const EMPTY_DECODER: DecoderState = { line: '', overwritten: false }

export interface Decoded {
  state: DecoderState
  /** Complete lines, in order, ready to render. */
  lines: string[]
}

/**
 * One line, as it will be drawn — or `null` when it is an artifact of the splitting.
 *
 * The distinction matters and is easy to get backwards. A line the program printed EMPTY is a blank
 * row it meant, and dropping it would glue two paragraphs of a build log together. A line that was
 * nothing but control bytes — an erase, a cursor move, the tail of a redraw — is not output at all;
 * keeping it would spend a pane row on a blank the program never printed. So the test is on the RAW
 * line: nothing but whitespace means the program said nothing, anything else means it said
 * something we are not allowed to show.
 */
function finishLine(raw: string): string | null {
  const text = stripAnsi(raw).replace(/\s+$/, '')
  if (text !== '') return text
  return raw.trim() === '' ? '' : null
}

/**
 * Feed one chunk of text through a decoder.
 *
 * The split KEEPS its delimiters so `\r\n` stays one terminator: treated as an overwrite followed
 * by an empty line, every line of a Windows-flavoured build log would be dropped as an artifact.
 */
export function decodeChunk(state: DecoderState, chunk: string): Decoded {
  if (chunk === '') return { state, lines: [] }

  const lines: string[] = []
  let { line, overwritten } = state

  for (const part of chunk.split(/(\r\n|\n|\r)/)) {
    // An empty segment carries no information: what is before a delimiter already lives in `line`.
    if (part === '') continue

    if (part === '\n' || part === '\r\n') {
      const text = finishLine(line)
      if (text !== null) lines.push(text)
      line = ''
      overwritten = false
      continue
    }

    if (part === '\r') {
      // Not a terminator: a promise that whatever comes next replaces this row. Acted on when the
      // replacement arrives, so a chunk that ENDS on `\r` still remembers what the row said —
      // `flushDecoder` is what emits it if nothing ever replaces it.
      overwritten = true
      continue
    }

    if (overwritten) {
      line = part
      overwritten = false
    } else {
      line += part
    }
  }

  return { state: { line, overwritten }, lines }
}

/**
 * The last, unterminated line — the final state of a progress row that never got its newline.
 *
 * Called when the command has exited: there is nothing left to complete the line, so what it says
 * now is what it will always say. A pending line that is EMPTY is not a blank output line; it is
 * the nothing that follows a final newline.
 */
export function flushDecoder(state: DecoderState): Decoded {
  if (state.line === '') return { state: EMPTY_DECODER, lines: [] }
  const text = finishLine(state.line)
  return { state: EMPTY_DECODER, lines: text === null ? [] : [text] }
}

/**
 * The newest `limit` lines of `buffer` followed by `incoming` — a ring, so a long build cannot grow
 * memory without bound.
 *
 * Returns the same array when there is nothing to add, which is what lets a caller skip a render.
 */
export function appendLines(
  buffer: readonly string[],
  incoming: readonly string[],
  limit: number = OUTPUT_MAX_LINES,
): string[] {
  if (limit <= 0) return []
  if (incoming.length === 0) return buffer.slice(Math.max(0, buffer.length - limit))
  const out = [...buffer, ...incoming]
  return out.length <= limit ? out : out.slice(out.length - limit)
}

/**
 * A decoder that holds its own state — the shape the impure side wants.
 *
 * Bytes are accepted as well as text, because a pipe hands over `Uint8Array`s that can split in the
 * middle of a multi-byte character; the streaming `TextDecoder` carries that remainder exactly as
 * `DecoderState` carries a partial line. Everything it decides is in the pure functions above.
 */
export interface LineDecoder {
  push(chunk: string | Uint8Array): string[]
  /** Whatever is left when the command has exited. */
  flush(): string[]
}

export function createLineDecoder(): LineDecoder {
  let state = EMPTY_DECODER
  const bytes = new TextDecoder()

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : bytes.decode(chunk, { stream: true })
      const out = decodeChunk(state, text)
      state = out.state
      return out.lines
    },
    flush() {
      // The byte decoder is flushed first: a truncated character at the very end belongs to the
      // last line, not to the next command.
      const tail = bytes.decode()
      if (tail !== '') {
        const more = decodeChunk(state, tail)
        state = more.state
        const out = flushDecoder(state)
        state = out.state
        return [...more.lines, ...out.lines]
      }
      const out = flushDecoder(state)
      state = out.state
      return out.lines
    },
  }
}
