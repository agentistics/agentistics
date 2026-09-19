import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { stripComments } from './stripComments'

/**
 * `monacoEntry.ts` IS A LIST, AND A LIST ROTS. This test is the thing that notices.
 *
 * The file composes Monaco from the package's published subpaths instead of its `monaco-editor`
 * barrel, for one measured reason: the barrel's TypeScript language service drags in a 6,914,791-byte
 * `ts.worker.js` that Vite emits at BUILD time whether a browser ever fetches it or not, and this
 * feature does not register that service at all. Dropping it took the embedded web bundle from
 * 19,259.0 KB to 12,406.6 KB — a third of the `agentop` binary's web payload.
 *
 * Paying for that with a hand-maintained list buys three failure modes, and NONE of them shows up in
 * a build, a type check or a browser:
 *
 *  1. **A grammar upstream adds is a language that silently loses its colour here.** The build stays
 *     green, every other language still highlights, and the only symptom is a `.kt` file rendering
 *     in plain grey — which looks like nothing at all until somebody opens one.
 *  2. **A CONTRIBUTION upstream adds, or one dropped here by a bad merge, is a MISSING EDITOR
 *     FEATURE.** This is the half whose loss is silent and the half this test was first written
 *     without: deleting `editor/contrib/find/browser/findController` left 6 tests passing and 0
 *     failing, and so did deleting `features/register.all` — which is EVERY contribution: find, the
 *     context menu, folding, suggest, bracket matching, rename. A green build and an editor with no
 *     find widget. The 9 hand-copied imports at the entry's tail are exactly where a Monaco upgrade
 *     drops one.
 *  3. **The 6.9 MB comes back in one import.** Re-adding `languages/features/typescript/register`
 *     (or a `?worker` for `ts.worker`) is a one-line change that nothing else in the repo objects
 *     to, and the cost lands in the installer rather than on a screen.
 *
 * So all three are asserted against the INSTALLED package and against the module's own source, in
 * the shape `tokens.lint.test.ts` and `billing-detect.test.ts` already use here. A monaco upgrade
 * that ships a new language or a new contribution now fails the build with its path in the message.
 */

const WEB = join(import.meta.dir, '../..')
const SRC = join(import.meta.dir, '..')
const ENTRY = join(import.meta.dir, 'monacoEntry.ts')
const SETUP = join(import.meta.dir, 'monacoSetup.ts')
const SELF = join(import.meta.dir, 'monacoEntry.lint.test.ts')

/** monaco-editor is hoisted by bun, so resolve it rather than assuming a path. */
const VS_CANDIDATES = [
  join(WEB, 'node_modules', 'monaco-editor/package.json'),
  join(WEB, '../..', 'node_modules', 'monaco-editor/package.json'),
]

/**
 * **A CHECK THAT CANNOT ANSWER MUST SAY SO, NOT RETURN THE CONVENIENT ANSWER.** This used to return
 * `null` under any layout it did not recognise and every caller did `if (!vs) return`, so a pnpm
 * install, a nested hoist or a future bun change would have made the whole list-rot guard PASS
 * silently — the one outcome it exists to make impossible. It now fails, naming where it looked.
 */
function monacoVsDir(): string {
  for (const pkg of VS_CANDIDATES) {
    if (existsSync(pkg)) return join(dirname(pkg), 'esm/vs')
  }
  throw new Error(
    'monacoEntry.lint: cannot find the installed monaco-editor, so the list this test guards has ' +
      'nothing to be checked against — and an unanswerable check must fail, not pass. Looked for:\n' +
      VS_CANDIDATES.map(p => `  - ${p}`).join('\n') +
      '\nRun `bun install` in packages/web, or teach monacoVsDir() this install layout.',
  )
}

/**
 * Every module specifier an `import`/`export … from` statement names, in source order.
 *
 * **A DECLARATION THAT MERELY NAMES A SPECIFIER IS NOT ONE.** Anchoring at line start (already done)
 * stops a leading `//` from reaching this; it does nothing about `export const OK = true // import
 * '.../register'` or `export const DROPPED = ['.../register']`, both of which START with `export`
 * and still carry the quoted path — so DELETING a real import and leaving either shape behind kept
 * this scan reporting the grammar as still present. The identical regex lives in
 * `monacoLanguage.test.ts`'s `SPECIFIER`; the residual was shared, not introduced by either file.
 */
const SPECIFIER =
  /^\s*(?:import|export)\b(?!\s+(?:type|const|let|var|function|class|interface|enum|namespace)\b)[^\n]*?['"]([^'"\n]+)['"]/gm
function specifiersOf(src: string): string[] {
  return [...src.matchAll(SPECIFIER)].flatMap(m => (m[1] === undefined ? [] : [m[1]]))
}

/**
 * A specifier written inside `esm/vs/<fromDir>/` → the path under `esm/vs`, extension-less for `.js`
 * so it compares against `monacoEntry.ts`'s own extension-less subpaths. The barrel's one import
 * from OUTSIDE `esm/vs` (`../external/monaco-lsp-client/out/index.js`) keeps its tail, which is what
 * the named exclusion below matches on.
 */
function underVs(spec: string, fromDir: string): string {
  return normalize(join(fromDir, spec))
    .replace(/\\/g, '/')
    .replace(/^(?:\.\.\/)+/, '')
    .replace(/\.js$/, '')
}

/**
 * THE THREE NAMED EXCLUSIONS, and there may not be a fourth without a reason written here. Every
 * other difference between the barrel and `monacoEntry.ts` is a defect by construction.
 */
const EXCLUDED = [
  // The 6.9 MB. The whole point of the change.
  'languages/features/typescript/register',
  // Lives outside `esm/vs/`, so it is unreachable through the package's `exports` map.
  'external/monaco-lsp-client',
  // Transitively re-imported by `suggestWidget.js`, `codeActionMenu.js` and
  // `standaloneGotoSymbolQuickAccess.js`, all three of which ARE registered — so the stylesheet is
  // in the bundle either way and naming it again would be the only hand-copied line with no effect.
  'base/browser/ui/codicons/codicon/codicon-modifiers.css',
]
const excluded = (p: string) => EXCLUDED.some(e => p === e || p.startsWith(`${e}/`))

/** Comments are stripped before a source is searched — a doc comment may NAME what code may not do.
 *  The third copy of this rule; `lib/stripComments.ts` is the only one now. */
const code = stripComments

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('monacoEntry composes Monaco from subpaths', () => {
  const entry = readFileSync(ENTRY, 'utf8')
  const setup = readFileSync(SETUP, 'utf8')

  /** `esm/vs/index.js`'s own imports — the definition of "everything the barrel registers". */
  function barrelImports(vs: string): Set<string> {
    return new Set(specifiersOf(code(readFileSync(join(vs, 'index.js'), 'utf8'))).map(s => underVs(s, '.')))
  }

  /**
   * `monacoEntry.ts`'s imports, with `features/register.all` EXPANDED the same way the barrel's own
   * inlined copy of it is — the barrel lists those ~68 contributions one by one and we take them as
   * the package's roll-up, so without expanding there is no comparison to make.
   */
  function entryImports(vs: string): Set<string> {
    const out = new Set<string>()
    for (const spec of specifiersOf(code(entry))) {
      const p = spec.replace(/^monaco-editor\//, '')
      if (p !== 'features/register.all') {
        out.add(p)
        continue
      }
      const rollup = readFileSync(join(vs, 'features/register.all.js'), 'utf8')
      for (const r of specifiersOf(code(rollup))) out.add(underVs(r, 'features'))
    }
    return out
  }

  it('registers every Monarch grammar the installed monaco-editor ships', () => {
    const vs = monacoVsDir()
    const onDisk = readdirSync(join(vs, 'languages/definitions'), { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(vs, 'languages/definitions', d.name, 'register.js')))
      .map(d => d.name)
      .sort()
    // Over the CODE, not the source: this module's own header names two of these subpaths in prose.
    const imported = [...code(entry).matchAll(/languages\/definitions\/([^/]+)\/register/g)]
      .map(m => m[1])
      .sort()
    expect(onDisk.length).toBeGreaterThan(50) // a sanity floor: an empty read must not pass
    expect(imported).toEqual(onDisk)
  })

  /**
   * THE CONTRIBUTIONS — SET EQUALITY, IN BOTH DIRECTIONS.
   *
   * One direction catches a contribution the barrel gained and we lack (an upgrade's new feature,
   * silently absent here). The other catches one we name and the barrel no longer has (an import
   * left behind by an upgrade, which would fail to resolve at build time — but only once somebody
   * builds). Both messages carry the offending subpaths, so the fix is the diff.
   */
  it('imports EXACTLY what the barrel imports, minus the three named exclusions', () => {
    const vs = monacoVsDir()
    const barrel = barrelImports(vs)
    const ours = entryImports(vs)
    expect(barrel.size).toBeGreaterThan(140) // a sanity floor: an unparsed barrel must not pass
    for (const name of EXCLUDED) {
      expect([...barrel].some(p => p === name || p.startsWith(`${name}/`))).toBe(true)
    }
    const missing = [...barrel].filter(p => !excluded(p) && !ours.has(p)).sort()
    const extra = [...ours].filter(p => !barrel.has(p)).sort()
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it('still registers the grammars for the languages this app edits most', () => {
    for (const lang of ['typescript', 'javascript', 'css', 'html', 'markdown', 'yaml', 'python']) {
      expect(entry).toContain(`languages/definitions/${lang}/register`)
    }
  })

  /**
   * The language SERVICES, also set equality: a FOURTH one added upstream would go unregistered and
   * unbundled, and the only symptom would be `workerFor`'s throw the first time Monaco asked for its
   * worker — on whatever file happens to use that language.
   */
  it('keeps every language service the package ships except TypeScript', () => {
    const vs = monacoVsDir()
    const onDisk = readdirSync(join(vs, 'languages/features'), { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(vs, 'languages/features', d.name, 'register.js')))
      .map(d => d.name)
      .filter(n => n !== 'typescript')
      .sort()
    // Over the CODE: the header names `languages/features/typescript/register` twice in prose.
    const imported = [...code(entry).matchAll(/languages\/features\/([^/]+)\/register/g)]
      .map(m => m[1])
      .sort()
    expect(onDisk).toEqual(['css', 'html', 'json']) // the set monacoSetup.ts bundles a worker for
    expect(imported).toEqual(onDisk)
  })

  it('the specifier scan is not fooled by a declaration that only NAMES a register path', () => {
    const trailingComment = "export const OK = true // import 'monaco-editor/languages/features/typescript/register'"
    const arrayLiteral = "export const DROPPED = ['monaco-editor/languages/features/typescript/register']"
    expect(specifiersOf(trailingComment)).toEqual([])
    expect(specifiersOf(arrayLiteral)).toEqual([])
    // Still sees the real thing — the exact shape monacoEntry.ts writes for every grammar.
    expect(specifiersOf("import 'monaco-editor/languages/features/json/register'"))
      .toEqual(['monaco-editor/languages/features/json/register'])
  })

  it('never imports the TypeScript language service, in either file', () => {
    // The 6.9 MB. A comment may name it; an import may not.
    for (const [name, src] of [['monacoEntry.ts', entry], ['monacoSetup.ts', setup]] as const) {
      for (const spec of specifiersOf(code(src))) {
        expect(`${name}: ${spec}`).not.toContain('features/typescript')
        expect(`${name}: ${spec}`).not.toContain('ts.worker')
      }
    }
  })

  /**
   * A real (non-type) import would put the whole barrel — ts.worker included — back. This used to
   * check only `setup` and `entry`, so `RepoFileEditor.tsx` (which reaches for the same `Monaco`
   * type) was free to drop the word `type` from its own `import type * as Monaco from
   * 'monaco-editor'` with a green build and a green suite — restoring the 6.9 MB silently, the
   * exact class of rot this file exists to close. Every file under `packages/web/src` is walked now,
   * not only the two the composition itself lives in.
   */
  const VALUE_BARREL_IMPORT = /^\s*(?:import|export)\b(?!\s+type\b)[^\n]*?['"]monaco-editor['"]/m

  it('never imports the monaco-editor barrel for a VALUE, anywhere under packages/web/src', () => {
    for (const file of walk(SRC)) {
      const src = code(readFileSync(file, 'utf8'))
      expect(
        VALUE_BARREL_IMPORT.test(src),
        `${relative(SRC, file)} imports the monaco-editor barrel as a VALUE`,
      ).toBe(false)
    }
  })

  it('the barrel-VALUE scan still tells a type-only import from a real one', () => {
    const hit = (s: string) => VALUE_BARREL_IMPORT.test(code(s))
    expect(hit("import type * as Monaco from 'monaco-editor'")).toBe(false)
    expect(hit("import type Monaco from 'monaco-editor'")).toBe(false)
    expect(hit("import * as Monaco from 'monaco-editor'")).toBe(true)
    expect(hit("import Monaco from 'monaco-editor'")).toBe(true)
    expect(hit("import 'monaco-editor'")).toBe(true)
    expect(hit("// import * as Monaco from 'monaco-editor'")).toBe(false)
    // A subpath is not the barrel itself.
    expect(hit("import EditorWorker from 'monaco-editor/editor/editor.worker?worker'")).toBe(false)
  })

  /**
   * `armWorkers()` must EXTEND `MonacoEnvironment`, not replace it. A spread builds a new object, so
   * a CSP-hardened host that keeps a reference to its own and sets `createTrustedTypesPolicy` on it
   * AFTER us writes into a bag monaco no longer reads — the same divergence the merge was written to
   * prevent, one step later. Asserted over the source because nothing else would notice: both shapes
   * pass every other test and both work on a host that sets nothing.
   */
  it('arms the workers INTO the existing MonacoEnvironment, never onto a new object', () => {
    const body = code(setup).match(/function armWorkers\(\)[\s\S]*?\n}/)?.[0] ?? ''
    expect(body).toContain('Object.assign')
    expect(body).toMatch(/MonacoEnvironment \?\?=/)
    expect(body).not.toMatch(/\.\.\.\s*host\.MonacoEnvironment/)
    expect(body).not.toMatch(/host\.MonacoEnvironment\s*=\s*\{/)
  })

  it('bundles a worker for every language service it registers, and no others', () => {
    const workers = [...setup.matchAll(/from 'monaco-editor\/([^']+)\?worker'/g)].map(m => m[1])
    expect(workers.sort()).toEqual([
      'editor/editor.worker',
      'languages/features/css/css.worker',
      'languages/features/html/html.worker',
      'languages/features/json/json.worker',
    ])
  })
})

/**
 * **NOTHING MAY READ `monaco.typescript` OR `monaco.lsp`.** `loadMonaco()` resolves `monacoEntry`,
 * which has neither member — the language service is not registered and `lsp` is unreachable through
 * the package's `exports` map. The type now says so, which makes such a read a compile error; this
 * is the second lock, because the type is one `as` away from being silenced and the failure shape is
 * the worst one this product has: `monaco.typescript.typescriptDefaults…` type-checks, then throws
 * inside the `.then()` — an unhandled rejection and an editor that silently never mounts.
 */
describe('no reader of the Monaco module reaches for a member it does not have', () => {
  it('finds no `.typescript` / `.lsp` member access anywhere under packages/web/src', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file === SELF) continue // this file names the members it bans, in its own assertions
      const src = code(readFileSync(file, 'utf8'))
      for (const line of src.split('\n')) {
        if (/[\w$)\]?]\s*\.\s*(?:typescript|lsp)\b/.test(line)) {
          offenders.push(`${relative(SRC, file)}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the scan still sees a read that a comment does not hide', () => {
    // The test of the test: the guard above is only worth having if it still sees code.
    const hit = (s: string) => /[\w$)\]?]\s*\.\s*(?:typescript|lsp)\b/.test(code(s))
    expect(hit('void monaco.typescript.typescriptDefaults')).toBe(true)
    expect(hit('void monaco?.lsp')).toBe(true)
    expect(hit('/* monaco.typescript is not there */')).toBe(false)
    expect(hit("import 'monaco-editor/languages/definitions/typescript/register'")).toBe(false)
  })

  it('the source tree it walks is the real one', () => {
    // An empty or mis-rooted walk would make the scan above pass by reading nothing.
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(join(SRC, 'components/sessions/RepoFileEditor.tsx'))
    expect(statSync(SRC).isDirectory()).toBe(true)
  })
})
