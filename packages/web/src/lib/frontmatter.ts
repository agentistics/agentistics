/**
 * frontmatter.ts — PURE: pulls a leading YAML frontmatter block off a markdown file.
 *
 * NOT A YAML PARSER. SKILL.md and most docs in this repository open with a flat block of
 * `key: value` lines (occasionally one nested one level, like `metadata:\n  type: x`), and pulling
 * in a real YAML library for that is the same trade this codebase already refused for syntax
 * highlighting (`codeHighlight.ts`'s own header) and for TOML (`monacoLanguage.ts`): a grammar
 * engine bought for a shape a dozen lines already cover. So this reads exactly two shapes —
 * `key: value` at column 0, and everything indented under it kept as that key's own text — and
 * refuses anything else outright rather than guessing at real YAML (flow lists `[a, b]`, anchors,
 * multi-document `---`/`...`). A refusal is `data: null`; the CALLER decides what that means (here,
 * `MarkdownPreview` shows the raw block as a code fence — see its own header).
 */

export interface FrontmatterResult {
  /** Whether a `---` fenced block was found at the very start of the file at all. */
  present: boolean
  /**
   * The parsed fields, in file order — a `Map` rather than a plain object so a frontmatter block
   * that repeats a key (malformed, but not this module's job to refuse) does not silently lose one
   * to `Object` key collision. `null` when a block was found but this reader could not make sense
   * of it — never invented, never dropped.
   */
  data: Map<string, string> | null
  /** The block's own text, WITHOUT the `---` fences — what a caller shows when `data` is `null`. */
  raw: string
  /** The file with the frontmatter block (fences included) removed. Identical to the input when
   * `present` is `false`. */
  body: string
}

const FENCE = '---'

/** A leading UTF-8 BOM, stripped before anything else looks at column 0. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * `\r\n` → `\n`, and a bare stray `\r` along with it. `extractBlock` below gates on `text.startsWith
 * ('---\n')`, so a Windows-authored file (`'---\r\nname: x\r\n---\r\n# Body'`) never even reached
 * that check — it starts with `---\r`, not `---\n`, so `present` came back `false` and the whole
 * block rendered as an `<hr>` plus a setext heading instead of a frontmatter table. Only the
 * DETECTION/PARSING copy is normalized (see `parseFrontmatter`'s own `body` fallback below, which
 * still uses the ORIGINAL `text`): a caller showing the raw file back — the "not present" case, or
 * `raw`'s own display when `data` is `null` — should see exactly the bytes the file has, `\r`
 * included, not a silently rewritten copy.
 */
function normalizeLineEndings(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : text
}

/**
 * `key: value` at column 0. The key is a bare word (letters, digits, `_`, `-`, `.`) — real YAML
 * allows far more (quoted keys, colons inside brackets), and a key shaped like anything else is
 * exactly the kind of "real YAML" this module refuses rather than mis-reads.
 */
const KEY_LINE = /^([A-Za-z0-9_.-]+):[ \t]?(.*)$/

/** Strips one layer of matching quotes — `"x"` and `'x'` both read as `x`. Anything else is kept
 * verbatim, escapes included: a `\n` inside a quoted YAML string is not unescaped here. */
function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1)
    }
  }
  return v
}

/**
 * Finds the block, if any. `present: false` covers both "no frontmatter" and "an opening fence with
 * no closing one" — an unterminated block is not a block, and the file is shown as it is.
 */
function extractBlock(text: string): { raw: string; body: string } | null {
  if (!text.startsWith(`${FENCE}\n`) && text !== FENCE) return null
  const afterFence = text.indexOf('\n') + 1
  // The closing fence must sit ALONE on its own line — `---title` (a heading underline, not a
  // fence) is skipped rather than treated as "no frontmatter at all", because a real closing fence
  // may still follow it further down the file.
  let searchFrom = afterFence
  for (;;) {
    const closeAt = text.indexOf(`\n${FENCE}`, searchFrom)
    if (closeAt === -1) return null
    const afterClose = closeAt + 1 + FENCE.length
    const eol = text.indexOf('\n', afterClose)
    const restOfLine = text.slice(afterClose, eol === -1 ? text.length : eol)
    if (restOfLine.trim() === '') {
      return { raw: text.slice(afterFence, closeAt), body: eol === -1 ? '' : text.slice(eol + 1) }
    }
    searchFrom = closeAt + 1
  }
}

/**
 * Reads the block's lines as flat `key: value` pairs. A line indented under a key (spaces/tabs
 * before any text) is folded into that key's own value, joined by `\n`, so `metadata:\n  type: x`
 * reads as `metadata` → `"type: x"` rather than being rejected outright — it is still ONE fact
 * worth a row in the table, even though this is not a real nested-object reading of it.
 *
 * Returns `null` — refuse, never repair — the moment a non-blank, non-indented line does not match
 * `key: value` at all: a flow list, a multi-document marker, or genuinely malformed YAML.
 */
function readFlatPairs(raw: string): Map<string, string> | null {
  const lines = raw.split('\n')
  const data = new Map<string, string>()
  let currentKey: string | null = null
  for (const line of lines) {
    if (line.trim() === '') continue
    const indented = /^[ \t]/.test(line)
    if (indented) {
      if (currentKey === null) return null
      const prev = data.get(currentKey) ?? ''
      data.set(currentKey, prev === '' ? line.trim() : `${prev}\n${line.trim()}`)
      continue
    }
    const m = KEY_LINE.exec(line)
    if (m === null) return null
    const [, key, rest] = m as unknown as [string, string, string]
    const trimmedRest = rest.trim()
    // A flow collection (`[a, b]`, `{a: 1}`) is real YAML this reader does not attempt — refusing
    // the WHOLE block is what keeps `data` honest: a table showing `tags: [a, b, c]` as one string
    // would look parsed when it was merely not rejected.
    if (trimmedRest.startsWith('[') || trimmedRest.startsWith('{')) return null
    data.set(key, unquote(rest))
    currentKey = key
  }
  return data
}

/** `parseFrontmatter('')` and every other edge case answer `present: false` — never throws. */
export function parseFrontmatter(text: string): FrontmatterResult {
  const clean = normalizeLineEndings(stripBom(text))
  const found = extractBlock(clean)
  if (found === null) return { present: false, data: null, raw: '', body: text }
  return { present: true, data: readFlatPairs(found.raw), raw: found.raw, body: found.body }
}
