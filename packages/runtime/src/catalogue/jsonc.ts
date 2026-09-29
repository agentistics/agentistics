/**
 * catalogue/jsonc.ts — a small JSONC reader that remembers WHERE everything is (B8 §3.2).
 *
 * The catalogue's promise is "a problem is a sentence with `file:line`". `JSON.parse` knows no
 * lines, so this is a recursive-descent parser for JSON plus `//` and `/* *\/` comments (trailing
 * commas tolerated) that records the 1-based line of every object KEY and every array ELEMENT,
 * addressable by a JSON-pointer-like path (`/mcpServers/db/env/DB_URL`, `/rules/2`).
 *
 * A DUPLICATE key in one object is an error, not a last-wins: a key that silently overrides
 * another is the same lie as an ignored unknown key. It never throws — every failure is
 * `{ ok: false, line, message }`. PURE.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type JsoncResult =
  | { ok: true; value: JsonValue; lines: Map<string, number> }
  | { ok: false; line: number; message: string }

/** Escapes one path segment the way RFC 6901 does. */
export function pointerSegment(seg: string | number): string {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1')
}

class Fail extends Error {
  constructor(public line: number, message: string) {
    super(message)
  }
}

export function parseJsonc(text: string): JsoncResult {
  const src = text.replace(/^\uFEFF/, '')
  let i = 0
  let line = 1
  const lines = new Map<string, number>()

  const fail = (message: string, at = line): never => {
    throw new Fail(at, message)
  }

  const skip = (): void => {
    for (;;) {
      const c = src[i]
      if (c === '\n') { line++; i++ }
      else if (c === ' ' || c === '\t' || c === '\r') i++
      else if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++
      } else if (c === '/' && src[i + 1] === '*') {
        const start = line
        i += 2
        for (;;) {
          if (i >= src.length) fail('unterminated /* comment', start)
          if (src[i] === '*' && src[i + 1] === '/') { i += 2; break }
          if (src[i] === '\n') line++
          i++
        }
      } else return
    }
  }

  const parseString = (): string => {
    const start = line
    i++ // opening quote
    let out = ''
    for (;;) {
      if (i >= src.length) fail('unterminated string', start)
      const c = src[i] as string
      if (c === '"') { i++; return out }
      if (c === '\n') fail('a string cannot span lines', start)
      if (c === '\\') {
        const n = src[i + 1]
        i += 2
        switch (n) {
          case 'n': out += '\n'; break
          case 't': out += '\t'; break
          case 'r': out += '\r'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case '/': out += '/'; break
          case '\\': out += '\\'; break
          case '"': out += '"'; break
          case 'u': {
            const hex = src.slice(i, i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape')
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
            break
          }
          default: fail(`bad escape \\${n ?? ''}`)
        }
      } else { out += c; i++ }
    }
  }

  const parseValue = (path: string): JsonValue => {
    skip()
    const c = src[i]
    if (c === undefined) return fail('unexpected end of file')
    if (c === '{') return parseObject(path)
    if (c === '[') return parseArray(path)
    if (c === '"') return parseString()
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 64))
    if (m) { i += m[0].length; return Number(m[0]) }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (src.startsWith(word, i) && !/[A-Za-z0-9_]/.test(src[i + word.length] ?? '')) { i += word.length; return v }
    }
    return fail(`unexpected character '${c}'`)
  }

  const parseObject = (path: string): JsonValue => {
    i++
    const obj: { [k: string]: JsonValue } = {}
    for (;;) {
      skip()
      const c = src[i]
      if (c === undefined) return fail('unterminated object')
      if (c === '}') { i++; return obj }
      if (c !== '"') return fail(`expected a quoted key, found '${c}'`)
      const keyLine = line
      const key = parseString()
      const p = `${path}/${pointerSegment(key)}`
      if (Object.prototype.hasOwnProperty.call(obj, key)) return fail(`duplicate key "${key}" (a repeated key silently overrides the first)`, keyLine)
      lines.set(p, keyLine)
      skip()
      if (src[i] !== ':') return fail(`expected ':' after key "${key}"`)
      i++
      obj[key] = parseValue(p)
      skip()
      if (src[i] === ',') { i++; continue }
      if (src[i] === '}') { i++; return obj }
      return fail(src[i] === undefined ? 'unterminated object' : `expected ',' or '}', found '${src[i]}'`)
    }
  }

  const parseArray = (path: string): JsonValue => {
    i++
    const arr: JsonValue[] = []
    for (;;) {
      skip()
      const c = src[i]
      if (c === undefined) return fail('unterminated array')
      if (c === ']') { i++; return arr }
      lines.set(`${path}/${arr.length}`, line)
      arr.push(parseValue(`${path}/${arr.length}`))
      skip()
      if (src[i] === ',') { i++; continue }
      if (src[i] === ']') { i++; return arr }
      return fail(src[i] === undefined ? 'unterminated array' : `expected ',' or ']', found '${src[i]}'`)
    }
  }

  try {
    skip()
    lines.set('', line)
    const value = parseValue('')
    skip()
    if (i < src.length) return { ok: false, line, message: `unexpected content after the top-level value ('${src[i]}')` }
    return { ok: true, value, lines }
  } catch (e) {
    if (e instanceof Fail) return { ok: false, line: e.line, message: e.message }
    return { ok: false, line, message: 'unreadable JSON' }
  }
}
