/**
 * Test-only: a tiny source scanner for the guard lints (`doors.lint.test.ts`, `guard-context.lint.test.ts`). Comments and
 * string literals are blanked FIRST (lengths kept), so a sentence that names `store.update(` is never read as a call, and a
 * call's arguments are read by balanced parentheses — across lines.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** `src` with every comment and string/template literal body replaced by spaces (newlines kept). */
export function blank(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  const fill = (s: string) => s.replace(/[^\n]/g, ' ')
  while (i < n) {
    const c = src[i]!, d = src[i + 1]
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; out += fill(src.slice(i, end)); i = end; continue }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; out += fill(src.slice(i, end)); i = end; continue }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++ }
      // keep the quotes and a marker of the body's presence, blank the body
      out += c + fill(src.slice(i + 1, j)) + (src[j] ?? ''); i = j + 1; continue
    }
    out += c; i++
  }
  return out
}

/** Every call of `name(` in the blanked source, with its ORIGINAL argument text (balanced parentheses). */
export function callsOf(src: string, name: RegExp): Array<{ at: number; line: number; args: string }> {
  const clean = blank(src)
  const out: Array<{ at: number; line: number; args: string }> = []
  const re = new RegExp(name.source + '\\s*\\(', 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(clean))) {
    const open = m.index + m[0].length - 1
    let depth = 0, j = open
    for (; j < clean.length; j++) { const ch = clean[j]; if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth === 0) break } }
    out.push({ at: m.index, line: clean.slice(0, m.index).split('\n').length, args: src.slice(open + 1, j) })
  }
  return out
}

/** Top-level comma-separated arguments of an argument text. */
export function splitArgs(args: string): string[] {
  const clean = blank(args)
  const parts: string[] = []
  let depth = 0, last = 0
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) { parts.push(args.slice(last, i)); last = i + 1 }
  }
  parts.push(args.slice(last))
  return parts.map(p => p.trim()).filter(Boolean)
}

/** Non-test, non-fixture `.ts` files under `dir`, as repo-relative paths from `base`. */
export function productionSources(dir: string, base: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) { if (name !== 'node_modules') walk(p); continue }
      if (!name.endsWith('.ts') || /\.(test|testing|fixture)\.ts$|\.worker\.ts$|\.generated\.ts$/.test(name)) continue
      out.push(relative(base, p))
    }
  }
  walk(dir)
  return out.sort()
}

export const read = (base: string, rel: string): string => readFileSync(join(base, rel), 'utf8')
