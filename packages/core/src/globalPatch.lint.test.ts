import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * globalPatch.lint.test.ts — no test file may leave a GLOBAL patched for the files that run after it.
 *
 * `bun test` runs every test file in ONE process, so `globalThis` is shared by all of them. A file
 * that replaces `globalThis.fetch` in a `beforeEach` and never puts it back hands its stub to every
 * LATER file's bare `fetch`. That is exactly what `packages/web/src/lib/notifications.test.ts` did
 * (found by B5b.1-SEC, 2026-09-28): a later test calling `fetch` against a local `Bun.serve` got
 * `{ ok: true, json }` back and failed with `res.text is not a function` — in a file that had done
 * nothing wrong, and only when the two happened to run in that order.
 *
 * The rule: every assignment to a property of a global root — `globalThis.X = …`,
 * `(globalThis as T).X = …`, `global.X`, `window.X`, `Object.defineProperty(globalThis, 'X', …)`,
 * and the same through an ALIAS (`const env = globalThis as …; env.X ??= …`) — needs a RESTORE of
 * that same `X` inside a teardown the runner guarantees: an `afterEach(…)`/`afterAll(…)` body or a
 * `finally { … }` block. A restore is a write to `.X`, a `delete ….X`, or a `defineProperty` naming
 * `X`, either written in the teardown itself or inside a function the teardown CALLS that is
 * defined in the same file (`finally { restore() }` over a `restore: () => { … }` helper). A
 * restore written as the last line of a test body does not count: it runs only on the success
 * path, and the leak it is meant to prevent is the failure path's.
 *
 * The escape hatch is `@global-patch-intentional` plus a REASON, on the offending line or up to six
 * lines above it — the shape `tokens.lint.test.ts` and `gitTestEnv.lint.test.ts` use.
 *
 * STATED LIMITS: `spyOn(globalThis, 'X')` is not an assignment and is not scanned (it has its own
 * `mockRestore`); nor is `Object.assign(globalThis, …)`, which nothing in the repo uses. Only a
 * direct property of the root counts — `window.location.href = …` patches `location`'s field, not
 * a global, and is left alone.
 */

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCAN_DIR = 'packages'
const SELF = join(import.meta.dir, 'globalPatch.lint.test.ts')
const MARKER = '@global-patch-intentional'
const GLOBAL_ROOTS = ['globalThis', 'global', 'window']

/**
 * `src` with comments blanked to spaces (newlines kept, so offsets and line numbers still hold).
 * String and template literals are skipped over, so a `//` inside a URL is not a comment.
 */
export function stripComments(src: string): string {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' '
      continue
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    i++
  }
  return out.join('')
}

/** The balanced `open…close` group starting at the first `open` at-or-after `from`. */
export function balanced(src: string, from: number, open = '(', close = ')'): string {
  const start = src.indexOf(open, from)
  if (start === -1) return ''
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start)
}

const esc = (s: string) => s.replace(/[$]/g, '\\$')

/** The global roots plus every local alias of one (`const env = globalThis as …`). */
export function globalRoots(src: string): string[] {
  const roots = new Set(GLOBAL_ROOTS)
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\(?\s*(globalThis|global|window)\b(?!\s*[.[(])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) roots.add(m[1]!)
  return [...roots]
}

export interface GlobalPatch {
  index: number
  name: string
}

/** Every write to a DIRECT property of a global root (or an alias of one) in comment-free `src`. */
export function globalPatches(src: string): GlobalPatch[] {
  const out: GlobalPatch[] = []
  const assign = String.raw`\s*!?\s*(?:=(?![=>])|\?\?=|\|\|=|&&=)`
  for (const root of globalRoots(src)) {
    const r = esc(root)
    const forms = [
      // root.X =   /  (root as T).X =   /  (root).X ??=
      new RegExp(String.raw`(?<![.\w$])(?:\(\s*${r}\b(?:\s+as\s[^;]*?)?\)|${r})\s*!?\s*\.\s*([A-Za-z_$][\w$]*)${assign}`, 'g'),
      // root['X'] =
      new RegExp(String.raw`(?<![.\w$])(?:\(\s*${r}\b(?:\s+as\s[^;]*?)?\)|${r})\s*!?\s*\[\s*['"\`]([A-Za-z_$][\w$]*)['"\`]\s*\]${assign}`, 'g'),
      // Object.defineProperty(root, 'X', …)
      new RegExp(String.raw`\bObject\.defineProperty\(\s*(?:\(\s*)?${r}\b[^,]*,\s*['"\`]([A-Za-z_$][\w$]*)['"\`]`, 'g'),
    ]
    for (const re of forms) {
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) out.push({ index: m.index, name: m[1]! })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/** Whether `text` restores the global `name`: a write to `.name`, a delete of it, or a defineProperty naming it. */
export function restoresName(text: string, name: string): boolean {
  const n = esc(name)
  return new RegExp(String.raw`\.\s*${n}\s*!?\s*(?:=(?![=>])|\?\?=)|\bdelete\s[^;\n]*\.\s*${n}\b|\bdelete\s[^;\n]*\[\s*['"\`]${n}['"\`]\s*\]|\bObject\.defineProperty\([^,]*,\s*['"\`]${n}['"\`]`).test(text)
}

/** The body of every afterEach/afterAll call and every `finally` block in comment-free `src`. */
export function teardownBodies(src: string): string[] {
  const out: string[] = []
  const hooks = /\b(afterEach|afterAll)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = hooks.exec(src))) out.push(balanced(src, m.index))
  const fin = /\bfinally\s*\{/g
  while ((m = fin.exec(src))) out.push(balanced(src, m.index, '{', '}'))
  return out
}

/** The text of a same-file function named `fn` — `function fn(`, `fn = (…) =>`, `fn: (…) =>`, `fn() {`. */
function definitionOf(src: string, fn: string): string {
  const f = esc(fn)
  const re = new RegExp(String.raw`(?:\bfunction\s+${f}\s*\(|(?<![.\w$])${f}\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)|(?<![.\w$])${f}\s*\([^)]*\)\s*\{)`, 'g')
  let m: RegExpExecArray | null
  const bodies: string[] = []
  while ((m = re.exec(src))) bodies.push(balanced(src, m.index + m[0].length - 1, '{', '}') || src.slice(m.index, src.indexOf('\n', m.index)))
  return bodies.join('\n')
}

/** Whether some teardown in `src` restores `name` — itself, or through a same-file function it calls. */
export function teardownRestores(src: string, name: string): boolean {
  for (const body of teardownBodies(src)) {
    if (restoresName(body, name)) return true
    const calls = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = calls.exec(body))) {
      if (restoresName(definitionOf(src, m[1]!), name)) return true
    }
  }
  return false
}

function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/** The marker on the offending line or up to six lines above it — in the ORIGINAL source (it is a comment). */
function excused(original: string, index: number): boolean {
  const lines = original.split('\n')
  const n = lineAt(original, index)
  return lines.slice(Math.max(0, n - 7), n).some(l => l.includes(MARKER))
}

export interface GlobalPatchViolation {
  line: number
  name: string
}

/** Every global patch in `original` with no teardown restoring it and no marker excusing it. */
export function findGlobalPatchViolations(original: string): GlobalPatchViolation[] {
  const src = stripComments(original)
  const out: GlobalPatchViolation[] = []
  const judged = new Map<string, boolean>()
  for (const p of globalPatches(src)) {
    if (excused(original, p.index)) continue
    if (!judged.has(p.name)) judged.set(p.name, teardownRestores(src, p.name))
    if (!judged.get(p.name)) out.push({ line: lineAt(src, p.index), name: p.name })
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir).sort() } catch { return out }
  for (const name of entries) {
    const p = join(dir, name)
    let st: ReturnType<typeof statSync>
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue
      walk(p, out)
      continue
    }
    if (!/\.test\.tsx?$/.test(name)) continue
    if (p === SELF) continue
    out.push(p)
  }
  return out
}

describe('globalPatch.lint — a test file may not leave a global patched for the files after it', () => {
  // Fixtures are assembled from pieces so this file's own source never carries a real patch.
  const G = ['global', 'This'].join('')
  const FETCH = `${G}.fetch`

  it('self-test: stripComments blanks comments, keeps strings and line numbers', () => {
    const src = `a // ${FETCH} = x\nb /* ${FETCH} = y */ 'http://x' // c`
    const out = stripComments(src)
    expect(out).not.toContain('fetch')
    expect(out).toContain("'http://x'")
    expect(out.split('\n').length).toBe(2)
  })

  it('self-test: globalPatches finds every write form, and only direct properties of a root', () => {
    const names = (s: string) => globalPatches(stripComments(s)).map(p => p.name)
    expect(names(`${FETCH} = stub`)).toEqual(['fetch'])
    expect(names(`;(${G} as unknown as { fetch: unknown }).fetch = stub`)).toEqual(['fetch'])
    expect(names(`(${G} as any).WebSocket ??= Fake`)).toEqual(['WebSocket'])
    expect(names(`${G}['setTimeout'] = fake`)).toEqual(['setTimeout'])
    expect(names(`global.Date = FakeDate`)).toEqual(['Date'])
    expect(names(`window.fetch = stub`)).toEqual(['fetch'])
    expect(names(`Object.defineProperty(${G}, 'sessionStorage', { value })`)).toEqual(['sessionStorage'])
    expect(names(`const env = ${G} as unknown as { window?: W }\nenv.window ??= { innerWidth: 1 }`)).toEqual(['window'])
    // Not patches: a comparison, a read, a nested property, a member of something else.
    expect(names(`if (${FETCH} === x) {}`)).toEqual([])
    expect(names(`const f = ${FETCH}`)).toEqual([])
    expect(names(`window.location.href = 'x'`)).toEqual([])
    expect(names(`const env = ${G} as any\nenv.window!.innerWidth = 390`)).toEqual([])
    expect(names(`obj.window = 1`)).toEqual([])
  })

  const LEAK = `const real = ${FETCH}\nbeforeEach(() => { ${FETCH} = stub })\ntest('t', () => {})`

  it('self-test: a patch with no teardown restore is a violation (the notifications.test.ts shape)', () => {
    expect(findGlobalPatchViolations(LEAK)).toEqual([{ line: 2, name: 'fetch' }])
  })

  it('self-test: a restore at the end of a test BODY does not count — it runs on the success path only', () => {
    const src = `test('t', () => {\n  ${FETCH} = stub\n  expect(1).toBe(1)\n  ${FETCH} = real\n})`
    // Both writes are reported: the "restore" is just another unguarded write of the same global.
    expect(findGlobalPatchViolations(src).map(v => v.name)).toEqual(['fetch', 'fetch'])
  })

  it('self-test: afterEach, afterAll, finally and a teardown-called helper all count as a restore', () => {
    expect(findGlobalPatchViolations(`${LEAK}\nafterEach(() => { ${FETCH} = real })`)).toEqual([])
    expect(findGlobalPatchViolations(`${LEAK}\nafterAll(() => { ${FETCH} = real })`)).toEqual([])
    const fin = `test('t', () => {\n  ${FETCH} = stub\n  try { run() } finally { ${FETCH} = real }\n})`
    expect(findGlobalPatchViolations(fin)).toEqual([])
    const alias = `const env = ${G} as any\nconst ours = env.window === undefined\nenv.window ??= {}\nafterAll(() => { if (ours) delete env.window })`
    expect(findGlobalPatchViolations(alias)).toEqual([])
    const helper = [
      `function stub() {`,
      `  Object.defineProperty(${G}, 'sessionStorage', { value: s })`,
      `  return { restore: () => { delete (${G} as any).sessionStorage } }`,
      `}`,
      `test('t', () => { const { restore } = stub(); try { go() } finally { restore() } })`,
    ].join('\n')
    expect(findGlobalPatchViolations(helper)).toEqual([])
  })

  it('self-test: a teardown restoring a DIFFERENT global does not excuse this one', () => {
    expect(findGlobalPatchViolations(`${LEAK}\nafterEach(() => { ${G}.WebSocket = realWs })`).length).toBe(1)
  })

  it('self-test: the escape hatch, on the line or up to six lines above — and not further', () => {
    expect(findGlobalPatchViolations(`// ${MARKER} — the whole process wants it\n${LEAK}`)).toEqual([])
    expect(findGlobalPatchViolations(`// ${MARKER} — far away\n${'\n'.repeat(10)}${LEAK}`).length).toBe(1)
  })

  const FILES = walk(join(ROOT, SCAN_DIR))

  it('non-vacuity: the walk found the test files, including the ones that patch globals', () => {
    expect(FILES.length).toBeGreaterThan(100)
    const rels = FILES.map(f => relative(ROOT, f))
    expect(rels).toContain(join('packages', 'web', 'src', 'lib', 'notifications.test.ts'))
    expect(rels).not.toContain(relative(ROOT, SELF))
    const patching = FILES.filter(f => globalPatches(stripComments(readFileSync(f, 'utf-8'))).length > 0)
    expect(patching.length).toBeGreaterThanOrEqual(5)
  })

  it('no test file leaves a global patched for the files after it', () => {
    const offences: string[] = []
    for (const file of FILES) {
      for (const v of findGlobalPatchViolations(readFileSync(file, 'utf-8'))) {
        offences.push(`${relative(ROOT, file)}:${v.line}  ${v.name} is patched and never restored in afterEach/afterAll/finally`)
      }
    }
    expect(offences).toEqual([])
  })
})
