/**
 * catalogue/frontmatter.ts — markdown = frontmatter + body, the frontmatter a strict YAML SUBSET
 * with line numbers (B8 §3.2).
 *
 * Supported: `key: scalar` (plain, 'single', "double"), `true`/`false`, integers, inline lists
 * `[a, b]`, block lists (`key:` then `  - item`), block scalars `|` and `>` (basic), and a nested
 * map (indented `sub: x` lines) captured as an OPAQUE `{ kind: 'map' }` the caller may refuse
 * without the parse breaking. Anything else is an error with a line — a real YAML parser would
 * accept things (anchors, tags, flow maps) the catalogue's frontmatter has no meaning for, and
 * "accepted but ignored" is what this directory refuses everywhere.
 *
 * Frontmatter opens on LINE 1 with `---` and closes with `---`. No opening = no frontmatter
 * (`frontmatter: null`, the whole text is the body). An opening without a close is an error.
 * `bodyStartLine` is the 1-based line of the first body line, so a caller can cite body lines.
 * Never throws. PURE.
 */

export type FmValue =
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'list'; value: string[] }
  | { kind: 'map' }

export interface FmField {
  value: FmValue
  /** 1-based line of the `key:` line. */
  line: number
}

export interface FmError {
  line: number
  message: string
}

export interface FrontmatterResult {
  /** null when the file has no frontmatter. */
  frontmatter: Map<string, FmField> | null
  body: string
  /** 1-based line of the body's first line. */
  bodyStartLine: number
  errors: FmError[]
}

function unquote(raw: string): { ok: true; value: string } | { ok: false } {
  const t = raw.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return { ok: true, value: t.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)) }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return { ok: true, value: t.slice(1, -1).replace(/''/g, "'") }
  if (t.startsWith('"') || t.startsWith("'")) return { ok: false }
  return { ok: true, value: t.replace(/\s+#.*$/, '') }
}

function scalar(raw: string): FmValue | null {
  const t = raw.trim()
  if (t === 'true') return { kind: 'boolean', value: true }
  if (t === 'false') return { kind: 'boolean', value: false }
  if (/^-?\d+$/.test(t)) return { kind: 'number', value: Number(t) }
  const u = unquote(t)
  return u.ok ? { kind: 'string', value: u.value } : null
}

function inlineList(raw: string): string[] | null {
  const inner = raw.trim().slice(1, -1).trim()
  if (inner === '') return []
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const c of inner) {
    if (quote) { cur += c; if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === ',') { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (quote) return null
  out.push(cur)
  const items: string[] = []
  for (const p of out) {
    const u = unquote(p)
    if (!u.ok) return null
    items.push(u.value)
  }
  return items
}

export function splitFrontmatter(text: string): FrontmatterResult {
  const all = text.replace(/^\uFEFF/, '').split('\n').map(l => l.replace(/\r$/, ''))
  if ((all[0] ?? '').trimEnd() !== '---') {
    return { frontmatter: null, body: all.join('\n'), bodyStartLine: 1, errors: [] }
  }
  let close = -1
  for (let k = 1; k < all.length; k++) {
    if ((all[k] ?? '').trimEnd() === '---') { close = k; break }
  }
  if (close === -1) {
    return { frontmatter: new Map(), body: '', bodyStartLine: all.length + 1, errors: [{ line: 1, message: 'the frontmatter opens with --- but never closes' }] }
  }
  const errors: FmError[] = []
  const fm = new Map<string, FmField>()
  const body = all.slice(close + 1).join('\n')
  const bodyStartLine = close + 2

  let k = 1
  while (k < close) {
    const raw = all[k] as string
    const lineNo = k + 1
    if (raw.trim() === '' || raw.trim().startsWith('#')) { k++; continue }
    if (/^\s/.test(raw)) { errors.push({ line: lineNo, message: 'unexpected indented line' }); k++; continue }
    const m = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*)|\s*)$/.exec(raw)
    if (!m) { errors.push({ line: lineNo, message: `cannot read "${raw.trim()}" as \`key: value\`` }); k++; continue }
    const key = m[1] as string
    const rest = (m[2] ?? '').trim()
    if (fm.has(key)) errors.push({ line: lineNo, message: `duplicate key "${key}"` })
    // gather the indented continuation lines
    let end = k + 1
    while (end < close && (/^\s/.test(all[end] as string) || (all[end] as string).trim() === '')) end++
    const cont = all.slice(k + 1, end)
    let value: FmValue | null = null
    if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const lines = cont.map(l => l.replace(/^\s{1,2}/, ''))
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      value = { kind: 'string', value: rest.startsWith('|') ? lines.join('\n') : lines.join(' ').replace(/\s+/g, ' ').trim() }
    } else if (rest === '') {
      const nonEmpty = cont.filter(l => l.trim() !== '')
      if (nonEmpty.length === 0) value = { kind: 'string', value: '' }
      else if (nonEmpty.every(l => /^\s*-(\s|$)/.test(l))) {
        const items: string[] = []
        let bad = false
        for (const l of nonEmpty) {
          const u = unquote(l.replace(/^\s*-\s*/, ''))
          if (u.ok) items.push(u.value)
          else bad = true
        }
        if (bad) errors.push({ line: lineNo, message: `the list under "${key}" has an unterminated quote` })
        else value = { kind: 'list', value: items }
      } else value = { kind: 'map' }
    } else if (rest.startsWith('[')) {
      const items = rest.endsWith(']') ? inlineList(rest) : null
      if (items === null) errors.push({ line: lineNo, message: `cannot read the list on "${key}"` })
      else value = { kind: 'list', value: items }
    } else {
      value = scalar(rest)
      if (value === null) errors.push({ line: lineNo, message: `unterminated quote on "${key}"` })
    }
    if (value && !fm.has(key)) fm.set(key, { value, line: lineNo })
    k = end
  }
  return { frontmatter: fm, body, bodyStartLine, errors }
}
